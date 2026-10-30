import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { safeWriteFile } from '../utils/fs.js';
import { copilotInstalled } from './detector.js';
import type { McpServerConfig } from './mcp-sync.js';

/**
 * Per-platform MCP adapters for Codex, Cursor, Windsurf and GitHub Copilot CLI.
 * Formats (official docs):
 * - Codex: ~/.codex/config.toml, [mcp_servers.<name>] with command/args/env/cwd,
 *   or url + http_headers (https://developers.openai.com/codex/mcp)
 * - Cursor: ~/.cursor/mcp.json, mcpServers with command/args/env or url/headers (https://cursor.com/docs/mcp)
 * - Windsurf: ~/.codeium/windsurf/mcp_config.json, mcpServers; remote servers use serverUrl
 *   (docs moved to https://docs.devin.ai/cli/reference/configuration/read-config-from.md for the paths)
 * - Copilot CLI: ~/.copilot/mcp-config.json, mcpServers; type "local" or "http" and tools ["*"]
 *   (https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)
 */
export type McpPlatformId = 'claude' | 'gemini' | 'codex' | 'cursor' | 'windsurf' | 'copilot';

export const MCP_PLATFORM_IDS: McpPlatformId[] = ['claude', 'gemini', 'codex', 'cursor', 'windsurf', 'copilot'];

type Native = Record<string, unknown>;

export interface McpPlatform {
  id: McpPlatformId;
  label: string;
  format: 'json' | 'toml';
  /** Claude and Gemini: whole-entry drift, and no conflict protection (behaviour from before the adapters) */
  legacy?: boolean;
  /** Files the servers are read from; later files win */
  files(home: string): string[];
  /** The files sync writes to, given which of `files` exist */
  writeFiles(home: string, existing: string[]): string[];
  installed(home: string): boolean;
  /** Hub (expanded) server -> the platform's entry; platform-only keys are added by the caller */
  toNative(cfg: McpServerConfig, existing?: Native): Native;
  /** Platform entry -> hub-shaped server (no path contraction) */
  fromNative(native: Native): McpServerConfig;
  /** Native keys the hub owns; every other key of an existing entry is kept on sync */
  owned: string[];
}

const isObj = (v: unknown): v is Native => typeof v === 'object' && v !== null && !Array.isArray(v);

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function without(obj: Native, keys: string[]): Native {
  const out: Native = {};
  for (const [k, v] of Object.entries(obj)) if (!keys.includes(k)) out[k] = v;
  return out;
}

/** A missing type: stdio for a command, http for a url. */
export function fillType(config: McpServerConfig): McpServerConfig {
  const out = clone(config);
  if (out.url && !out.type) out.type = 'http';
  else if (out.command && !out.type) out.type = 'stdio';
  return out;
}

export const isDisabled = (native: Native): boolean => native.enabled === false || native.disabled === true;

const JSON_OWNED = ['command', 'args', 'env', 'cwd', 'url', 'headers', 'type'];
const exists = (p: string): boolean => fs.existsSync(p);

