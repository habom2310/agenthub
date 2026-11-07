import fs from 'node:fs';
import path from 'node:path';
import { createJunction, ensureDir, isJunctionOrSymlink, isWithin, safeWriteFile } from '../utils/fs.js';
import { getHomeDir, getHubDir } from './detector.js';
import { ensureGitignore, readManagedIgnoreBlock, updateManagedIgnoreBlock } from './git-sync.js';
import type { CommandRef } from './approvals.js';
import { BUILD_HASH_SKIP, hashEntries, hashFolder, hashSkill } from './hash.js';
import { loadManifest, setDeclaredSource, type SourceSpec } from './manifest.js';
import { readJsonSafely, type McpServerConfig } from './mcp-sync.js';
import { ignoredNames } from './local.js';
import {
  emptyLock,
  isLocalBuild,
  isPinned,
  serializeLock,
  loadDeclaredSources,
  loadLock,
  loadLockChecked,
  lockPath,
  parseSourceSpec,
  pinOf,
  resolvePin,
  runtime,
  runTool,
  sameSource,
  sameSpec,
  saveLock,
  type DeclaredSource,
  type LockEntry,
  type LockFile,
  type SourceKind,
} from './sources.js';

export interface InstallAction {
  item: string;
  kind: SourceKind;
  type: DeclaredSource['parsed']['type'];
  /** Exact commands that will run, one display line each */
  commands: string[];
  /** Per display line, the commands on it that need approval (same length as `commands`) */
  refs: CommandRef[][];
  /** check/manual: a custom item whose state is only known once its check runs */
  reason: 'missing' | 'outdated' | 'check' | 'manual';
  decl: DeclaredSource;
  pin?: LockEntry;
}

export interface InstallProblem {
  item: string;
  message: string;
}

export interface InstallPlan {
  hub: string;
  actions: InstallAction[];
  errors: InstallProblem[];
  warnings: string[];
  lock: LockFile;
  /** Frozen lockfile: running the plan must not change agenthub.lock.json, so it is never saved */
  frozen: boolean;
}

export interface PlanOptions {
  frozen?: boolean;
}

export interface InstallResult {
  /** Items agenthub actually installed or built */
  installed: string[];
  /** Custom items whose check passed, so nothing ran */
  already: string[];
  /** Check failed and no install command is declared: the user installs it */
  manual: InstallProblem[];
  failed: InstallProblem[];
}

/** One command: an argv run without a shell, or a shell line from the manifest. */
interface Step {
  tool?: string;
  args?: string[];
  shell?: string;
}

const fmt = (s: Step): string => s.shell ?? [s.tool, ...(s.args ?? [])].join(' ');

export const itemLabel = (kind: SourceKind, name: string): string => `${kind === 'skills' ? 'skill' : 'mcp'} ${name}`;
export const actionLabel = (a: InstallAction): string => itemLabel(a.kind, a.item);

const vendorDir = (hub: string, kind: SourceKind, name: string): string => path.join(hub, 'vendor', kind, name);
const stateFile = (hub: string, kind: SourceKind, name: string): string =>
  path.join(hub, 'vendor', '.pins', `${kind}-${name}`);
const localMcpDir = (hub: string, name: string): string => path.join(hub, 'mcp', 'servers', name);
const relTo = (hub: string, p: string): string => path.relative(hub, p).replace(/\\/g, '/') || '.';

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Dot-directory places where tools keep their own skills; a custom skill path may point inside them. */
export const TOOL_SKILL_DIRS = ['~/.local/share/<tool>/skills', '~/.claude/plugins', '~/.agents/skills'];
const TOOL_SKILL_RE = [/^\.local\/share\/[^/]+\/skills\/.+/, /^\.claude\/plugins\/.+/, /^\.agents\/skills\/.+/];

/** realpath of the nearest existing ancestor plus the missing rest, so links are followed before any check. */
function realish(p: string): string {
  let cur = path.resolve(p);
  const rest: string[] = [];
  while (!fs.existsSync(cur)) {
    const up = path.dirname(cur);
    if (up === cur) return path.resolve(p);
    rest.unshift(path.basename(cur));
    cur = up;
  }
  return path.join(fs.realpathSync(cur), ...rest);
}

