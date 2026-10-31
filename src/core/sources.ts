import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { safeWriteFile } from '../utils/fs.js';
import { homeEnv } from './detector.js';
import { ignoredNames } from './local.js';
import { loadManifest, type AgentPackageManifest, type SourceSpec } from './manifest.js';

export type SourceKind = 'skills' | 'mcp';

export type ParsedSource =
  | { type: 'local'; build?: string }
  | { type: 'github' | 'git'; url: string; ref?: string; subpath?: string; build?: string }
  | { type: 'npm'; pkg: string; range: string; subpath?: string }
  | { type: 'pypi'; pkg: string; range: string }
  | { type: 'custom'; install?: string; check: string; path?: string };

export interface DeclaredSource {
  kind: SourceKind;
  name: string;
  /** Canonical source string, recorded in the lockfile */
  spec: string;
  parsed: ParsedSource;
}

export interface LockEntry {
  source: string;
  commit?: string;
  version?: string;
}

export interface LockFile {
  version: 1;
  skills: Record<string, LockEntry>;
  mcp: Record<string, LockEntry>;
}

export interface ExecResult {
  status: number;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
}

/** Process and network access, replaceable in tests. */
export const runtime = {
  spawn(cmd: string, args: string[], cwd?: string): ExecResult {
    let file = cmd;
    let argv = args;
    if (cmd === 'npm' && process.platform === 'win32') {
      // npm is a .cmd shim and Node refuses to spawn those without a shell (CVE-2024-27980),
      // so run npm's own script with the current node instead.
      const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (!fs.existsSync(cli)) {
        return { status: -1, stdout: '', stderr: '', error: Object.assign(new Error('npm-cli.js not found'), { code: 'ENOENT' }) };
      }
      file = process.execPath;
      argv = [cli, ...args];
    }
    const res = spawnSync(file, argv, {
      cwd,
      encoding: 'utf-8',
      windowsHide: true,
      maxBuffer: 50 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file:https:ssh:git' },
    });
    return {
      status: res.status ?? -1,
      stdout: res.stdout || '',
      stderr: res.stderr || '',
      error: res.error as NodeJS.ErrnoException | undefined,
    };
  },
  /** Runs a user-provided command line through the shell. */
  shell(cmdline: string, cwd?: string): ExecResult {
    const res = spawnSync(cmdline, {
      cwd,
      shell: true,
      encoding: 'utf-8',
      windowsHide: true,
      maxBuffer: 50 * 1024 * 1024,
      timeout: 30 * 60 * 1000,
      // $HOME in a manifest command means the home agenthub works on (--home, AGENTHUB_HOME)
      env: homeEnv(),
    });
    return {
      status: res.status ?? -1,
      stdout: res.stdout || '',
      stderr: res.stderr || '',
      error: res.error as NodeJS.ErrnoException | undefined,
    };
  },
  async fetchJson(url: string): Promise<any> {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`GET ${url} returned HTTP ${res.status}`);
    return res.json();
  },
};

/** Runs a tool with an argument array; throws a clear error if it is missing or fails. */
export function runTool(cmd: string, args: string[], cwd?: string): string {
  const res = runtime.spawn(cmd, args, cwd);
  if (res.error) {
    if (res.error.code === 'ENOENT') {
      throw new Error(`'${cmd}' is not installed or not in PATH`);
    }
    throw new Error(`${cmd} failed: ${res.error.message}`);
  }
  if (res.status !== 0) {
    const detail = (res.stderr.trim() || res.stdout.trim() || `exit code ${res.status}`).split('\n').slice(-5).join('\n');
    throw new Error(`${cmd} ${args[0] ?? ''} failed: ${detail}`);
  }
  return res.stdout;
}

const NAME_RE = /^[A-Za-z0-9][\w.-]*$/;
const NPM_NAME_RE = /^(?:@[a-z0-9][\w.~-]*\/)?[a-z0-9][\w.~-]*$/i;
const PYPI_NAME_RE = /^[A-Za-z0-9][\w.-]*$/;
const NPM_RANGE_RE = /^[\w.^~<>=*+-]+$/;
const PYPI_RANGE_RE = /^[\w.<>=!,*+-]+$/;
export const COMMIT_RE = /^[0-9a-f]{40}$/;
export const VERSION_RE = /^\d[\w.+!-]*$/;
const SOURCE_FORMS =
  'local, github:owner/repo[#subpath], git:<url>[#subpath], npm:pkg@range[#subpath], pypi:pkg@range, or {check[, install]}';

function validSubpath(sub: string): boolean {
  return sub !== '' && !sub.startsWith('/') && !sub.split(/[\\/]/).includes('..');
}