export const MCP_PLATFORMS: Record<McpPlatformId, McpPlatform> = {
  claude: {
    id: 'claude',
    label: 'Claude',
    format: 'json',
    legacy: true,
    files: (home) => [path.join(home, '.claude.json')],
    writeFiles: (home) => [path.join(home, '.claude.json')],
    installed: (home) => exists(path.join(home, '.claude.json')) || exists(path.join(home, '.claude')),
    owned: [],
    toNative: (cfg) => fillType(cfg) as Native,
    fromNative: (native) => clone(native) as McpServerConfig,
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    format: 'json',
    legacy: true,
    files: (home) => [path.join(home, '.gemini', 'config', 'mcp_config.json'), path.join(home, '.gemini', 'settings.json')],
    // mcp_config.json unless only settings.json exists; settings.json whenever it exists
    writeFiles(home, existing) {
      const mcp = path.join(home, '.gemini', 'config', 'mcp_config.json');
      const settings = path.join(home, '.gemini', 'settings.json');
      const out: string[] = [];
      if (existing.includes(mcp) || !existing.includes(settings)) out.push(mcp);
      if (existing.includes(settings)) out.push(settings);
      return out;
    },
    installed: (home) => exists(path.join(home, '.gemini')),
    owned: [],
    toNative: (cfg) => fillType(cfg) as Native,
    fromNative: (native) => clone(native) as McpServerConfig,
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    format: 'toml',
    files: (home) => [path.join(home, '.codex', 'config.toml')],
    writeFiles: (home) => [path.join(home, '.codex', 'config.toml')],
    installed: (home) => isDir(path.join(home, '.codex')),
    owned: ['command', 'args', 'env', 'cwd', 'url', 'http_headers'],
    // Codex rejects unknown keys, so only fields it documents are written
    toNative(cfg) {
      const out: Native = {};
      if (cfg.command !== undefined) out.command = cfg.command;
      if (cfg.args !== undefined) out.args = cfg.args;
      if (cfg.env !== undefined) out.env = cfg.env;
      if (typeof cfg.cwd === 'string') out.cwd = cfg.cwd;
      if (cfg.url !== undefined) out.url = cfg.url;
      if (cfg.headers !== undefined) out.http_headers = cfg.headers;
      return out;
    },
    fromNative(native) {
      const out: McpServerConfig = {};
      if (typeof native.command === 'string') out.command = native.command;
      if (Array.isArray(native.args)) out.args = native.args.map(String);
      if (isObj(native.env)) out.env = clone(native.env) as Record<string, string>;
      if (typeof native.cwd === 'string') out.cwd = native.cwd;
      if (typeof native.url === 'string') out.url = native.url;
      if (isObj(native.http_headers)) out.headers = clone(native.http_headers) as Record<string, string>;
      return out;
    },
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    format: 'json',
    files: (home) => [path.join(home, '.cursor', 'mcp.json')],
    writeFiles: (home) => [path.join(home, '.cursor', 'mcp.json')],
    installed: (home) => isDir(path.join(home, '.cursor')),
    // type is not owned: Cursor infers it, and one the user set is kept
    owned: JSON_OWNED.filter((k) => k !== 'type'),
    toNative(cfg) {
      return without(clone(cfg) as Native, ['type']);
    },
    fromNative(native) {
      return clone(native) as McpServerConfig;
    },
  },
  windsurf: {
    id: 'windsurf',
    label: 'Windsurf',
    format: 'json',
    files: (home) => [path.join(home, '.codeium', 'windsurf', 'mcp_config.json')],
    writeFiles: (home) => [path.join(home, '.codeium', 'windsurf', 'mcp_config.json')],
    installed: (home) => isDir(path.join(home, '.codeium', 'windsurf')),
    owned: [...JSON_OWNED, 'serverUrl'],
    toNative(cfg) {
      const out = without(clone(cfg) as Native, ['type', 'url']);
      if (typeof cfg.url === 'string') out.serverUrl = cfg.url;
      return out;
    },
    fromNative(native) {
      const out = without(clone(native), ['serverUrl']) as McpServerConfig;
      const url = native.serverUrl ?? native.url;
      if (typeof url === 'string') out.url = url;
      return out;
    },
  },
  copilot: {
    id: 'copilot',
    label: 'Copilot',
    format: 'json',
    files: (home) => [path.join(home, '.copilot', 'mcp-config.json')],
    writeFiles: (home) => [path.join(home, '.copilot', 'mcp-config.json')],
    installed: (home) => copilotInstalled(home),
    owned: JSON_OWNED,
    // Copilot CLI wants type (local or http) and tools on every entry; an existing tools filter is kept
    toNative(cfg, existing) {
      const out = without(clone(cfg) as Native, ['type']);
      const remote = typeof cfg.url === 'string' && !cfg.command;
      out.type = remote ? (cfg.type === 'sse' ? 'sse' : 'http') : 'local';
      out.tools = Array.isArray(existing?.tools) ? existing.tools : ['*'];
      return out;
    },
    fromNative(native) {
      const out = without(clone(native), ['tools']);
      if (out.type === 'local' || out.type === 'stdio') delete out.type;
      return out as McpServerConfig;
    },
  },
};

// ---- reading ----

export interface PlatformFile {
  path: string;
  exists: boolean;
  valid: boolean;
  /** Parsed JSON object, or the parsed TOML document */
  data: Record<string, unknown>;
  /** Raw text without a leading BOM, for splicing */
  text: string;
  bom: boolean;
  servers: Record<string, Native>;
}

/** All files of one platform, read once. */
export interface PlatformState {
  installed: boolean;
  files: PlatformFile[];
  exists: boolean;
  valid: boolean;
  /** Servers of every file; a later file wins */
  servers: Record<string, Native>;
}

function serversOf(data: unknown, key: string): Record<string, Native> {
  const section = isObj(data) ? data[key] : undefined;
  if (!isObj(section)) return {};
  const out: Record<string, Native> = {};
  for (const [name, v] of Object.entries(section)) if (isObj(v)) out[name] = v;
  return out;
}