/**
 * Resolves a custom skill path: "~" expands to home, relative paths are relative
 * to the hub. Symlinks are followed first. The real path must be inside the hub, or
 * inside home but not home itself and not under a top-level dot-directory such as
 * ~/.ssh (except the skill folders in TOOL_SKILL_DIRS). A folder that already exists
 * must hold a SKILL.md.
 */
function resolveCustomPath(hub: string, raw: string): string {
  const rawHome = path.resolve(getHomeDir());
  const base = raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\') ? rawHome : hub;
  const resolved = path.resolve(base, raw.replace(/^~[\\/]?/, ''));
  const home = realish(rawHome);
  const real = realish(resolved);
  const rel = path.relative(home, real).split(path.sep).join('/');
  const inHome = real !== home && isWithin(home, real);
  const topDot = rel.split('/')[0].startsWith('.');
  const toolDir = TOOL_SKILL_RE.some((re) => re.test(rel));
  if (!(isWithin(realish(hub), real) || (inHome && (!topDot || toolDir)))) {
    throw new Error(
      `path "${raw}" must be inside the hub, or inside your home folder (not home itself or a dot-directory other than ${TOOL_SKILL_DIRS.join(', ')})`
    );
  }
  if (isDir(real) && !fs.existsSync(path.join(real, 'SKILL.md'))) throw new Error(`path "${raw}" has no SKILL.md`);
  return resolved;
}

/** Folder a declared skill resolves to once installed, or null for local skills. */
export function skillTarget(hub: string, decl: DeclaredSource): string | null {
  const p = decl.parsed;
  switch (p.type) {
    case 'github':
    case 'git':
    case 'npm':
      return path.join(vendorDir(hub, 'skills', decl.name), p.subpath ?? '');
    case 'custom':
      return p.path ? resolveCustomPath(hub, p.path) : null;
    default:
      return null;
  }
}

// ---- install state: what a vendored item was last installed from ----

/** cpSync filter for skills taken from a checkout: no .git, and no symlinks (they could point anywhere). */
export const copyable = (src: string): boolean => path.basename(src) !== '.git' && !fs.lstatSync(src).isSymbolicLink();

/**
 * Hash of the sources of a local MCP build. In a git repo that is what git tracks plus
 * what it does not ignore (a fixed git command, nothing the hub declares); otherwise
 * the folder minus the usual build output folders.
 */
export function localBuildHash(hub: string, name: string): string {
  const dir = localMcpDir(hub, name);
  const res = runtime.spawn('git', ['ls-files', '-co', '--exclude-standard', '-z'], dir);
  if (res.status === 0 && !res.error) {
    const rels = [...new Set(res.stdout.split('\0').filter(Boolean))].filter((rel) => {
      try {
        const st = fs.lstatSync(path.join(dir, rel));
        return st.isFile() || st.isSymbolicLink();
      } catch {
        return false; // tracked but deleted
      }
    });
    if (rels.length > 0) return hashEntries(dir, rels);
  }
  return hashFolder(dir, BUILD_HASH_SKIP);
}

/** A vendored skill (git/github/npm): its folder is what the lock hash covers. */
function vendoredSkillDir(hub: string, decl: DeclaredSource): string | null {
  return decl.kind === 'skills' && ['github', 'git', 'npm'].includes(decl.parsed.type) ? skillTarget(hub, decl) : null;
}

/** True when a vendored skill's folder on disk differs from the hash in its lock entry. */
export function modifiedLocally(hub: string, decl: DeclaredSource, entry: LockEntry | undefined): boolean {
  const dir = vendoredSkillDir(hub, decl);
  if (!dir || !entry?.hash || !isDir(dir)) return false;
  return hashSkill(dir) !== entry.hash;
}

const short = (hash: string): string => hash.slice(0, 12);

