import fs from 'node:fs';
import path from 'node:path';
import { getUtcTimestamp, safeWriteFile } from '../utils/fs.js';
import { getHomeDir, getHubDir } from './detector.js';
import {
  MCP_PLATFORMS,
  MCP_PLATFORM_IDS,
  fillType,
  isDisabled,
  projectPlatformServers,
  readPlatform,
  sameEntry,
  writePlatformServers,
  type McpPlatform,
  type McpPlatformId,
  type PlatformState,
} from './mcp-platforms.js';

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: 'stdio' | 'http' | 'sse';
  url?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

export interface McpPlatformStatus {
  path: string;
  exists: boolean;
  valid: boolean;
  servers: Record<string, McpServerConfig>;
}

export interface McpExtraPlatformStatus extends McpPlatformStatus {
  label: string;
  installed: boolean;
  missing: string[];
  untracked: string[];
  drifted: string[];
  /** Drifted entries the hub never wrote or ingested: sync leaves them alone unless forced */
  conflicted: string[];
}

export interface McpStatusReport {
  hub: McpPlatformStatus;
  claude: McpPlatformStatus;
  gemini: McpPlatformStatus;
  /** Every platform, by id */
  platforms: Record<McpPlatformId, McpExtraPlatformStatus>;
  in_sync: boolean;
  missing_in_claude: string[];
  missing_in_gemini: string[];
  untracked_in_claude: string[];
  untracked_in_gemini: string[];
  drifted_in_claude: string[];
  drifted_in_gemini: string[];
}

export interface SyncMcpResult {
  success: boolean;
  actions: string[];
}

export function readJsonSafely<T = Record<string, unknown>>(
  filePath: string
): { data: T; success: boolean } {
  if (!fs.existsSync(filePath)) {
    return { data: {} as T, success: true };
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { data: {} as T, success: false };
    }
    return { data: parsed as T, success: true };
  } catch {
    return { data: {} as T, success: false };
  }
}

type PathField = 'command' | 'value' | 'url';

// Applies fn to the fields that can hold paths: command, cwd, url, args and env values
function mapServerStrings(
  config: McpServerConfig,
  fn: (value: string, field: PathField) => string
): McpServerConfig {
  const clone = JSON.parse(JSON.stringify(config)) as McpServerConfig;
  if (typeof clone.command === 'string') clone.command = fn(clone.command, 'command');
  if (typeof clone.cwd === 'string') clone.cwd = fn(clone.cwd, 'command');
  if (typeof clone.url === 'string') clone.url = fn(clone.url, 'url');
  if (Array.isArray(clone.args)) {
    clone.args = clone.args.map((a) => (typeof a === 'string' ? fn(a, 'value') : a));
  }
  if (clone.env && typeof clone.env === 'object') {
    for (const [k, v] of Object.entries(clone.env)) {
      if (typeof v === 'string') clone.env[k] = fn(v, 'value');
    }
  }
  return clone;
}

/**
 * Expands ${HUB} and ${HOME} anywhere in the value. A leading ~ is expanded only
 * when it is "~" or "~/...": in `command` and `cwd` always, in args and env values
 * only when the whole value is a path (no whitespace), and never in a url.
 */