export function readPlatformFile(platform: McpPlatform, file: string): PlatformFile {
  const empty: PlatformFile = { path: file, exists: false, valid: true, data: {}, text: '', bom: false, servers: {} };
  if (!fs.existsSync(file)) return empty;
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return { ...empty, exists: true, valid: false };
  }
  const bom = raw.charCodeAt(0) === 0xfeff;
  const text = bom ? raw.slice(1) : raw;
  try {
    const data: unknown = platform.format === 'toml' ? parseToml(text) : JSON.parse(text);
    if (!isObj(data)) return { ...empty, exists: true, valid: false, text, bom };
    const key = platform.format === 'toml' ? 'mcp_servers' : 'mcpServers';
    return { path: file, exists: true, valid: true, data, text, bom, servers: serversOf(data, key) };
  } catch {
    return { ...empty, exists: true, valid: false, text, bom };
  }
}

export function readPlatform(platform: McpPlatform, home: string): PlatformState {
  const files = platform.files(home).map((f) => readPlatformFile(platform, f));
  const servers: Record<string, Native> = {};
  for (const f of files) Object.assign(servers, f.servers);
  return {
    installed: platform.installed(home),
    files,
    exists: files.some((f) => f.exists),
    valid: files.every((f) => f.valid),
    servers,
  };
}

// ---- projection ----

/**
 * The entries to write: hub servers adapted to the platform, keeping the
 * platform-only keys (oauth, enabled_tools, tools, ...) of existing entries.
 * Servers that exist only on the platform are kept untouched.
 */
export function projectPlatformServers(
  platform: McpPlatform,
  hubServers: Record<string, McpServerConfig>,
  current: Record<string, Native>
): Record<string, Native> {
  const target: Record<string, Native> = { ...current };
  for (const [name, cfg] of Object.entries(hubServers)) {
    const existing = current[name];
    const adapted = platform.toNative(cfg, existing);
    const hubKeys = Object.keys(adapted);
    target[name] = existing ? { ...without(existing, [...platform.owned, ...hubKeys]), ...adapted } : adapted;
  }
  return target;
}

// ---- TOML editing: only the touched [mcp_servers.<name>] tables are rewritten ----

interface TomlSection {
  start: number;
  end: number;
  path: string[];
}

function parseHeaderPath(header: string): string[] | null {
  const parts: string[] = [];
  let i = 0;
  const s = header.trim();
  while (i < s.length) {
    while (s[i] === ' ' || s[i] === '\t') i++;
    if (s[i] === '"' || s[i] === "'") {
      const quote = s[i];
      let j = i + 1;
      let val = '';
      while (j < s.length && s[j] !== quote) {
        if (quote === '"' && s[j] === '\\' && j + 1 < s.length) {
          val += s[j + 1];
          j += 2;
        } else val += s[j++];
      }
      if (j >= s.length) return null;
      parts.push(val);
      i = j + 1;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i));
      if (!m) return null;
      parts.push(m[0]);
      i += m[0].length;
    }
    while (s[i] === ' ' || s[i] === '\t') i++;
    if (i >= s.length) break;
    if (s[i] !== '.') return null;
    i++;
  }
  return parts.length ? parts : null;
}