/** After a fetch: the content must match the locked hash; a lock entry without one records it. */
function verifyHash(a: InstallAction, dir: string): void {
  if (a.kind !== 'skills' || !a.pin) return;
  const actual = hashSkill(dir);
  if (a.pin.hash === undefined) a.pin.hash = actual;
  else if (a.pin.hash !== actual) {
    throw new Error(`content differs from lock (locked ${short(a.pin.hash)}, fetched ${short(actual)}); the source changed, run: agenthub update`);
  }
}

/** The state an up-to-date install has: the commit/version, plus build string and (local) source hash. */
function desiredState(hub: string, decl: DeclaredSource, pin?: LockEntry): string | undefined {
  const p = decl.parsed;
  if (p.type === 'github' || p.type === 'git') return `${pin?.commit}|${p.build ?? ''}`;
  if (p.type === 'npm') return pin?.version;
  if (p.type === 'local' && p.build) return `${p.build}|${localBuildHash(hub, decl.name)}`;
  return undefined;
}

function recordedState(hub: string, decl: DeclaredSource): string | undefined {
  try {
    return fs.readFileSync(stateFile(hub, decl.kind, decl.name), 'utf-8');
  } catch {
    return undefined;
  }
}

function recordState(hub: string, decl: DeclaredSource, pin?: LockEntry): void {
  const state = desiredState(hub, decl, pin);
  if (state !== undefined) safeWriteFile(stateFile(hub, decl.kind, decl.name), state);
}

// ---- commands: one place builds both the displayed line and what runs ----

function gitSteps(url: string, commit: string, build?: string): Step[] {
  return [
    { tool: 'git', args: ['init', '-q'] },
    { tool: 'git', args: ['fetch', '-q', '--depth', '1', '--', url, commit] },
    { tool: 'git', args: ['checkout', '-q', '--detach', commit] },
    ...(build ? [{ shell: build }] : []),
  ];
}

function npmSteps(pkg: string, version: string): Step[] {
  return [
    { tool: 'npm', args: ['pack', `${pkg}@${version}`, '--silent'] },
    { tool: 'tar', args: ['-xzf', '<tarball>', '-C', 'extracted', '--strip-components=1'] },
  ];
}

function toolMissing(tool: string): string | null {
  const res = runtime.spawn(tool, ['--version']);
  return res.error?.code === 'ENOENT' ? `'${tool}' is not installed or not in PATH` : null;
}

function hubMcpServers(hub: string): Record<string, McpServerConfig> {
  const read = readJsonSafely<{ mcpServers?: Record<string, McpServerConfig> }>(path.join(hub, 'mcp', 'servers.json'));
  const servers = read.data.mcpServers;
  return servers && typeof servers === 'object' && !Array.isArray(servers) ? servers : {};
}

/** Lock entries for declared, pinned items only. */
function prunedLock(lock: LockFile, sources: DeclaredSource[], hub: string): LockFile {
  const out = emptyLock();
  // pins of locally ignored servers stay in the shared lockfile
  for (const n of ignoredNames(hub, 'mcp')) if (lock.mcp[n]) out.mcp[n] = lock.mcp[n];
  for (const d of sources) {
    const entry = lock[d.kind][d.name];
    if ((isPinned(d) || isLocalBuild(d)) && entry) out[d.kind][d.name] = entry;
  }
  return out;
}

/**
 * A hub that declares no skills or mcp and has no lockfile: installing has
 * nothing to do and must not create files in it.
 */
export function isBareHub(hubDir?: string): boolean {
  const hub = hubDir || getHubDir();
  const manifest = loadManifest(hub);
  const declares = manifest !== null && ('skills' in manifest || 'mcp' in manifest);
  return !declares && !fs.existsSync(lockPath(hub));
}

export function hasDeclaredSources(hubDir?: string): boolean {
  const { sources, errors } = loadDeclaredSources(hubDir || getHubDir());
  return sources.length > 0 || errors.length > 0;
}

/**
 * Compares what the hub declares with what is installed and returns the
 * commands needed to close the gap. Resolves missing lockfile pins but runs
 * nothing the hub declares (custom check/install/build): those run after
 * approval, in runInstall. Nothing is written here.
 */