function splitSubpath(rest: string): { base: string; subpath?: string } {
  const i = rest.indexOf('#');
  return i < 0 ? { base: rest } : { base: rest.slice(0, i), subpath: rest.slice(i + 1) };
}

function sourceString(spec: SourceSpec): string | undefined {
  return typeof spec === 'string' ? spec : spec.source;
}

/**
 * Parses one skills/mcp declaration. Throws an Error with a user-facing message.
 */
export function parseSourceSpec(kind: SourceKind, name: string, raw: unknown): DeclaredSource {
  const label = `${kind}.${name}`;
  if (!NAME_RE.test(name)) {
    throw new Error(`${label}: invalid name (use letters, digits, ".", "_" and "-")`);
  }
  if (typeof raw !== 'string' && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
    throw new Error(`${label}: expected a source string or an object`);
  }
  const spec = raw as SourceSpec;
  const obj = typeof spec === 'object' ? spec : {};
  const str = sourceString(spec);

  for (const [key, val] of Object.entries(obj)) {
    if (val !== undefined && typeof val !== 'string') {
      throw new Error(`${label}: "${key}" must be a string`);
    }
  }

  if (str === undefined) {
    if (!obj.check) {
      throw new Error(`${label}: an object without "source" needs a "check" command (and optionally an "install" command)`);
    }
    if (kind === 'skills' && !obj.path) {
      throw new Error(`${label}: a custom skill needs "path" (the skill folder after install)`);
    }
    return { kind, name, spec: 'custom', parsed: { type: 'custom', install: obj.install || undefined, check: obj.check, path: obj.path } };
  }
  if (obj.install || obj.check || obj.path) {
    throw new Error(`${label}: "install", "check" and "path" cannot be combined with "source"`);
  }
  if (obj.build !== undefined && kind === 'skills') {
    throw new Error(`${label}: "build" is only supported for MCP servers`);
  }

  const colon = str.indexOf(':');
  const scheme = str === 'local' ? 'local' : colon < 0 ? '' : str.slice(0, colon);
  const rest = colon < 0 ? '' : str.slice(colon + 1);
  const refSuffix = obj.ref ? ` ref=${obj.ref}` : '';

  if (obj.ref !== undefined && (!/^[\w./-]+$/.test(obj.ref) || obj.ref.startsWith('-'))) {
    throw new Error(`${label}: invalid ref "${obj.ref}"`);
  }
  if (obj.ref !== undefined && scheme !== 'github' && scheme !== 'git') {
    throw new Error(`${label}: "ref" is only supported for github: and git: sources`);
  }
  if (obj.build !== undefined && !['local', 'github', 'git'].includes(scheme)) {
    throw new Error(`${label}: "build" is only supported for local, github: and git: sources`);
  }

  switch (scheme) {
    case 'local':
      return { kind, name, spec: 'local', parsed: { type: 'local', build: obj.build } };
    case 'github': {
      const { base, subpath } = splitSubpath(rest);
      if (!/^[\w.-]+\/[\w.-]+$/.test(base)) {
        throw new Error(`${label}: expected github:owner/repo[#subpath], got "${str}"`);
      }
      if (subpath !== undefined && !validSubpath(subpath)) throw new Error(`${label}: invalid subpath "${subpath}"`);
      return {
        kind,
        name,
        spec: str + refSuffix,
        parsed: { type: 'github', url: `https://github.com/${base}.git`, ref: obj.ref, subpath, build: obj.build },
      };
    }
    case 'git': {
      const { base, subpath } = splitSubpath(rest);
      if (!base || base.startsWith('-')) throw new Error(`${label}: expected git:<url>[#subpath], got "${str}"`);
      if (subpath !== undefined && !validSubpath(subpath)) throw new Error(`${label}: invalid subpath "${subpath}"`);
      return {
        kind,
        name,
        spec: str + refSuffix,
        parsed: { type: 'git', url: base, ref: obj.ref, subpath, build: obj.build },
      };
    }
    case 'npm': {
      const { base, subpath } = splitSubpath(rest);
      const at = base.lastIndexOf('@');
      const pkg = at > 0 ? base.slice(0, at) : base;
      const range = at > 0 ? base.slice(at + 1) : 'latest';
      if (!NPM_NAME_RE.test(pkg) || !NPM_RANGE_RE.test(range)) {
        throw new Error(`${label}: expected npm:pkg@range, got "${str}"`);
      }
      if (subpath !== undefined && (kind === 'mcp' || !validSubpath(subpath))) {
        throw new Error(`${label}: ${kind === 'mcp' ? '"#subpath" is only supported for skills' : `invalid subpath "${subpath}"`}`);
      }
      return { kind, name, spec: str, parsed: { type: 'npm', pkg, range, subpath } };
    }
    case 'pypi': {
      if (kind !== 'mcp') throw new Error(`${label}: pypi: sources are only supported for MCP servers`);
      const at = rest.indexOf('@');
      const pkg = at > 0 ? rest.slice(0, at) : rest;
      const range = at > 0 ? rest.slice(at + 1) : 'latest';
      if (!PYPI_NAME_RE.test(pkg) || !PYPI_RANGE_RE.test(range)) {
        throw new Error(`${label}: expected pypi:pkg@range, got "${str}"`);
      }
      return { kind, name, spec: str, parsed: { type: 'pypi', pkg, range } };
    }
    default:
      throw new Error(`${label}: unknown source "${str}" (expected ${SOURCE_FORMS})`);
  }
}

