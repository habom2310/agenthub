import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { homeEnv } from './detector.js';
import { findExecutable } from '../utils/fs.js';
import type { McpServerConfig } from './mcp-sync.js';

/** Latest MCP protocol revision this probe speaks; servers may answer with an older one. */
export const MCP_PROTOCOL_VERSION = '2025-11-25';

export interface ProbeOptions {
  timeoutMs?: number;
  clientVersion?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ProbeResult {
  name: string;
  status: 'PASS' | 'WARN' | 'FAIL' | 'SKIP';
  message: string;
  tools?: number;
  ms: number;
}

type Json = Record<string, any>;

/** A problem the user can fix without the server being broken, such as missing credentials. */
class ProbeWarning extends Error {}

const MAX_OUTPUT = 4 * 1024 * 1024;

// ---- redaction: env values, header values and url credentials never reach the output ----

export function secretsOf(cfg: McpServerConfig): string[] {
  const out = new Set<string>();
  const add = (v: unknown): void => {
    if (typeof v !== 'string') return;
    if (v.length >= 3) out.add(v);
    for (const part of v.split(/\s+/)) if (part.length >= 3) out.add(part); // "Bearer <token>"
  };
  for (const v of Object.values(cfg.env ?? {})) add(v);
  for (const v of Object.values(cfg.headers ?? {})) add(v);
  if (typeof cfg.url === 'string') {
    try {
      const u = new URL(cfg.url);
      add(decodeURIComponent(u.username));
      add(decodeURIComponent(u.password));
      add(u.username);
      add(u.password);
      for (const v of u.searchParams.values()) add(v);
    } catch {
      // not a parseable url
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join('***');
  return out;
}

// ---- Windows: resolve with PATHEXT, spawn .exe directly, wrap .cmd/.bat in cmd.exe like cross-spawn ----

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** One argument for cmd.exe /d /s /c; `double` for .cmd shims, which expand it a second time. */
export function cmdEscapeArg(arg: string, double: boolean): string {
  let a = `${arg}`;
  a = a.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  a = a.replace(/(?=(\\+?)?)\1$/, '$1$1');
  a = `"${a}"`;
  a = a.replace(CMD_META, '^$1');
  if (double) a = a.replace(CMD_META, '^$1');
  return a;
}

export function cmdLine(command: string, args: string[], double: boolean): string {
  const cmd = path.normalize(command).replace(CMD_META, '^$1');
  return `"${[cmd, ...args.map((a) => cmdEscapeArg(a, double))].join(' ')}"`;
}

function spawnPlan(command: string, args: string[], env: NodeJS.ProcessEnv): { file: string; args: string[]; verbatim: boolean } | null {
  if (process.platform !== 'win32') return { file: command, args, verbatim: false };
  const saved = process.env.PATH;
  process.env.PATH = env.PATH ?? env.Path ?? saved;
  const found = findExecutable(command);
  process.env.PATH = saved;
  if (!found) return null;
  if (/\.(cmd|bat)$/i.test(found)) {
    return { file: env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', cmdLine(found, args, true)], verbatim: true };
  }
  return { file: found, args, verbatim: false };
}

// ---- children are stopped when agenthub is interrupted ----

const live = new Set<ChildProcess>();
let signalsHooked = false;

function onSignal(signal: NodeJS.Signals): void {
  for (const c of live) killTree(c);
  unhook();
  process.kill(process.pid, signal);
}
const onInt = (): void => onSignal('SIGINT');
const onTerm = (): void => onSignal('SIGTERM');

function hook(): void {
  if (signalsHooked) return;
  signalsHooked = true;
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
}

function unhook(): void {
  if (!signalsHooked) return;
  signalsHooked = false;
  process.off('SIGINT', onInt);
  process.off('SIGTERM', onTerm);
}

/**
 * Resolves ${NAME}, ${env:NAME} and ${userHome} in every string of a server.
 * Returns the names that have no value instead of running with a blank.
 */
export function resolveServerVars(
  cfg: McpServerConfig,
  env: NodeJS.ProcessEnv,
  home: string
): { config: McpServerConfig; unresolved: string[] } {
  const unresolved: string[] = [];
  const walk = (v: unknown, where: string): unknown => {
    if (typeof v === 'string') {
      return v.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name) => {
        if (name === 'userHome') return home;
        if (env[name] === undefined) {
          unresolved.push(`\${${name}} in ${where}`);
          return m;
        }
        return env[name] as string;
      });
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${where}[${i}]`));
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, where ? `${where}.${k}` : k)]));
    }
    return v;
  };
  const config = walk(cfg, '') as McpServerConfig;
  return { config, unresolved: [...new Set(unresolved)] };
}

function lastLines(text: string, n = 3): string {
  return text.trim().split(/\r?\n/).filter(Boolean).slice(-n).join(' | ');
}

const rpc = (id: number, method: string, params?: Json): Json => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
const note = (method: string): Json => ({ jsonrpc: '2.0', method });

const initParams = (version: string): Json => ({
  protocolVersion: MCP_PROTOCOL_VERSION,
  capabilities: {},
  clientInfo: { name: 'agenthub', version },
});

function assertInitResult(result: any): void {
  if (!result || typeof result !== 'object' || typeof result.protocolVersion !== 'string') {
    throw new Error('protocol error: initialize result has no protocolVersion');
  }
}

function toolsOf(result: any): { count: number; next?: string } {
  if (!result || !Array.isArray(result.tools)) throw new Error('protocol error: tools/list result has no tools array');
  return { count: result.tools.length, next: typeof result.nextCursor === 'string' ? result.nextCursor : undefined };
}

// ---- stdio ----

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    // already gone
  }
  const pid = child.pid;
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }, 1000).unref();
}

interface ProbeContext {
  signal: AbortSignal;
  version: string;
  seconds: number;
  /** What the probe is currently waiting for, used in timeout messages */
  state: { step: string };
}

const timedOut = (ctx: ProbeContext): Error => new Error(`timed out after ${ctx.seconds}s while ${ctx.state.step}`);

async function probeStdio(cfg: McpServerConfig, env: NodeJS.ProcessEnv, ctx: ProbeContext): Promise<number> {
  const state = ctx.state;
  state.step = 'starting the process';
  const command = cfg.command as string;
  const childEnv = { ...env, ...(cfg.env ?? {}) };
  const plan = spawnPlan(command, (cfg.args ?? []).map(String), childEnv);
  if (!plan) throw new Error(`command not found: ${command}`);
  const child = spawn(plan.file, plan.args, {
    cwd: typeof cfg.cwd === 'string' ? cfg.cwd : undefined,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
    windowsVerbatimArguments: plan.verbatim,
  });
  live.add(child);
  hook();
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');

  let stderr = '';
  let fatal: Error | null = null;
  let closed = false;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const failAll = (err: Error): void => {
    fatal ??= err;
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };

  child.stderr?.on('data', (d: string) => {
    stderr = (stderr + d).slice(-4000);
  });
  child.stdin?.on('error', () => undefined);
  child.on('error', (err: NodeJS.ErrnoException) => {
    failAll(new Error(err.code === 'ENOENT' ? `command not found: ${command}` : `cannot start ${command}: ${err.message}`));
  });
  child.on('close', (code, signal) => {
    closed = true;
    live.delete(child);
    if (live.size === 0) unhook();
    const tail = lastLines(stderr);
    failAll(new Error(`exited with ${signal ? `signal ${signal}` : `code ${code}`} while ${state.step}${tail ? `: ${tail}` : ''}`));
  });
  const onAbort = (): void => failAll(timedOut(ctx));
  ctx.signal.addEventListener('abort', onAbort, { once: true });

  let buf = '';
  const send = (msg: Json): void => {
    if (fatal) return;
    child.stdin?.write(JSON.stringify(msg) + '\n');
  };
  child.stdout?.on('data', (d: string) => {
    buf += d;
    if (buf.length > MAX_OUTPUT) {
      failAll(new Error('output too large (over 4 MB without a complete message)'));
      killTree(child);
      return;
    }
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: Json;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // servers sometimes log to stdout
      }
      if (msg && msg.method && msg.id !== undefined) {
        send(msg.method === 'ping' ? { jsonrpc: '2.0', id: msg.id, result: {} } : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
      } else if (msg && typeof msg.id === 'number' && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`protocol error: ${msg.error.message ?? JSON.stringify(msg.error)}`));
        else p.resolve(msg.result);
      }
    }
  });

  let nextId = 0;
  const request = (method: string, params?: Json): Promise<any> =>
    new Promise((resolve, reject) => {
      if (fatal) return reject(fatal);
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      send(rpc(id, method, params));
    });

  try {
    state.step = 'waiting for the initialize response';
    const init = await request('initialize', initParams(ctx.version));
    assertInitResult(init);
    send(note('notifications/initialized'));
    if (init.capabilities && !init.capabilities.tools) return 0;
    let tools = 0;
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      state.step = 'waiting for the tools/list response';
      const res = toolsOf(await request('tools/list', cursor ? { cursor } : {}));
      tools += res.count;
      if (!res.next) break;
      cursor = res.next;
    }
    return tools;
  } finally {
    ctx.signal.removeEventListener('abort', onAbort);
    try {
      child.stdin?.end();
    } catch {
      // ignore
    }
    if (!closed) killTree(child);
  }
}

// ---- streamable HTTP ----

async function readResponse(res: Response, id: number): Promise<Json> {
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('text/event-stream')) {
    const text = await res.text();
    if (text.length > MAX_OUTPUT) throw new Error('output too large (response over 4 MB)');
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`protocol error: response is not JSON (${text.slice(0, 80).replace(/\s+/g, ' ')})`);
    }
    const msg = Array.isArray(body) ? body.find((m) => m.id === id) : body;
    if (!msg) throw new Error('protocol error: no response for the request');
    return msg;
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error('protocol error: empty event stream');
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: !done });
      let sep: number;
      while ((sep = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const event = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, '');
        const data = event.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
        if (!data) continue;
        try {
          const msg = JSON.parse(data);
          if (msg && msg.id === id) return msg;
        } catch {
          // not a JSON event
        }
      }
      if (done) throw new Error('protocol error: event stream ended without a response');
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

function networkMessage(err: unknown, url: string): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  const code = e.cause?.code;
  if (code === 'ECONNREFUSED') return `connection refused: ${url}`;
  if (code === 'ENOTFOUND') return `host not found: ${url}`;
  if (code) return `${code}: ${url}`;
  return e.cause?.message ?? e.message ?? String(err);
}

async function probeHttp(cfg: McpServerConfig, ctx: ProbeContext): Promise<number> {
  const url = cfg.url as string;
  const state = ctx.state;
  const signal = ctx.signal;
  state.step = 'waiting for the initialize response';
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(cfg.headers ?? {}),
  };
  let session: string | undefined;
  let protocol: string | undefined;

  const post = async (body: Json): Promise<Response> => {
    const h = { ...headers, ...(session ? { 'mcp-session-id': session } : {}), ...(protocol ? { 'mcp-protocol-version': protocol } : {}) };
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(body), signal });
    } catch (err) {
      if (signal.aborted) throw timedOut(ctx);
      throw new Error(networkMessage(err, url));
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 100).replace(/\s+/g, ' ');
      if (res.status === 401 || res.status === 403) throw new ProbeWarning(`HTTP ${res.status}: needs auth${text ? ` (${text})` : ''}`);
      throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ''}`);
    }
    return res;
  };

  let id = 0;
  const call = async (method: string, params?: Json): Promise<any> => {
    const myId = ++id;
    const res = await post(rpc(myId, method, params));
    const sid = res.headers.get('mcp-session-id');
    if (sid) session = sid;
    const msg = await readResponse(res, myId).catch((err) => {
      throw signal.aborted ? timedOut(ctx) : err;
    });
    if (msg.error) throw new Error(`protocol error: ${msg.error.message ?? JSON.stringify(msg.error)}`);
    return msg.result;
  };

  try {
    const init = await call('initialize', initParams(ctx.version));
    assertInitResult(init);
    protocol = init.protocolVersion;
    state.step = 'sending notifications/initialized';
    await (await post(note('notifications/initialized'))).text().catch(() => '');
    if (init.capabilities && !init.capabilities.tools) return 0;
    let tools = 0;
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      state.step = 'waiting for the tools/list response';
      const res = toolsOf(await call('tools/list', cursor ? { cursor } : {}));
      tools += res.count;
      if (!res.next) break;
      cursor = res.next;
    }
    return tools;
  } finally {
    if (session) {
      fetch(url, { method: 'DELETE', headers: { ...headers, 'mcp-session-id': session }, signal: AbortSignal.timeout(2000) }).catch(() => undefined);
    }
  }
}

