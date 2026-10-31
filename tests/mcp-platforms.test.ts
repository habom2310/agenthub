import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MCP_PLATFORMS, spliceCodexServers } from '../src/core/mcp-platforms.js';
import { getMcpStatus, syncMcpServers } from '../src/core/mcp-sync.js';
import { ensureDir, safeWriteFile } from '../src/utils/fs.js';

const read = (p: string) => fs.readFileSync(p, 'utf-8');
const readJson = (p: string) => JSON.parse(read(p));

describe('MCP platform adapters', () => {
  let tmp: string;
  let home: string;
  let hub: string;
  const file = {
    codex: () => path.join(home, '.codex', 'config.toml'),
    cursor: () => path.join(home, '.cursor', 'mcp.json'),
    windsurf: () => path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
    copilot: () => path.join(home, '.copilot', 'mcp-config.json'),
  };
  const hubFile = () => path.join(hub, 'mcp', 'servers.json');
  const writeHub = (servers: Record<string, unknown>) => safeWriteFile(hubFile(), JSON.stringify({ mcpServers: servers }, null, 2));

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-platforms-'));
    home = path.join(tmp, 'home');
    hub = path.join(tmp, 'hub');
    for (const d of ['.codex', '.cursor', path.join('.codeium', 'windsurf'), '.copilot']) ensureDir(path.join(home, d));
    ensureDir(hub);
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const stdio = { command: 'node', args: ['${HUB}/mcp/servers/x/index.js'], env: { TOKEN: 'abc' } };
  const remote = { url: 'https://example.com/mcp', headers: { 'X-Key': 'k' } };

  describe('toNative / fromNative', () => {
    it('Codex: command/args/env tables and url + http_headers, nothing it does not document', () => {
      const p = MCP_PLATFORMS.codex;
      expect(p.toNative({ ...stdio, type: 'stdio', timeout: 5 })).toEqual({ command: 'node', args: stdio.args, env: stdio.env });
      expect(p.toNative({ ...remote, type: 'http' })).toEqual({ url: remote.url, http_headers: remote.headers });
      expect(p.fromNative({ url: remote.url, http_headers: remote.headers, enabled_tools: ['a'] })).toEqual(remote);
    });

    it('Cursor: no type key', () => {
      const expanded = { ...stdio, args: ['/abs/index.js'] }; // sync expands ${HUB} and ${HOME} before adapting
      expect(MCP_PLATFORMS.cursor.toNative({ ...expanded, type: 'stdio' })).toEqual(expanded);
      expect(MCP_PLATFORMS.cursor.toNative({ ...remote, type: 'http' })).toEqual(remote);
    });

    it('Windsurf: remote servers use serverUrl, and url is also accepted on ingest', () => {
      const p = MCP_PLATFORMS.windsurf;
      expect(p.toNative({ ...remote, type: 'http' })).toEqual({ serverUrl: remote.url, headers: remote.headers });
      expect(p.fromNative({ serverUrl: remote.url })).toEqual({ url: remote.url });
      expect(p.fromNative({ url: remote.url })).toEqual({ url: remote.url });
    });

    it('Copilot: type local or http and tools, keeping an existing tools filter', () => {
      const p = MCP_PLATFORMS.copilot;
      expect(p.toNative(stdio)).toEqual({ ...stdio, type: 'local', tools: ['*'] });
      expect(p.toNative(remote)).toEqual({ ...remote, type: 'http', tools: ['*'] });
      expect(p.toNative(stdio, { tools: ['a'] }).tools).toEqual(['a']);
      expect(p.fromNative({ type: 'local', ...stdio, tools: ['*'] })).toEqual(stdio);
    });
  });

  describe('sync round trip', () => {
    it('projects hub servers with paths expanded into every detected platform', () => {
      writeHub({ srv: stdio, rem: remote });
      const res = syncMcpServers(home, hub);
      expect(res.success).toBe(true);

      const expanded = { command: 'node', args: [path.join(hub, 'mcp/servers/x/index.js')], env: { TOKEN: 'abc' } };
      expect(readJson(file.cursor()).mcpServers).toEqual({ srv: expanded, rem: remote });
      expect(readJson(file.windsurf()).mcpServers).toEqual({ srv: expanded, rem: { serverUrl: remote.url, headers: remote.headers } });
      expect(readJson(file.copilot()).mcpServers).toEqual({
        srv: { ...expanded, type: 'local', tools: ['*'] },
        rem: { ...remote, type: 'http', tools: ['*'] },
      });
      expect(parseToml(read(file.codex())).mcp_servers).toEqual({
        srv: expanded,
        rem: { url: remote.url, http_headers: remote.headers },
      });

      expect(getMcpStatus(home, hub).in_sync).toBe(true);
      expect(syncMcpServers(home, hub).actions).toEqual(['All MCP configurations are already synchronized.']);
    });

    it('skips platforms that are not detected and creates no file for an empty hub', () => {
      fs.rmSync(path.join(home, '.cursor'), { recursive: true });
      writeHub({ srv: { command: 'node' } });
      syncMcpServers(home, hub);
      expect(fs.existsSync(file.cursor())).toBe(false);
      expect(getMcpStatus(home, hub).platforms.cursor.installed).toBe(false);

      for (const f of [file.windsurf(), file.codex(), file.copilot()]) fs.rmSync(f);
      writeHub({});
      syncMcpServers(home, hub);
      expect(fs.existsSync(file.windsurf())).toBe(false);
    });
  });

  describe('drift and untracked', () => {
    it('reports missing, drifted and untracked servers per platform', () => {
      writeHub({ a: { command: 'node', args: ['a.js'] }, b: { command: 'node', args: ['b.js'] } });
      safeWriteFile(file.cursor(), JSON.stringify({ mcpServers: { a: { command: 'node', args: ['changed.js'] }, extra: { command: 'x' } } }));
      const st = getMcpStatus(home, hub);
      expect(st.platforms.cursor).toMatchObject({ missing: ['b'], drifted: ['a'], untracked: ['extra'], valid: true });
      expect(st.in_sync).toBe(false);
    });

    it('does not count platform-only keys or a missing type as drift', () => {
      writeHub({ a: { command: 'node', args: ['a.js'], type: 'stdio' } });
      safeWriteFile(file.cursor(), JSON.stringify({ mcpServers: { a: { command: 'node', args: ['a.js'], envFile: '.env' } } }));
      safeWriteFile(file.copilot(), JSON.stringify({ mcpServers: { a: { type: 'local', command: 'node', args: ['a.js'], tools: ['read'] } } }));
      safeWriteFile(file.codex(), '[mcp_servers.a]\ncommand = "node"\nargs = ["a.js"]\nenabled_tools = ["x"]\n');
      const st = getMcpStatus(home, hub);
      expect(st.platforms.cursor.drifted).toEqual([]);
      expect(st.platforms.copilot.drifted).toEqual([]);
      expect(st.platforms.codex.drifted).toEqual([]);
    });
  });

  describe('ingest', () => {
    it('adds untracked servers to the hub with paths contracted, mapping platform keys back', () => {
      safeWriteFile(file.cursor(), JSON.stringify({ mcpServers: { cur: { command: path.join(home, 'bin', 'cur') } } }));
      safeWriteFile(file.windsurf(), JSON.stringify({ mcpServers: { ws: { serverUrl: 'https://ws.example/mcp' } } }));
      safeWriteFile(file.copilot(), JSON.stringify({ mcpServers: { cop: { type: 'local', command: 'cop', tools: ['*'] } } }));
      safeWriteFile(
        file.codex(),
        '[mcp_servers.cdx]\nurl = "https://cdx.example/mcp"\n[mcp_servers.cdx.http_headers]\nX-A = "1"\n[mcp_servers.off]\ncommand = "off"\nenabled = false\n'
      );
      const res = syncMcpServers(home, hub);
      expect(res.actions).toContain('Ingested server "cur" from Cursor into hub');
      expect(res.actions).toContain('Ingested server "cdx" from Codex into hub');
      expect(res.actions.some((a) => a.includes('disabled server "off"'))).toBe(true);

      const servers = readJson(hubFile()).mcpServers;
      expect(servers.cur).toEqual({ command: '${HOME}/bin/cur' });
      expect(servers.ws).toEqual({ url: 'https://ws.example/mcp' });
      expect(servers.cop).toEqual({ command: 'cop' });
      expect(servers.cdx).toEqual({ url: 'https://cdx.example/mcp', headers: { 'X-A': '1' } });
      expect(servers.off).toBeUndefined();
      // and the other platforms now have them
      expect(readJson(file.cursor()).mcpServers.cdx).toEqual({ url: 'https://cdx.example/mcp', headers: { 'X-A': '1' } });
    });
  });

  describe('corrupt files', () => {
    it('refuses to overwrite a corrupt JSON config and a corrupt config.toml, and reports them', () => {
      writeHub({ a: { command: 'node' } });
      safeWriteFile(file.cursor(), '{ not json');
      safeWriteFile(file.codex(), '[mcp_servers.a\nbroken');
      const res = syncMcpServers(home, hub);
      expect(res.actions.some((a) => a.startsWith('[SKIP] Refusing to overwrite mcp.json'))).toBe(true);
      expect(res.actions.some((a) => a.startsWith('[SKIP] Refusing to overwrite config.toml'))).toBe(true);
      expect(read(file.cursor())).toBe('{ not json');
      expect(read(file.codex())).toBe('[mcp_servers.a\nbroken');
      expect(getMcpStatus(home, hub).platforms.codex.valid).toBe(false);
      expect(getMcpStatus(home, hub).in_sync).toBe(false);
    });
  });

  describe('config.toml preservation', () => {
    const original = `# my codex settings
model = "gpt-5"   # keep me
approval_policy = "never"

[profiles.fast]
model = "mini"

# the docs server, hand written
[mcp_servers.docs]
command = "npx"
args = ["-y", "docs-mcp"]
enabled_tools = ["search"]   # only this

[mcp_servers.docs.oauth]
client_id = "abc"

[mcp_servers.keep]
command = "keep"

[projects."/Users/me/work"]
trust_level = "trusted"
`;

    it('keeps every other table and comment, and platform-only keys of a changed server', () => {
      safeWriteFile(file.codex(), original);
      writeHub({ docs: { command: 'npx', args: ['-y', 'docs-mcp@2'] }, keep: { command: 'keep' }, fresh: { command: 'fresh', env: { A: '1' } } });
      syncMcpServers({ homeDir: home, hubDir: hub, force: true });

      const out = read(file.codex());
      for (const kept of ['# my codex settings', 'model = "gpt-5"   # keep me', '[profiles.fast]', '# the docs server, hand written', '[mcp_servers.keep]\ncommand = "keep"', '[projects."/Users/me/work"]', 'trust_level = "trusted"']) {
        expect(out).toContain(kept);
      }
      const parsed: any = parseToml(out);
      expect(parsed.mcp_servers.docs).toEqual({
        command: 'npx',
        args: ['-y', 'docs-mcp@2'],
        enabled_tools: ['search'],
        oauth: { client_id: 'abc' },
      });
      expect(parsed.mcp_servers.fresh).toEqual({ command: 'fresh', env: { A: '1' } });
      expect(parsed.model).toBe('gpt-5');
      expect(parsed.profiles.fast.model).toBe('mini');
    });

    it('does not touch the file when nothing changed', () => {
      safeWriteFile(file.codex(), original);
      writeHub({ docs: { command: 'npx', args: ['-y', 'docs-mcp'] }, keep: { command: 'keep' } });
      syncMcpServers(home, hub);
      expect(read(file.codex())).toBe(original);
    });

    it('spliceCodexServers removes a server and refuses inline-table definitions it cannot edit', () => {
      const removed = spliceCodexServers(original, { keep: null });
      expect(removed).not.toContain('[mcp_servers.keep]');
      expect(removed).toContain('[mcp_servers.docs]');
      expect(spliceCodexServers('mcp_servers = { a = { command = "x" } }\n', { a: { command: 'y' } })).toBeNull();
    });

    it('handles headers whose quoted keys contain ], neither mistaking nor losing them', () => {
      const text = `[projects."/a]b/c"]
trust_level = "trusted"

[mcp_servers."we]ird"]
command = "old"

[mcp_servers.plain]
command = "plain"
`;
      const out = spliceCodexServers(text, { 'we]ird': { command: 'new' }, plain: null }) as string;
      expect(out).not.toBeNull();
      expect(out).toContain('[projects."/a]b/c"]\ntrust_level = "trusted"');
      const parsed: any = parseToml(out);
      expect(parsed.mcp_servers).toEqual({ 'we]ird': { command: 'new' } });
      expect(parsed.projects['/a]b/c'].trust_level).toBe('trusted');
    });

    it('creates config.toml when the platform is detected but has none', () => {
      writeHub({ a: { command: 'node' } });
      syncMcpServers(home, hub);
      expect(read(file.codex())).toBe('[mcp_servers.a]\ncommand = "node"\n');
    });
  });

  describe('conflicts, disabled servers, BOM', () => {
    it('leaves a same-name entry the hub never wrote alone, reports it, and overwrites with force', () => {
      writeHub({ docs: { command: 'hub-docs' } });
      safeWriteFile(file.cursor(), JSON.stringify({ mcpServers: { docs: { command: 'mine', type: 'stdio' } } }));
      const st = getMcpStatus(home, hub);
      expect(st.platforms.cursor).toMatchObject({ drifted: ['docs'], conflicted: ['docs'] });

      const res = syncMcpServers(home, hub);
      expect(res.actions.some((a) => a.startsWith('[CONFLICT] Cursor has its own "docs"'))).toBe(true);
      expect(readJson(file.cursor()).mcpServers.docs).toEqual({ command: 'mine', type: 'stdio' });
      expect(readJson(file.windsurf()).mcpServers.docs).toEqual({ command: 'hub-docs' }); // no conflict elsewhere

      syncMcpServers({ homeDir: home, hubDir: hub, force: true });
      // forced: the hub command wins, and a user-set type stays because Cursor does not own it
      expect(readJson(file.cursor()).mcpServers.docs).toEqual({ command: 'hub-docs', type: 'stdio' });
      expect(getMcpStatus(home, hub).platforms.cursor.conflicted).toEqual([]);
    });

    it('a server the hub wrote and the user later edited is plain drift, overwritten by sync', () => {
      writeHub({ a: { command: 'a' } });
      syncMcpServers(home, hub);
      const cfg = readJson(file.cursor());
      cfg.mcpServers.a.command = 'edited';
      safeWriteFile(file.cursor(), JSON.stringify(cfg));
      expect(getMcpStatus(home, hub).platforms.cursor).toMatchObject({ drifted: ['a'], conflicted: [] });
      syncMcpServers(home, hub);
      expect(readJson(file.cursor()).mcpServers.a.command).toBe('a');
    });

    it('a server disabled on a platform is not untracked, so the registry stays in sync', () => {
      writeHub({});
      safeWriteFile(file.codex(), '[mcp_servers.off]\ncommand = "off"\nenabled = false\n');
      safeWriteFile(file.copilot(), JSON.stringify({ mcpServers: { off2: { command: 'x', disabled: true } } }));
      syncMcpServers(home, hub);
      const st = getMcpStatus(home, hub);
      expect(st.platforms.codex.untracked).toEqual([]);
      expect(st.platforms.copilot.untracked).toEqual([]);
      expect(st.in_sync).toBe(true);
    });

    it('keeps a leading BOM of config.toml and refuses to touch anything else in it', () => {
      const original = '\ufeff# top\nmodel = "x"\n';
      safeWriteFile(file.codex(), original);
      writeHub({ a: { command: 'a' } });
      syncMcpServers(home, hub);
      const out = read(file.codex());
      expect(out.charCodeAt(0)).toBe(0xfeff);
      expect(out).toContain('# top\nmodel = "x"\n');
      expect(out).toContain('[mcp_servers.a]');
      expect(spliceCodexServers('a = 1\n[mcp_servers.x]\ncommand = "x"\n', { x: { command: 'y' } })).toContain('a = 1\n');
    });
  });

  describe('${VAR} portability', () => {
    it('Cursor gets ${env:VAR} and ingest turns it back; Claude and Gemini take ${VAR} as is', () => {
      const cfg = { command: 'node', args: ['--k', '${API_KEY}'], env: { T: '${TOKEN}' }, headers: { A: 'Bearer ${TOKEN}' } };
      const cursor = MCP_PLATFORMS.cursor;
      expect(cursor.toNative(cfg)).toEqual({ command: 'node', args: ['--k', '${env:API_KEY}'], env: { T: '${env:TOKEN}' }, headers: { A: 'Bearer ${env:TOKEN}' } });
      expect(cursor.fromNative(cursor.toNative(cfg))).toEqual(cfg);
      expect(MCP_PLATFORMS.claude.toNative(cfg).args).toEqual(['--k', '${API_KEY}']);

      writeHub({ srv: cfg });
      syncMcpServers(home, hub);
      expect(readJson(file.cursor()).mcpServers.srv.args).toEqual(['--k', '${env:API_KEY}']);
      expect(readJson(file.windsurf()).mcpServers.srv.args).toEqual(['--k', '${API_KEY}']);
      expect(getMcpStatus(home, hub).platforms.cursor.drifted).toEqual([]);
    });
  });
});