export async function planInstall(hubDir?: string, options: PlanOptions = {}): Promise<InstallPlan> {
  const hub = hubDir || getHubDir();
  const frozen = Boolean(options.frozen);
  const { sources, errors: manifestErrors } = loadDeclaredSources(hub);
  const { lock: loaded, invalid } = loadLockChecked(hub);
  const lock = emptyLock();
  const actions: InstallAction[] = [];
  const errors: InstallProblem[] = manifestErrors.map((message) => ({ item: 'agenthub.json', message }));
  const warnings: string[] = [];
  const servers = hubMcpServers(hub);
  let frozenViolation = false;
  const notFrozen = (what: string): Error => {
    frozenViolation = true;
    return new Error(`${what} (frozen lockfile: run agenthub install --no-frozen-lockfile and commit agenthub.lock.json)`);
  };

  for (const decl of sources) {
    const item = itemLabel(decl.kind, decl.name);
    const p = decl.parsed;
    const ref = (role: string, text: string): CommandRef => ({ kind: decl.kind, item: decl.name, role, text });
    try {
      const bad = invalid[`${decl.kind}.${decl.name}`];
      if (bad) throw new Error(bad);

      let pin: LockEntry | undefined;
      if (isPinned(decl)) {
        const existing = loaded[decl.kind][decl.name];
        const usable = existing && sameSource(existing.source, decl.spec) && pinOf(existing) !== undefined;
        if (!usable && frozen) throw notFrozen('has no pin in agenthub.lock.json');
        // an equivalent spelling keeps the entry as it is; a changed subpath is other content, so its hash goes
        const same = Boolean(usable && sameSpec(existing.source, decl.spec));
        pin = usable ? { ...existing, source: same ? existing.source : decl.spec } : await resolvePin(decl);
        if (usable && !same) delete pin.hash;
        lock[decl.kind][decl.name] = pin;
      } else if (isLocalBuild(decl) && isDir(localMcpDir(hub, decl.name))) {
        lock[decl.kind][decl.name] = { source: decl.spec, hash: localBuildHash(hub, decl.name) };
      }
      if (frozen && pin && decl.kind === 'skills' && !pin.hash && vendoredSkillDir(hub, decl)) {
        throw notFrozen('has no content hash in agenthub.lock.json');
      }

      if (decl.kind === 'mcp' && p.type !== 'npm' && p.type !== 'pypi' && !(decl.name in servers)) {
        warnings.push(`${item} is declared but has no entry in mcp/servers.json`);
      }

      // Queues an action unless the item is already installed at the desired state.
      // probe: path whose absence means "not installed"; without one, the recorded state decides.
      const add = (commands: string[], refs: CommandRef[], probe: string | undefined, tools: string[] = []): void => {
        const state = desiredState(hub, decl, pin);
        const recorded = recordedState(hub, decl);
        const exists = probe === undefined ? recorded !== undefined : fs.existsSync(probe);
        if (exists && recorded === state) return;
        for (const tool of tools) {
          const missing = toolMissing(tool);
          if (missing) throw new Error(missing);
        }
        actions.push({ item: decl.name, kind: decl.kind, type: p.type, commands, refs: [refs], reason: exists || recorded !== undefined ? 'outdated' : 'missing', decl, pin });
      };

      switch (p.type) {
        case 'local': {
          const dir = decl.kind === 'skills' ? path.join(hub, 'skills', decl.name) : localMcpDir(hub, decl.name);
          if (!isDir(dir)) throw new Error(`declared "local" but ${relTo(hub, dir)}/ does not exist`);
          if (p.build) add([`${p.build}  (in ${relTo(hub, dir)})`], [ref('build', `${p.build}  [sources sha256:${localBuildHash(hub, decl.name)}]`)], undefined);
          break;
        }
        case 'github':
        case 'git': {
          const dir = vendorDir(hub, decl.kind, decl.name);
          const fetch = gitSteps(p.url, pin?.commit as string).map(fmt).join(' && ');
          const line = gitSteps(p.url, pin?.commit as string, p.build).map(fmt).join(' && ');
          const refs = [ref('fetch', fetch), ...(p.build ? [ref('build', `${p.build}  [commit ${pin?.commit}]`)] : [])];
          add([`${line}  (in ${relTo(hub, dir)})`], refs, decl.kind === 'skills' ? (skillTarget(hub, decl) as string) : dir, ['git']);
          break;
        }
        case 'npm': {
          if (decl.kind === 'mcp') break;
          const line = npmSteps(p.pkg, pin?.version as string).map(fmt).join(' && ');
          add([`${line}  (into ${relTo(hub, vendorDir(hub, decl.kind, decl.name))})`], [ref('fetch', line)], skillTarget(hub, decl) as string, ['npm', 'tar']);
          break;
        }
        case 'pypi': {
          const missing = toolMissing('uvx');
          if (missing) throw new Error(`${missing} (install uv: https://docs.astral.sh/uv/)`);
          break;
        }
        case 'custom':
          skillTarget(hub, decl); // validates the path
          actions.push({
            item: decl.name,
            kind: decl.kind,
            type: p.type,
            commands: p.install
              ? [`check:   ${p.check}`, `install: ${p.install}  (only if check fails)`]
              : [`check:   ${p.check}`, 'no install command: if the check fails, install it yourself, then re-run'],
            refs: p.install ? [[ref('check', p.check)], [ref('install', p.install)]] : [[ref('check', p.check)], []],
            reason: p.install ? 'check' : 'manual',
            decl,
          });
          break;
      }

      // a lock written before hashes existed: record the folder as installed (an install records it itself)
      const vendored = vendoredSkillDir(hub, decl);
      const queued = actions.some((a) => a.item === decl.name && a.kind === decl.kind);
      if (pin && !pin.hash && !frozen && !queued && vendored && isDir(vendored)) pin.hash = hashSkill(vendored);
    } catch (err) {
      errors.push({ item, message: (err as Error).message });
    }
  }

  for (const n of ignoredNames(hub, 'mcp')) if (loaded.mcp[n]) lock.mcp[n] = loaded.mcp[n];

  if (frozen) {
    const before = JSON.parse(serializeLock(loaded)) as LockFile;
    const after = JSON.parse(serializeLock(lock)) as LockFile;
    const changed = (['skills', 'mcp'] as const).flatMap((k) =>
      [...new Set([...Object.keys(before[k]), ...Object.keys(after[k])])]
        .filter((n) => JSON.stringify(before[k][n]) !== JSON.stringify(after[k][n]))
        .map((n) => `${k}.${n}`)
    );
    if (changed.length > 0) {
      frozenViolation = true;
      errors.push({ item: 'agenthub.lock.json', message: `would change (${changed.join(', ')}); frozen lockfile: run agenthub install --no-frozen-lockfile and commit it` });
    }
    // nothing installs from a lockfile that does not match the hub
    if (frozenViolation) actions.length = 0;
  }
  return { hub, actions, errors, warnings, lock, frozen };
}