export interface DeclaredSources {
  sources: DeclaredSource[];
  errors: string[];
}

/** Parses and validates the skills/mcp declarations of a manifest. */
export function parseDeclaredSources(manifest: Partial<AgentPackageManifest> | null | undefined): DeclaredSources {
  const sources: DeclaredSource[] = [];
  const errors: string[] = [];
  for (const kind of ['skills', 'mcp'] as const) {
    const section = manifest?.[kind] as unknown;
    if (section === undefined) continue;
    if (!section || typeof section !== 'object' || Array.isArray(section)) {
      errors.push(`${kind}: expected an object mapping names to sources`);
      continue;
    }
    for (const [name, raw] of Object.entries(section)) {
      try {
        sources.push(parseSourceSpec(kind, name, raw));
      } catch (err) {
        errors.push((err as Error).message);
      }
    }
  }
  return { sources, errors };
}

/** Declared sources of the hub, minus the MCP servers this machine ignores (they stay in the files). */
export function loadDeclaredSources(hub: string): DeclaredSources {
  const all = parseDeclaredSources(loadManifest(hub));
  const ignored = ignoredNames(hub, 'mcp');
  return ignored.size === 0 ? all : { ...all, sources: all.sources.filter((d) => !(d.kind === 'mcp' && ignored.has(d.name))) };
}

// ---- Lockfile ----

export function lockPath(hub: string): string {
  return path.join(hub, 'agenthub.lock.json');
}

export function emptyLock(): LockFile {
  return { version: 1, skills: {}, mcp: {} };
}

function validEntry(e: unknown): string | null {
  const entry = e as LockEntry;
  if (!entry || typeof entry !== 'object' || typeof entry.source !== 'string') return 'malformed entry';
  if (entry.commit !== undefined && !COMMIT_RE.test(String(entry.commit))) return `invalid commit "${entry.commit}"`;
  if (entry.version !== undefined && !VERSION_RE.test(String(entry.version))) return `invalid version "${entry.version}"`;
  return null;
}

/** Reads the lockfile. Entries with a malformed pin are dropped and listed in `invalid` (key "kind.name"). */
export function loadLockChecked(hub: string): { lock: LockFile; invalid: Record<string, string> } {
  const lock = emptyLock();
  const invalid: Record<string, string> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath(hub), 'utf-8'));
    for (const kind of ['skills', 'mcp'] as const) {
      const section = parsed?.[kind];
      if (!section || typeof section !== 'object' || Array.isArray(section)) continue;
      for (const [name, entry] of Object.entries(section)) {
        const problem = validEntry(entry);
        if (problem) invalid[`${kind}.${name}`] = `agenthub.lock.json: ${problem}`;
        else lock[kind][name] = entry as LockEntry;
      }
    }
  } catch {
    // missing or unparseable: treated as empty
  }
  return { lock, invalid };
}

export function loadLock(hub: string): LockFile {
  return loadLockChecked(hub).lock;
}