export function expandPathPlaceholders(
  value: string,
  home: string,
  hub: string,
  field: PathField = 'command'
): string {
  // Write the rest of the path with the base's separator, so Windows gets C:\x\y, not C:\x/y
  const native = (base: string, rest: string) =>
    field !== 'url' && base.includes('\\') ? base + rest.replace(/\//g, '\\') : base + rest;
  const expanded = value.replace(/\$\{(HUB|HOME)\}([^\s'";:]*)/g, (_m, key, rest) =>
    native(key === 'HUB' ? hub : home, rest)
  );
  const tilde = field === 'command' ? /^~(\/|$)/ : field === 'value' ? /^~(\/\S*)?$/ : null;
  return tilde?.test(expanded) ? native(home, expanded.slice(1)) : expanded;
}

/**
 * Inverse of expandPathPlaceholders: replaces absolute hub and home paths with
 * ${HUB} and ${HOME}, writing the rest of the path with forward slashes.
 */
export function contractPaths(value: string, home: string, hub: string): string {
  let out = value;
  const flags = process.platform === 'win32' ? 'gi' : 'g';
  for (const [abs, placeholder] of [[hub, '${HUB}'], [home, '${HOME}']] as const) {
    const base = abs.replace(/[\\/]+$/, '');
    if (!base) continue;
    for (const variant of new Set([base, base.replace(/\\/g, '/')])) {
      const esc = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(
        new RegExp(`(^|[=:;/\\s'"])${esc}((?:[\\\\/][^\\s'";:]*)?)(?=$|[:;\\s'"])`, flags),
        (_m, pre, rest) => pre + placeholder + rest.replace(/\\/g, '/')
      );
    }
  }
  return out;
}

export function expandServerPaths(config: McpServerConfig, home: string, hub: string): McpServerConfig {
  return mapServerStrings(config, (v, field) => expandPathPlaceholders(v, home, hub, field));
}

export function normalizeServerForHub(
  name: string,
  config: McpServerConfig,
  home?: string,
  hub?: string
): McpServerConfig {
  let clone = JSON.parse(JSON.stringify(config)) as McpServerConfig;
  delete clone.alwaysLoad;
  if (home && hub) clone = mapServerStrings(clone, (v) => contractPaths(v, home, hub));
  return clone;
}

function expandServers(
  servers: Record<string, McpServerConfig>,
  home: string,
  hub: string
): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    out[name] = isServerObject(cfg) ? expandServerPaths(cfg, home, hub) : cfg;
  }
  return out;
}

export function adaptServerForClaude(name: string, config: McpServerConfig): McpServerConfig {
  return fillType(config);
}

export function adaptServerForGemini(name: string, config: McpServerConfig): McpServerConfig {
  return fillType(config);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA).filter((k) => objA[k] !== undefined).sort();
  const keysB = Object.keys(objB).filter((k) => objB[k] !== undefined).sort();
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i++) {
    const k = keysA[i];
    if (k !== keysB[i]) return false;
    if (!deepEqual(objA[k], objB[k])) return false;
  }
  return true;
}