/** Human-readable plan: every command that will run, per item. `approved` marks commands approved before. */
export function describePlan(plan: InstallPlan, approved: (ref: CommandRef) => boolean = () => false): string[] {
  const lines: string[] = [];
  for (const a of plan.actions) {
    lines.push(`${actionLabel(a)} [${a.reason}]`);
    a.commands.forEach((c, i) => {
      const refs = a.refs[i] ?? [];
      lines.push(`    ${c}${refs.length > 0 && refs.every(approved) ? '  (approved before)' : ''}`);
    });
  }
  return lines;
}

function tail(text: string): string {
  return text.trim().split('\n').slice(-5).join('\n');
}

function shellOrThrow(cmdline: string, cwd: string, what: string): void {
  const res = runtime.shell(cmdline, cwd);
  if (res.error || res.status !== 0) {
    throw new Error(`${what} failed: ${tail(res.stderr || res.stdout || res.error?.message || `exit code ${res.status}`)}`);
  }
}

function swapIn(tmp: string, finalDir: string): void {
  fs.rmSync(finalDir, { recursive: true, force: true });
  fs.renameSync(tmp, finalDir);
}

/**
 * The subpath must be a folder inside the checkout. A symlink (or a link along the
 * way) that leads outside it is rejected, since it would expose files that are not
 * part of the source.
 */
