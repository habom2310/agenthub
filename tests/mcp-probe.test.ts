import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmdEscapeArg, cmdLine, probeMcpServer, probeMcpServers, redact, resolveServerVars, secretsOf } from '../src/core/mcp-probe.js';

const server = path.resolve(__dirname, 'fixtures', 'mcp-stdio-server.cjs');
const stdio = (mode: string, tools = 2) => ({ command: process.execPath, args: [server, mode, String(tools)] });

describe('resolveServerVars', () => {
  it('expands ${VAR}, ${env:VAR} and ${userHome}, and lists the unset ones', () => {
    const { config, unresolved } = resolveServerVars(
      { command: 'x', args: ['${A}', '${env:B}'], env: { K: '${MISSING}' }, headers: { Authorization: 'Bearer ${TOKEN}' } },
      { A: 'a', B: 'b' },
      '/home/u'
    );
    expect(config.args).toEqual(['a', 'b']);
    expect(unresolved).toEqual(['${MISSING} in env.K', '${TOKEN} in headers.Authorization']);
    expect(resolveServerVars({ command: '${userHome}/bin' }, {}, '/home/u').config.command).toBe('/home/u/bin');
  });
});

describe('probeMcpServer stdio', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-probe-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('passes with the tool count of a working server, ignoring stdout noise', async () => {
    const res = await probeMcpServer('ok', stdio('ok', 3), { timeoutMs: 10000 });
    expect(res).toMatchObject({ status: 'PASS', tools: 3, message: '3 tools' });
  });

  it('reports the exit code and last stderr lines of a server that dies', async () => {
    const res = await probeMcpServer('bad', stdio('exit'), { timeoutMs: 10000 });
    expect(res.status).toBe('FAIL');
    expect(res.message).toContain('exited with code 3');
    expect(res.message).toContain('boom: cannot start');
  });

  it('reports a missing command', async () => {
    const res = await probeMcpServer('gone', { command: 'agenthub-no-such-command-xyz' }, { timeoutMs: 10000 });
    expect(res).toMatchObject({ status: 'FAIL' });
    expect(res.message).toContain('command not found: agenthub-no-such-command-xyz');
  });

  it('reports a JSON-RPC error as a protocol error', async () => {
    const res = await probeMcpServer('err', stdio('error'), { timeoutMs: 10000 });
    expect(res).toMatchObject({ status: 'FAIL', message: 'protocol error: init refused' });
  });

  it('times out a hanging server and kills it', async () => {
    const pidFile = path.join(tmp, 'pid');
    const res = await probeMcpServer('hang', { ...stdio('hang'), env: { PIDFILE: pidFile } }, { timeoutMs: 800 });
    expect(res.status).toBe('FAIL');
    expect(res.message).toMatch(/timed out after 1s while waiting for the initialize response/);
    const pid = Number(fs.readFileSync(pidFile, 'utf-8'));
    await new Promise((r) => setTimeout(r, 1500));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('fails before spawning when an env value has an unresolved variable', async () => {
    const res = await probeMcpServer('v', { ...stdio('ok'), env: { API_KEY: '${AGENTHUB_TEST_UNSET_KEY}' } }, { env: {}, timeoutMs: 5000 });
    expect(res.status).toBe('WARN');
    expect(res.message).toContain('unresolved variable(s): ${AGENTHUB_TEST_UNSET_KEY} in env.API_KEY');
  });

  it('terminates the process group, grandchildren included', async () => {
    if (process.platform === 'win32') return;
    const pidFile = path.join(tmp, 'child-pid');
    const script = path.join(tmp, 'parent.cjs');
    fs.writeFileSync(
      script,
      `const { spawn } = require('node:child_process');
const c = spawn(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(()=>{},1000)', ${JSON.stringify(pidFile)}], { stdio: 'ignore' });
setInterval(()=>{},1000);`
    );
    const res = await probeMcpServer('tree', { command: process.execPath, args: [script] }, { timeoutMs: 1500 });
    expect(res.status).toBe('FAIL');
    const grandchild = Number(fs.readFileSync(pidFile, 'utf-8'));
    await new Promise((r) => setTimeout(r, 1500));
    expect(() => process.kill(grandchild, 0)).toThrow();
  });

  it('probes several servers concurrently and keeps the input order', async () => {
    const results = await probeMcpServers({ a: stdio('ok', 1), b: stdio('exit'), c: stdio('ok', 4) }, { timeoutMs: 10000, concurrency: 2 });
    expect(results.map((r) => [r.name, r.status])).toEqual([['a', 'PASS'], ['b', 'FAIL'], ['c', 'PASS']]);
    expect(results[2].tools).toBe(4);
  });
});

describe('probeMcpServer http', () => {
  let srv: http.Server;
  let url: string;
  const seen: Array<{ method?: string; headers: http.IncomingHttpHeaders; body: any }> = [];
  let sse = false;
  let status = 200;

  beforeEach(async () => {
    seen.length = 0;
    sse = false;
    status = 200;
    srv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : undefined;
        seen.push({ method: req.method, headers: req.headers, body });
        if (status !== 200) {
          res.writeHead(status).end('nope');
          return;
        }
        if (req.method === 'DELETE' || !body) return void res.writeHead(200).end();
        if (body.id === undefined) return void res.writeHead(202).end();
        const reply =
          body.method === 'initialize'
            ? { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'h', version: '1' } }
            : { tools: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] };
        const msg = { jsonrpc: '2.0', id: body.id, result: reply };
        const headers: Record<string, string> = { 'mcp-session-id': 'sess-1' };
        if (sse) {
          res.writeHead(200, { ...headers, 'content-type': 'text/event-stream' });
          res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`); // stream stays open
        } else {
          res.writeHead(200, { ...headers, 'content-type': 'application/json' }).end(JSON.stringify(msg));
        }
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(srv.address() as any).port}/mcp`;
  });
  afterEach(async () => {
    srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
  });

  it('handles a JSON response, carries the session header and custom headers', async () => {
    const res = await probeMcpServer('h', { url, headers: { Authorization: 'Bearer t' } }, { timeoutMs: 5000 });
    expect(res).toMatchObject({ status: 'PASS', tools: 3 });
    const posts = seen.filter((s) => s.method === 'POST');
    expect(posts.map((p) => p.body.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
    expect(posts[0].headers.authorization).toBe('Bearer t');
    expect(posts[2].headers['mcp-session-id']).toBe('sess-1');
    expect(posts[0].body.params.clientInfo.name).toBe('agenthub');
  });

  it('handles an SSE response that stays open', async () => {
    sse = true;
    const res = await probeMcpServer('h', { url }, { timeoutMs: 5000 });
    expect(res).toMatchObject({ status: 'PASS', tools: 3 });
  });

  it('reports an HTTP error status, a refused connection and a skipped sse transport', async () => {
    status = 401;
    const unauthorized = await probeMcpServer('h', { url }, { timeoutMs: 5000 });
    expect(unauthorized.status).toBe('WARN');
    expect(unauthorized.message).toContain('HTTP 401: needs auth');

    srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
    const refused = await probeMcpServer('h', { url }, { timeoutMs: 5000 });
    expect(refused.status).toBe('FAIL');
    expect(refused.message).toContain('connection refused');

    expect(await probeMcpServer('h', { url, type: 'sse' }, {})).toMatchObject({ status: 'SKIP' });
    srv = http.createServer(); // so afterEach can close
  });
});

describe('secrets in probe output', () => {
  it('masks env values, header values and url credentials, including in stderr and errors', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-redact-'));
    const script = path.join(dir, 'leak.cjs');
    fs.writeFileSync(script, 'console.error("token=" + process.env.API_KEY + " pw hunter2secret"); process.exit(2);');
    const res = await probeMcpServer('leak', { command: process.execPath, args: [script], env: { API_KEY: 'sk-live-12345', OTHER: 'hunter2secret' } }, { timeoutMs: 8000 });
    expect(res.status).toBe('FAIL');
    expect(res.message).toContain('token=***');
    expect(res.message).not.toContain('sk-live-12345');
    expect(res.message).not.toContain('hunter2secret');
    fs.rmSync(dir, { recursive: true, force: true });

    const refused = await probeMcpServer('http', { url: 'http://user:pa55word@127.0.0.1:1/mcp?key=querysecret', headers: { Authorization: 'Bearer tok3n-value' } }, { timeoutMs: 5000 });
    expect(refused.status).toBe('FAIL');
    for (const secret of ['pa55word', 'querysecret', 'tok3n-value']) expect(JSON.stringify(refused)).not.toContain(secret);
  });

  it('redact and secretsOf cover Bearer tokens and ignore very short values', () => {
    const secrets = secretsOf({ url: 'https://u:p4ss@h/x?k=v4lue', headers: { A: 'Bearer abcdef' }, env: { N: '1' } });
    expect(secrets).toEqual(expect.arrayContaining(['Bearer abcdef', 'abcdef', 'p4ss', 'v4lue']));
    expect(secrets).not.toContain('1');
    expect(redact('x Bearer abcdef y p4ss', secrets)).toBe('x *** y ***');
  });
});

describe('probe robustness', () => {
  it('fails a server that floods stdout without a complete message', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-flood-'));
    const script = path.join(dir, 'flood.cjs');
    fs.writeFileSync(script, 'const chunk = "x".repeat(65536); setInterval(() => process.stdout.write(chunk), 1);');
    const res = await probeMcpServer('flood', { command: process.execPath, args: [script] }, { timeoutMs: 15000 });
    expect(res.status).toBe('FAIL');
    expect(res.message).toContain('output too large');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('uses the home that agenthub works on for HOME', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-homeenv-'));
    const { setCustomHome } = await import('../src/core/detector.js');
    setCustomHome(dir, null);
    try {
      const out = path.join(dir, 'home.txt');
      await probeMcpServer('h', { command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(out)}, process.env.HOME)`] }, { timeoutMs: 8000 });
      expect(fs.readFileSync(out, 'utf-8')).toBe(dir);
    } finally {
      setCustomHome(null, null);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Windows cmd.exe quoting', () => {
  it('quotes arguments and caret-escapes cmd metacharacters like cross-spawn', () => {
    expect(cmdEscapeArg('plain', false)).toBe('^"plain^"');
    expect(cmdEscapeArg('a b', false)).toBe('^"a^ b^"');
    expect(cmdEscapeArg('say "hi"', false)).toBe('^"say^ \\^"hi\\^"^"');
    expect(cmdEscapeArg('a&b|c', false)).toBe('^"a^&b^|c^"');
    expect(cmdEscapeArg('C:\\dir\\', false)).toBe('^"C:\\dir\\\\^"');
  });

  it('escapes twice for .cmd shims, which cmd expands a second time', () => {
    expect(cmdEscapeArg('%PATH%', true)).toBe('^^^"^^^%PATH^^^%^^^"');
    expect(cmdEscapeArg('a b', true)).toBe('^^^"a^^^ b^^^"');
  });

  it('builds the /s /c command line with the command path escaped and no bare metacharacter', () => {
    const line = cmdLine('C:\\Program Files\\n\\npx.cmd', ['-y', 'pkg&calc'], true);
    expect(line).toBe('"C:\\Program^ Files\\n\\npx.cmd ^^^"-y^^^" ^^^"pkg^^^&calc^^^""');
  });
});