/**
 * Starts the server as a client would: initialize, notifications/initialized,
 * tools/list. stdio servers are spawned and their whole process tree is killed
 * afterwards. This runs the command the hub declares, so callers must have user intent.
 */
export async function probeMcpServer(name: string, cfg: McpServerConfig, options: ProbeOptions = {}): Promise<ProbeResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 20000;
  const env = options.env ?? homeEnv();
  let secrets: string[] = [];
  const done = (status: ProbeResult['status'], message: string, tools?: number): ProbeResult => ({
    name,
    status,
    message: redact(message, secrets),
    tools,
    ms: Date.now() - started,
  });

  const { config, unresolved } = resolveServerVars(cfg, env, options.home ?? env.HOME ?? '');
  if (unresolved.length > 0) return done('WARN', `unresolved variable(s): ${unresolved.join(', ')}`);
  secrets = secretsOf(config);

  const isHttp = typeof config.url === 'string' && !config.command;
  if (!isHttp && typeof config.command !== 'string') return done('FAIL', 'server has neither a command nor a url');
  if (isHttp && config.type === 'sse') return done('SKIP', 'legacy SSE transport is not probed');

  const abort = new AbortController();
  const ctx: ProbeContext = {
    signal: abort.signal,
    version: options.clientVersion ?? '0.0.0',
    seconds: Math.round(timeoutMs / 1000),
    state: { step: 'starting' },
  };
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const tools = await (isHttp ? probeHttp(config, ctx) : probeStdio(config, env, ctx));
    return done('PASS', `${tools} tool${tools === 1 ? '' : 's'}`, tools);
  } catch (err) {
    return done(err instanceof ProbeWarning ? 'WARN' : 'FAIL', (err as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

/** Probes servers concurrently, at most `concurrency` at a time. */
export async function probeMcpServers(
  servers: Record<string, McpServerConfig>,
  options: ProbeOptions & { concurrency?: number } = {}
): Promise<ProbeResult[]> {
  const entries = Object.entries(servers);
  const results: ProbeResult[] = new Array(entries.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < entries.length; i = next++) {
      results[i] = await probeMcpServer(entries[i][0], entries[i][1], options);
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 4, entries.length) }, worker));
  return results;
}