function isServerObject(value: unknown): value is McpServerConfig {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// A missing type (stdio for a command, http for a url) and client-only keys the
// hub drops on ingest, like alwaysLoad, don't change how a server runs, so they
// don't count as drift. Other client keys (e.g. disabled) still do for Claude and Gemini.
export function serversEquivalent(a: unknown, b: unknown): boolean {
  if (!isServerObject(a) || !isServerObject(b)) return deepEqual(a, b);
  const comparable = (cfg: McpServerConfig) => fillType(normalizeServerForHub('', cfg));
  return deepEqual(comparable(a), comparable(b));
}

/** True when the platform's entry no longer matches what the hub would project for it. */
export function platformDrifted(platform: McpPlatform, native: Record<string, unknown>, hubCfg: McpServerConfig): boolean {
  if (platform.legacy) return !serversEquivalent(native, hubCfg);
  const expected = platform.toNative(hubCfg, native);
  const keys = new Set([...platform.owned, ...Object.keys(expected)]);
  const actual: Record<string, unknown> = {};
  for (const k of keys) if (k in native) actual[k] = native[k];
  return !serversEquivalent(platform.fromNative(actual), platform.fromNative(expected));
}

/** The entries to write for one file: Claude/Gemini keep a matching entry's extra keys, others keep platform-only keys. */
function projectFor(
  platform: McpPlatform,
  hubServers: Record<string, McpServerConfig>,
  current: Record<string, Record<string, unknown>>,
  keep: Set<string>
): Record<string, Record<string, unknown>> {
  const todo: Record<string, McpServerConfig> = {};
  for (const [n, c] of Object.entries(hubServers)) if (!keep.has(n)) todo[n] = c;
  if (!platform.legacy) return projectPlatformServers(platform, todo, current);
  const target: Record<string, Record<string, unknown>> = { ...current };
  for (const [name, cfg] of Object.entries(todo)) {
    const existing = current[name];
    const adapted = platform.toNative(cfg) as Record<string, unknown>;
    target[name] = isServerObject(existing) && serversEquivalent(existing, cfg) ? { ...adapted, ...existing } : adapted;
  }
  return target;
}

// ---- origins: which platform each hub server was ingested from, and where the hub wrote it ----

export interface McpOrigin {
  /** Ingested from these platforms: the entry was there before agenthub */
  from: McpPlatformId[];
  /** agenthub wrote the entry there (and it is safe to remove again) */
  to: McpPlatformId[];
  /** An identical entry was already there on first sync: the user's, kept on uninstall */
  pre: McpPlatformId[];
}

export function originsPath(hub: string): string {
  return path.join(hub, 'mcp', 'origins.json');
}

export function readOrigins(hub: string): Record<string, McpOrigin> {
  const read = readJsonSafely<Record<string, Partial<McpOrigin>>>(originsPath(hub));
  const out: Record<string, McpOrigin> = {};
  for (const [name, o] of Object.entries(read.success ? read.data : {})) {
    if (o && typeof o === 'object') {
      out[name] = { from: Array.isArray(o.from) ? o.from : [], to: Array.isArray(o.to) ? o.to : [], pre: Array.isArray(o.pre) ? o.pre : [] };
    }
  }
  return out;
}

function writeOrigins(hub: string, origins: Record<string, McpOrigin>): void {
  const sorted = Object.fromEntries(Object.entries(origins).sort(([a], [b]) => a.localeCompare(b)));
  safeWriteFile(originsPath(hub), JSON.stringify(sorted, null, 2) + '\n');
}

// ---- status ----

function platformStatus(
  platform: McpPlatform,
  state: PlatformState,
  hubServers: Record<string, McpServerConfig>,
  expandedHub: Record<string, McpServerConfig>,
  origins: Record<string, McpOrigin>
): McpExtraPlatformStatus {
  const missing: string[] = [];
  const untracked: string[] = [];
  const drifted: string[] = [];
  const conflicted: string[] = [];
  if (state.installed && state.valid) {
    for (const name of Object.keys(hubServers)) {
      if (!(name in state.servers)) missing.push(name);
      else if (platformDrifted(platform, state.servers[name], expandedHub[name])) {
        drifted.push(name);
        if (isConflict(platform, platform.id, name, origins)) conflicted.push(name);
      }
    }
    for (const [name, native] of Object.entries(state.servers)) {
      if (!(name in hubServers) && !isDisabled(native)) untracked.push(name);
    }
  }
  const settingsOnly = state.files.length > 1 && state.files[1].exists && !state.files[0].exists;
  const shown = settingsOnly ? state.files[1] : state.files[0];
  return {
    label: platform.label,
    installed: state.installed,
    path: shown.path,
    exists: state.exists,
    valid: state.valid,
    servers: state.servers as Record<string, McpServerConfig>,
    missing,
    untracked,
    drifted,
    conflicted,
  };
}

/** A different entry the hub never wrote there and never ingested from there. */
function isConflict(platform: McpPlatform, id: McpPlatformId, name: string, origins: Record<string, McpOrigin>): boolean {
  const o = origins[name];
  return !o || (!o.from.includes(id) && !o.to.includes(id));
}

function resolveArgs(
  homeDirOrOptions?: string | { homeDir?: string; hubDir?: string; force?: boolean },
  hubDir?: string
): { home: string; hub: string; force: boolean } {
  const obj = typeof homeDirOrOptions === 'object' && homeDirOrOptions ? homeDirOrOptions : null;
  return {
    home: (obj ? obj.homeDir : (homeDirOrOptions as string | undefined)) || getHomeDir(),
    hub: (obj ? obj.hubDir : hubDir) || getHubDir(),
    force: Boolean(obj?.force),
  };
}

export function getMcpStatus(
  homeDirOrOptions?: string | { homeDir?: string; hubDir?: string },
  hubDir?: string
): McpStatusReport {
  const { home, hub } = resolveArgs(homeDirOrOptions, hubDir);

  const hubPath = path.join(hub, 'mcp', 'servers.json');
  const hubExists = fs.existsSync(hubPath);
  const hubRead = readJsonSafely(hubPath);
  const hubServers: Record<string, McpServerConfig> =
    hubRead.success &&
    hubRead.data?.mcpServers &&
    typeof hubRead.data.mcpServers === 'object' &&
    !Array.isArray(hubRead.data.mcpServers)
      ? (hubRead.data.mcpServers as Record<string, McpServerConfig>)
      : {};
  const expandedHub = expandServers(hubServers, home, hub);
  const origins = readOrigins(hub);

  const platforms = {} as Record<McpPlatformId, McpExtraPlatformStatus>;
  for (const id of MCP_PLATFORM_IDS) {
    platforms[id] = platformStatus(MCP_PLATFORMS[id], readPlatform(MCP_PLATFORMS[id], home), hubServers, expandedHub, origins);
  }
  const base = (st: McpExtraPlatformStatus): McpPlatformStatus => ({ path: st.path, exists: st.exists, valid: st.valid, servers: st.servers });

  const in_sync =
    hubRead.success &&
    MCP_PLATFORM_IDS.every((id) => {
      const st = platforms[id];
      return !st.installed || (st.valid && !st.missing.length && !st.untracked.length && !st.drifted.length);
    });

  return {
    hub: { path: hubPath, exists: hubExists, valid: hubRead.success, servers: hubServers },
    claude: base(platforms.claude),
    gemini: base(platforms.gemini),
    platforms,
    in_sync,
    missing_in_claude: platforms.claude.missing,
    missing_in_gemini: platforms.gemini.missing,
    untracked_in_claude: platforms.claude.untracked,
    untracked_in_gemini: platforms.gemini.untracked,
    drifted_in_claude: platforms.claude.drifted,
    drifted_in_gemini: platforms.gemini.drifted,
  };
}

export function syncMcpServers(
  homeDirOrOptions?: string | { homeDir?: string; hubDir?: string; force?: boolean },
  hubDir?: string
): SyncMcpResult {
  const { home, hub, force } = resolveArgs(homeDirOrOptions, hubDir);
  const actions: string[] = [];

  const hubFile = path.join(hub, 'mcp', 'servers.json');
  const hubRead = readJsonSafely(hubFile);

  if (fs.existsSync(hubFile) && !hubRead.success) {
    return {
      success: false,
      actions: ['Aborting MCP sync: servers.json is corrupt or unparseable'],
    };
  }

  const hubServers: Record<string, McpServerConfig> =
    hubRead.success &&
    hubRead.data?.mcpServers &&
    typeof hubRead.data.mcpServers === 'object' &&
    !Array.isArray(hubRead.data.mcpServers)
      ? { ...hubRead.data.mcpServers }
      : {};
  let hubChanged = false;
  const origins = readOrigins(hub);
  const originsBefore = JSON.stringify(origins);

  // Each platform is read once, then used for both ingest and projection
  const states: Partial<Record<McpPlatformId, PlatformState>> = {};
  for (const id of MCP_PLATFORM_IDS) {
    const platform = MCP_PLATFORMS[id];
    if (!platform.installed(home)) continue;
    const state = readPlatform(platform, home);
    states[id] = state;
    if (!state.valid) continue;
    for (const [name, native] of Object.entries(state.servers)) {
      if (name in hubServers) continue;
      if (isDisabled(native)) {
        actions.push(`[SKIP] Not ingesting disabled server "${name}" from ${platform.label}`);
        continue;
      }
      hubServers[name] = normalizeServerForHub(name, platform.fromNative(native), home, hub);
      origins[name] = { from: [id], to: origins[name]?.to ?? [], pre: origins[name]?.pre ?? [] };
      hubChanged = true;
      actions.push(`Ingested server "${name}" from ${platform.label} into hub`);
    }
  }

  // Save updated hub servers.json
  if (hubChanged || !fs.existsSync(hubFile)) {
    const hubData = { ...hubRead.data, mcpServers: hubServers };
    safeWriteFile(hubFile, JSON.stringify(hubData, null, 2) + '\n');
    actions.push('Updated hub servers.json');
  }

  const projectedHub = expandServers(hubServers, home, hub);

  const backupDir = path.join(hub, 'backups', `mcp-sync-${getUtcTimestamp()}`);

  for (const id of MCP_PLATFORM_IDS) {
    const platform = MCP_PLATFORMS[id];
    const state = states[id];
    if (!state) continue;

    // A different entry that the hub never wrote is the user's: report it, do not overwrite it
    const keep = new Set<string>();
    if (state.valid && !force) {
      for (const name of Object.keys(projectedHub)) {
        const native = state.servers[name];
        if (native && isConflict(platform, id, name, origins) && platformDrifted(platform, native, projectedHub[name])) {
          keep.add(name);
          actions.push(`[CONFLICT] ${platform.label} has its own "${name}" that differs from the hub: left as is (agenthub mcp sync --force overwrites it)`);
        }
      }
    }

    // names the hub wrote in this run, and names that were already identical before it
    const wrote = new Set<string>();
    const existing = state.files.filter((f) => f.exists).map((f) => f.path);
    for (const filePath of platform.writeFiles(home, existing)) {
      const file = state.files.find((f) => f.path === filePath);
      if (!file) continue;
      if (!file.exists && Object.keys(projectedHub).length === 0 && !platform.legacy) continue;
      const target = projectFor(platform, projectedHub, file.servers, keep);
      const changing = Object.keys(target).filter((n) => !sameEntry(file.servers[n], target[n]));
      // a forced run changes files the user may have edited: keep a copy of each first
      if (force && changing.length > 0 && file.exists) {
        const copy = path.join(backupDir, path.relative(home, file.path));
        fs.mkdirSync(path.dirname(copy), { recursive: true });
        fs.copyFileSync(file.path, copy);
        actions.push(`Backed up ${path.basename(file.path)} to ${copy}`);
      }
      const outcome = writePlatformServers(platform, file, target, [], Boolean(platform.legacy));
      if (outcome.skipped) actions.push(`[SKIP] ${outcome.skipped}`);
      else if (outcome.changed) {
        actions.push(`Updated ${platform.label} MCP configuration in ${path.basename(filePath)}`);
        for (const n of changing) wrote.add(n);
      }
    }

    // record who owns what: only after a successful write, or when it was identical already
    if (state.valid) {
      for (const name of Object.keys(projectedHub)) {
        if (keep.has(name) || !(name in hubServers)) continue;
        const o = (origins[name] ??= { from: [], to: [], pre: [] });
        if (wrote.has(name)) {
          if (!o.to.includes(id)) o.to.push(id);
          o.pre = o.pre.filter((p) => p !== id);
        } else if (name in state.servers && !o.to.includes(id) && !o.from.includes(id) && !o.pre.includes(id)) {
          o.pre.push(id);
        }
      }
    }
  }

  if (Object.keys(hubServers).length > 0 && JSON.stringify(origins) !== originsBefore) writeOrigins(hub, origins);

  if (actions.length === 0) {
    actions.push('All MCP configurations are already synchronized.');
  }

  return { success: true, actions };
}