/** Splits TOML text into table sections by header line, skipping multi-line strings. */
function tomlSections(lines: string[]): TomlSection[] {
  const heads: Array<{ line: number; path: string[] }> = [];
  let multi: string | null = null;
  lines.forEach((line, idx) => {
    if (multi) {
      if (line.includes(multi)) multi = null;
      return;
    }
    const header = /^\s*\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/.exec(line);
    if (header) {
      const p = parseHeaderPath(header[1]);
      if (p) heads.push({ line: idx, path: p });
      return;
    }
    for (const q of ['"""', "'''"]) {
      const count = line.split(q).length - 1;
      if (count % 2 === 1) multi = q;
    }
  });
  return heads.map((h, i) => {
    let end = i + 1 < heads.length ? heads[i + 1].line : lines.length;
    // comments directly above the next header belong to it
    while (end > h.line + 1 && /^\s*#/.test(lines[end - 1])) end--;
    return { start: h.line, end, path: h.path };
  });
}

function deepEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

/**
 * Applies changed servers to config.toml text. `changes[name]` is the new entry,
 * or null to remove it. Everything outside those tables stays byte for byte.
 * Returns null when the result does not parse back to the wanted servers
 * (for example a server written as an inline table), so the caller can refuse.
 */
export function spliceCodexServers(text: string, changes: Record<string, Native | null>): string | null {
  const lines = text.split('\n');
  let sections = tomlSections(lines);
  let out = lines;
  for (const [name, entry] of Object.entries(changes)) {
    const mine = sections.filter((s) => s.path[0] === 'mcp_servers' && s.path[1] === name);
    const rendered = entry
      ? stringifyToml({ mcp_servers: { [name]: entry } }).replace(/\n+$/, '').split('\n')
      : [];
    if (mine.length === 0) {
      if (!entry) continue;
      const tail = out.length > 0 && out[out.length - 1] === '' ? out.slice(0, -1) : out;
      const sep = tail.length > 0 ? [''] : [];
      out = [...tail, ...sep, ...rendered, ''];
    } else {
      const kept: string[] = [];
      let insertAt = -1;
      for (let i = 0; i < out.length; i++) {
        const inMine = mine.find((s) => i >= s.start && i < s.end);
        if (inMine) {
          if (insertAt < 0) insertAt = kept.length;
          continue;
        }
        kept.push(out[i]);
      }
      const block = rendered.length ? [...rendered, ''] : [];
      out = [...kept.slice(0, insertAt), ...block, ...kept.slice(insertAt)];
    }
    sections = tomlSections(out);
  }
  const result = out.join('\n');
  try {
    const parsed = serversOf(parseToml(result), 'mcp_servers');
    for (const [name, entry] of Object.entries(changes)) {
      if (entry ? !deepEq(parsed[name], entry) : name in parsed) return null;
    }
  } catch {
    return null;
  }
  return untouchedOutsideChanges(text, result, Object.keys(changes)) ? result : null;
}

/**
 * True when every line of `before` that is outside the changed servers' tables
 * is still in `after`, in order and unchanged: nothing else was touched.
 */
function untouchedOutsideChanges(before: string, after: string, names: string[]): boolean {
  const lines = before.split('\n');
  const removed = new Set<number>();
  for (const sec of tomlSections(lines)) {
    if (sec.path[0] === 'mcp_servers' && names.includes(sec.path[1])) for (let i = sec.start; i < sec.end; i++) removed.add(i);
  }
  const outLines = after.split('\n');
  let at = 0;
  for (let i = 0; i < lines.length; i++) {
    if (removed.has(i)) continue;
    // the trailing empty element is a split artifact, appending may move it
    if (i === lines.length - 1 && lines[i] === '') continue;
    while (at < outLines.length && outLines[at] !== lines[i]) at++;
    if (at >= outLines.length) return false;
    at++;
  }
  return true;
}

export interface WriteOutcome {
  changed: boolean;
  skipped?: string;
}

/**
 * Writes `target` servers into one platform file, preserving everything else.
 * Refuses (skipped) when the file is corrupt or cannot be edited safely.
 * `forceKey` writes even without a server change when the file has no server table.
 */
export function writePlatformServers(
  platform: McpPlatform,
  file: PlatformFile,
  target: Record<string, Native>,
  removed: string[] = [],
  forceKey = false
): WriteOutcome {
  const name = path.basename(file.path);
  if (file.exists && !file.valid) return { changed: false, skipped: `Refusing to overwrite ${name}: file is corrupt or unparseable` };

  const changes: Record<string, Native | null> = {};
  for (const [n, entry] of Object.entries(target)) if (!deepEq(file.servers[n], entry)) changes[n] = entry;
  for (const n of removed) if (n in file.servers) changes[n] = null;
  const missingTable = platform.format === 'json' && forceKey && !isObj(file.data.mcpServers);
  if (Object.keys(changes).length === 0 && !missingTable) return { changed: false };

  const bom = file.bom ? '\ufeff' : '';
  if (platform.format === 'json') {
    const servers: Record<string, Native> = { ...file.servers };
    for (const [n, entry] of Object.entries(changes)) {
      if (entry) servers[n] = entry;
      else delete servers[n];
    }
    safeWriteFile(file.path, bom + JSON.stringify({ ...file.data, mcpServers: servers }, null, 2) + '\n');
    return { changed: true };
  }

  const next = spliceCodexServers(file.text, changes);
  if (next === null) return { changed: false, skipped: `Cannot safely edit ${name}: mcp_servers is not written as [mcp_servers.<name>] tables` };
  safeWriteFile(file.path, bom + next);
  return { changed: true };
}

/** Removes the named servers from the platform's files; used by uninstall. */
export function removePlatformServers(platform: McpPlatform, state: PlatformState, names: string[]): string[] {
  const done: string[] = [];
  for (const file of state.files) {
    if (!file.exists || !file.valid) continue;
    const present = names.filter((n) => n in file.servers);
    if (present.length === 0) continue;
    if (writePlatformServers(platform, file, {}, present).changed) done.push(...present);
  }
  return done;
}