export function checkSubpath(root: string, subpath: string | undefined, what: string): void {
  if (!subpath) return;
  const target = path.join(root, subpath);
  if (!isDir(target)) throw new Error(`subpath "${subpath}" not found in ${what}`);
  let real: string;
  let realRoot: string;
  try {
    real = fs.realpathSync(target);
    realRoot = fs.realpathSync(root);
  } catch {
    throw new Error(`subpath "${subpath}" not found in ${what}`);
  }
  if (!isWithin(realRoot, real)) throw new Error(`subpath "${subpath}" in ${what} leads outside the checkout`);
}

function installFromGit(hub: string, a: InstallAction): void {
  const p = a.decl.parsed as Extract<DeclaredSource['parsed'], { type: 'github' | 'git' }>;
  const commit = a.pin?.commit;
  if (!commit) throw new Error('no locked commit');
  const finalDir = vendorDir(hub, a.kind, a.item);
  const tmp = `${finalDir}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  ensureDir(tmp);
  try {
    for (const step of gitSteps(p.url, commit)) {
      try {
        runTool(step.tool as string, step.args as string[], tmp);
      } catch (err) {
        if (!step.args?.includes('--depth')) throw err;
        // some servers refuse a shallow fetch by SHA
        runTool('git', ['fetch', '-q', '--', p.url, '+refs/heads/*:refs/remotes/origin/*', '+refs/tags/*:refs/tags/*'], tmp);
      }
    }
    checkSubpath(tmp, p.subpath, `${p.url}@${commit.slice(0, 12)}`);
    verifyHash(a, path.join(tmp, p.subpath ?? ''));
    swapIn(tmp, finalDir);
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  if (p.build) shellOrThrow(p.build, finalDir, 'build');
}

function installFromNpm(hub: string, a: InstallAction): void {
  const p = a.decl.parsed as Extract<DeclaredSource['parsed'], { type: 'npm' }>;
  const version = a.pin?.version;
  if (!version) throw new Error('no locked version');
  const finalDir = vendorDir(hub, a.kind, a.item);
  const work = `${finalDir}.tmp-${process.pid}`;
  const extracted = path.join(work, 'extracted');
  fs.rmSync(work, { recursive: true, force: true });
  ensureDir(extracted);
  try {
    const [pack, untar] = npmSteps(p.pkg, version);
    const tarball = runTool('npm', pack.args as string[], work).trim().split(/\r?\n/).pop() as string;
    runTool('tar', (untar.args as string[]).map((x) => (x === '<tarball>' ? tarball : x)), work);
    checkSubpath(extracted, p.subpath, `${p.pkg}@${version}`);
    verifyHash(a, path.join(extracted, p.subpath ?? ''));
    swapIn(extracted, finalDir);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

type ActionOutcome = 'installed' | 'already' | 'manual';

function runAction(hub: string, a: InstallAction): ActionOutcome {
  const p = a.decl.parsed;
  switch (p.type) {
    case 'github':
    case 'git':
      installFromGit(hub, a);
      break;
    case 'npm':
      installFromNpm(hub, a);
      break;
    case 'local':
      shellOrThrow(p.build as string, localMcpDir(hub, a.item), 'build');
      break;
    case 'custom':
      // check first: an already-installed tool is left alone
      if (runtime.shell(p.check, hub).status === 0) return 'already';
      if (!p.install) return 'manual';
      shellOrThrow(p.install, hub, 'install');
      if (runtime.shell(p.check, hub).status !== 0) throw new Error('install ran but its check command still fails');
      return 'installed';
    default:
      return 'installed';
  }
  recordState(hub, a.decl, a.pin);
  return 'installed';
}

/** Runs every planned action. A failure in one item does not stop the others. */
export function runInstall(plan: InstallPlan): InstallResult {
  const installed: string[] = [];
  const already: string[] = [];
  const manual: InstallProblem[] = [];
  const failed: InstallProblem[] = [];
  for (const a of plan.actions) {
    try {
      const outcome = runAction(plan.hub, a);
      if (outcome === 'installed') installed.push(actionLabel(a));
      else if (outcome === 'already') already.push(actionLabel(a));
      else manual.push({ item: actionLabel(a), message: `install it yourself, then re-run (check: ${(a.decl.parsed as { check: string }).check})` });
    } catch (err) {
      failed.push({ item: actionLabel(a), message: (err as Error).message });
    }
  }
  if (!plan.frozen && !isBareHub(plan.hub)) saveLock(plan.hub, plan.lock);
  failed.push(...finalizeInstall(plan.hub, [...failed, ...manual].map((f) => f.item)));
  return { installed, already, manual, failed };
}

/** Keeps generated npx/uvx entries in servers.json on the locked version. */
function syncGeneratedMcp(hub: string, sources: DeclaredSource[], lock: LockFile): InstallProblem[] {
  const file = path.join(hub, 'mcp', 'servers.json');
  const read = readJsonSafely<{ mcpServers?: Record<string, McpServerConfig> }>(file);
  if (!read.success) return [{ item: 'mcp/servers.json', message: 'unparseable, not updated' }];
  const servers = { ...hubMcpServers(hub) };
  let changed = false;

  for (const d of sources) {
    const p = d.parsed;
    const version = lock.mcp[d.name]?.version;
    if (d.kind !== 'mcp' || (p.type !== 'npm' && p.type !== 'pypi') || !version) continue;
    const command = p.type === 'npm' ? 'npx' : 'uvx';
    const spec = p.type === 'npm' ? `${p.pkg}@${version}` : `${p.pkg}==${version}`;
    const sep = p.type === 'npm' ? '@' : '==';
    const existing = servers[d.name];
    if (!existing) {
      servers[d.name] = { command, args: p.type === 'npm' ? ['-y', spec] : [spec] };
      changed = true;
    } else if (existing.command === command && Array.isArray(existing.args)) {
      const i = existing.args.findIndex((a) => a === p.pkg || (typeof a === 'string' && a.startsWith(p.pkg + sep)));
      if (i >= 0 && existing.args[i] !== spec) {
        servers[d.name] = { ...existing, args: existing.args.map((a, j) => (j === i ? spec : a)) };
        changed = true;
      }
    }
  }

  if (changed) safeWriteFile(file, JSON.stringify({ ...read.data, mcpServers: servers }, null, 2) + '\n');
  return [];
}

/**
 * Brings the hub in line with its declarations, without running any install
 * command: symlinks installed skills into skills/, lists them in the .gitignore
 * managed block, and writes generated MCP entries. A declared skill whose folder
 * is missing is reported, except for items named in `skipItems` (already reported).
 * Safe to run repeatedly.
 */
export function finalizeInstall(hubDir?: string, skipItems: string[] = []): InstallProblem[] {
  const hub = hubDir || getHubDir();
  const { sources } = loadDeclaredSources(hub);
  const lock = loadLock(hub);
  const skillsDir = path.join(hub, 'skills');
  const previouslyManaged = new Set(readManagedIgnoreBlock(hub).map((e) => e.replace(/^\/skills\//, '')));
  // nothing declared, nothing locked, nothing managed before: leave the hub as it is
  if (isBareHub(hub) && previouslyManaged.size === 0) return [];
  const problems = syncGeneratedMcp(hub, sources, lock);
  const linked = new Set<string>();
  const ignoredSkills = ignoredNames(hub, 'skills');

  for (const d of sources) {
    if (d.kind !== 'skills' || d.parsed.type === 'local') continue;
    linked.add(d.name);
    const item = itemLabel(d.kind, d.name);
    if (skipItems.includes(item)) continue;
    try {
      const target = skillTarget(hub, d);
      if (!target || !isDir(target)) {
        problems.push({ item, message: `${target ? relTo(hub, target) : 'skill folder'} is not installed (run: agenthub install)` });
      } else if (d.parsed.type === 'custom' && !fs.existsSync(path.join(target, 'SKILL.md'))) {
        problems.push({ item, message: `${relTo(hub, target)} has no SKILL.md` });
      } else if (!createJunction(target, path.join(skillsDir, d.name))) {
        problems.push({
          item,
          message: `cannot link skills/${d.name}: a real folder is already there (remove it, or declare the skill as "local")`,
        });
      }
    } catch (err) {
      problems.push({ item, message: (err as Error).message });
    }
  }

  // Drop links for skills that are no longer declared: vendored ones, and any link a previous run listed
  if (isDir(skillsDir)) {
    const vendorRoot = path.join(hub, 'vendor');
    for (const entry of fs.readdirSync(skillsDir)) {
      const link = path.join(skillsDir, entry);
      if (linked.has(entry) || ignoredSkills.has(entry) || !isJunctionOrSymlink(link)) continue;
      const dest = path.resolve(skillsDir, fs.readlinkSync(link));
      if (previouslyManaged.has(entry) || isWithin(vendorRoot, dest)) fs.unlinkSync(link);
    }
  }

  ensureGitignore(hub);
  updateManagedIgnoreBlock(hub, [...linked].map((n) => `/skills/${n}`));
  return problems;
}

/**
 * Records a skill added from a remote repo checkout as a vendored github/git
 * skill: copies it into vendor/, pins the commit, and declares it in agenthub.json.
 */
export function vendorCheckedOutSkill(
  hub: string,
  name: string,
  spec: SourceSpec,
  commit: string,
  skillDir: string
): void {
  const decl = parseSourceSpec('skills', name, spec);
  const target = skillTarget(hub, decl) as string;
  fs.rmSync(vendorDir(hub, 'skills', name), { recursive: true, force: true });
  ensureDir(path.dirname(target));
  fs.cpSync(skillDir, target, { recursive: true, filter: copyable });
  const pin: LockEntry = { source: decl.spec, commit, hash: hashSkill(target) };
  recordState(hub, decl, pin);
  const lock = loadLock(hub);
  lock.skills[name] = pin;
  saveLock(hub, lock);
  setDeclaredSource(hub, 'skills', name, spec);
}

export interface PinChange {
  item: string;
  from?: string;
  to: string;
}

/**
 * Re-resolves lockfile pins (all pinned items, or only the named ones) and
 * saves the lockfile. Installing the new pins is left to planInstall.
 */
export async function updatePins(
  hubDir?: string,
  names: string[] = []
): Promise<{ changes: PinChange[]; errors: InstallProblem[] }> {
  const hub = hubDir || getHubDir();
  const { sources } = loadDeclaredSources(hub);
  const lock = loadLock(hub);
  const changes: PinChange[] = [];
  const errors: InstallProblem[] = [];

  for (const name of names) {
    if (!sources.some((d) => d.name === name && isPinned(d))) {
      errors.push({ item: name, message: 'not a declared skill or MCP server with a pinned source' });
    }
  }
  for (const decl of sources) {
    if (!isPinned(decl) || (names.length > 0 && !names.includes(decl.name))) continue;
    try {
      const next = await resolvePin(decl);
      const prev = lock[decl.kind][decl.name];
      if (prev?.hash && pinOf(prev) === pinOf(next) && prev.source === next.source) next.hash = prev.hash;
      if (pinOf(prev) !== pinOf(next) || prev?.source !== next.source) {
        changes.push({ item: itemLabel(decl.kind, decl.name), from: pinOf(prev), to: pinOf(next) as string });
      }
      lock[decl.kind][decl.name] = next;
    } catch (err) {
      errors.push({ item: itemLabel(decl.kind, decl.name), message: (err as Error).message });
    }
  }
  saveLock(hub, prunedLock(lock, sources, hub));
  return { changes, errors };
}