/** Source string without its "#subpath", so a subpath change keeps the pin. */
export function sameSource(a: string, b: string): boolean {
  return a.replace(/#\S*/, '') === b.replace(/#\S*/, '');
}

function sortedRecord(rec: Record<string, LockEntry>): Record<string, LockEntry> {
  return Object.fromEntries(Object.entries(rec).sort(([a], [b]) => a.localeCompare(b)));
}

export function serializeLock(lock: LockFile): string {
  return JSON.stringify({ version: 1, skills: sortedRecord(lock.skills), mcp: sortedRecord(lock.mcp) }, null, 2) + '\n';
}

/** Writes the lockfile only if its content changed. Returns whether it wrote. */
export function saveLock(hub: string, lock: LockFile): boolean {
  const next = serializeLock(lock);
  let current = '';
  try {
    current = fs.readFileSync(lockPath(hub), 'utf-8');
  } catch {
    // no lockfile yet
  }
  if (current === next) return false;
  safeWriteFile(lockPath(hub), next);
  return true;
}

// ---- Pin resolution ----

/** True for sources that need a lockfile pin. */
export function isPinned(decl: DeclaredSource): boolean {
  return ['github', 'git', 'npm', 'pypi'].includes(decl.parsed.type);
}

export function pinOf(entry: LockEntry | undefined): string | undefined {
  return entry?.commit ?? entry?.version;
}

function resolveGitCommit(url: string, ref?: string): string {
  if (ref && /^[0-9a-f]{40}$/i.test(ref)) return ref.toLowerCase();
  const out = runTool('git', ['ls-remote', '--', url, ...(ref ? [ref, `${ref}^{}`] : ['HEAD'])]);
  const refs = new Map<string, string>();
  for (const line of out.split(/\r?\n/)) {
    const [sha, name] = line.trim().split(/\s+/);
    if (sha && name) refs.set(name, sha);
  }
  const wanted = ref
    ? [`refs/tags/${ref}^{}`, `refs/tags/${ref}`, `refs/heads/${ref}`, ref]
    : ['HEAD'];
  for (const name of wanted) {
    const sha = refs.get(name);
    if (sha) return sha;
  }
  throw new Error(`could not resolve ${ref ? `ref "${ref}"` : 'HEAD'} of ${url}`);
}

function resolveNpmVersion(pkg: string, range: string): string {
  const out = runTool('npm', ['view', `${pkg}@${range}`, 'version', '--json']).trim();
  if (!out) throw new Error(`npm package ${pkg}@${range} not found`);
  const parsed = JSON.parse(out);
  const all: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const version = all.filter((v): v is string => typeof v === 'string' && VERSION_RE.test(v)).sort(compareVersions).pop();
  if (!version) throw new Error(`could not resolve npm version of ${pkg}@${range}`);
  return version;
}

export function compareVersions(a: string, b: string): number {
  const split = (v: string): [number[], string | undefined] => {
    const m = v.match(/^([\d.]*)(?:-([^+]*))?/) as RegExpMatchArray;
    return [m[1].split('.').filter(Boolean).map(Number), m[2]];
  };
  const [na, pa] = split(a);
  const [nb, pb] = split(b);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (na[i] ?? 0) - (nb[i] ?? 0);
    if (d !== 0) return d;
  }
  // a release sorts above its own prereleases
  if (pa === pb) return 0;
  if (pa === undefined) return 1;
  if (pb === undefined) return -1;
  return pa < pb ? -1 : 1;
}

function satisfies(version: string, range: string): boolean {
  return range.split(',').every((raw) => {
    const m = raw.trim().match(/^(==|!=|>=|<=|>|<)?\s*(\d[\w.+-]*)$/);
    if (!m) throw new Error(`unsupported version range "${range}" (use an exact version, "latest", or >=,<=,>,<,==,!=)`);
    const c = compareVersions(version, m[2]);
    switch (m[1] ?? '==') {
      case '==': return c === 0;
      case '!=': return c !== 0;
      case '>=': return c >= 0;
      case '<=': return c <= 0;
      case '>': return c > 0;
      default: return c < 0;
    }
  });
}

async function resolvePypiVersion(pkg: string, range: string): Promise<string> {
  const exact = /^\d[\w.+-]*$/.test(range) ? range : undefined;
  const data = await runtime.fetchJson(`https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`);
  if (exact) return exact;
  if (range === 'latest' || range === '*') {
    if (typeof data?.info?.version !== 'string') throw new Error(`could not resolve latest version of ${pkg} on PyPI`);
    return data.info.version;
  }
  const candidates = Object.keys(data?.releases ?? {})
    .filter((v) => /^\d+(\.\d+)*$/.test(v) && satisfies(v, range))
    .sort(compareVersions);
  const best = candidates[candidates.length - 1];
  if (!best) throw new Error(`no PyPI release of ${pkg} satisfies "${range}"`);
  return best;
}

/** Resolves the exact pin (commit or version) for a pinned source. */
export async function resolvePin(decl: DeclaredSource): Promise<LockEntry> {
  const p = decl.parsed;
  let entry: LockEntry;
  switch (p.type) {
    case 'github':
    case 'git':
      entry = { source: decl.spec, commit: resolveGitCommit(p.url, p.ref) };
      break;
    case 'npm':
      entry = { source: decl.spec, version: resolveNpmVersion(p.pkg, p.range) };
      break;
    case 'pypi':
      entry = { source: decl.spec, version: await resolvePypiVersion(p.pkg, p.range) };
      break;
    default:
      throw new Error(`${decl.kind}.${decl.name}: ${p.type} sources have no pin`);
  }
  const problem = validEntry(entry);
  if (problem) throw new Error(`resolved an unusable pin (${problem})`);
  return entry;
}
