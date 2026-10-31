import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createJunction, ensureDir, isJunctionOrSymlink, isWithin, safeWriteFile } from '../utils/fs.js';
import { getHomeDir, getHubDir } from './detector.js';
import { ensureGitignore, readManagedIgnoreBlock, updateManagedIgnoreBlock } from './git-sync.js';
import { loadManifest, setDeclaredSource } from './manifest.js';
import { readJsonSafely, type McpServerConfig } from './mcp-sync.js';
import { ignoredNames } from './local.js';
import {
  emptyLock,
  isPinned,
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

const SKIP_HASH = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', '.venv', '__pycache__', '.next']);

function hashDir(dir: string): string {
  const hash = createHash('sha256');
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP_HASH.has(entry.name)) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) hash.update(path.relative(dir, full) + '\0').update(fs.readFileSync(full));
    }
  };
  walk(dir);
  return hash.digest('hex');
}

/** The state an up-to-date install has: the commit/version, plus build string and (local) source hash. */
function desiredState(hub: string, decl: DeclaredSource, pin?: LockEntry): string | undefined {
  const p = decl.parsed;
  if (p.type === 'github' || p.type === 'git') return `${pin?.commit}|${p.build ?? ''}`;
  if (p.type === 'npm') return pin?.version;
  if (p.type === 'local' && p.build) return `${p.build}|${hashDir(localMcpDir(hub, decl.name))}`;
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
    if (isPinned(d) && entry) out[d.kind][d.name] = entry;
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
export async function planInstall(hubDir?: string): Promise<InstallPlan> {
  const hub = hubDir || getHubDir();
  const { sources, errors: manifestErrors } = loadDeclaredSources(hub);
  const { lock: loaded, invalid } = loadLockChecked(hub);
  const lock = emptyLock();
  const actions: InstallAction[] = [];
  const errors: InstallProblem[] = manifestErrors.map((message) => ({ item: 'agenthub.json', message }));
  const warnings: string[] = [];
  const servers = hubMcpServers(hub);

  for (const decl of sources) {
    const item = itemLabel(decl.kind, decl.name);
    const p = decl.parsed;
    try {
      const bad = invalid[`${decl.kind}.${decl.name}`];
      if (bad) throw new Error(bad);

      let pin: LockEntry | undefined;
      if (isPinned(decl)) {
        const existing = loaded[decl.kind][decl.name];
        const usable = existing && sameSource(existing.source, decl.spec) && pinOf(existing) !== undefined;
        pin = usable ? { ...existing, source: decl.spec } : await resolvePin(decl);
        lock[decl.kind][decl.name] = pin;
      }

      if (decl.kind === 'mcp' && p.type !== 'npm' && p.type !== 'pypi' && !(decl.name in servers)) {
        warnings.push(`${item} is declared but has no entry in mcp/servers.json`);
      }

      // Queues an action unless the item is already installed at the desired state.
      // probe: path whose absence means "not installed"; without one, the recorded state decides.
      const add = (commands: string[], probe: string | undefined, tools: string[] = []): void => {
        const state = desiredState(hub, decl, pin);
        const recorded = recordedState(hub, decl);
        const exists = probe === undefined ? recorded !== undefined : fs.existsSync(probe);
        if (exists && recorded === state) return;
        for (const tool of tools) {
          const missing = toolMissing(tool);
          if (missing) throw new Error(missing);
        }
        actions.push({ item: decl.name, kind: decl.kind, type: p.type, commands, reason: exists || recorded !== undefined ? 'outdated' : 'missing', decl, pin });
      };

      switch (p.type) {
        case 'local': {
          const dir = decl.kind === 'skills' ? path.join(hub, 'skills', decl.name) : localMcpDir(hub, decl.name);
          if (!isDir(dir)) throw new Error(`declared "local" but ${relTo(hub, dir)}/ does not exist`);
          if (p.build) add([`${p.build}  (in ${relTo(hub, dir)})`], undefined);
          break;
        }
        case 'github':
        case 'git': {
          const dir = vendorDir(hub, decl.kind, decl.name);
          const line = gitSteps(p.url, pin?.commit as string, p.build).map(fmt).join(' && ');
          add([`${line}  (in ${relTo(hub, dir)})`], decl.kind === 'skills' ? (skillTarget(hub, decl) as string) : dir, ['git']);
          break;
        }
        case 'npm': {
          if (decl.kind === 'mcp') break;
          const line = npmSteps(p.pkg, pin?.version as string).map(fmt).join(' && ');
          add([`${line}  (into ${relTo(hub, vendorDir(hub, decl.kind, decl.name))})`], skillTarget(hub, decl) as string, ['npm', 'tar']);
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
            reason: p.install ? 'check' : 'manual',
            decl,
          });
          break;
      }
    } catch (err) {
      errors.push({ item, message: (err as Error).message });
    }
  }

  for (const n of ignoredNames(hub, 'mcp')) if (loaded.mcp[n]) lock.mcp[n] = loaded.mcp[n];
  return { hub, actions, errors, warnings, lock };
}

/** Human-readable plan: every command that will run, per item. */
export function describePlan(plan: InstallPlan): string[] {
  const lines: string[] = [];
  for (const a of plan.actions) {
    lines.push(`${actionLabel(a)} [${a.reason}]`);
    for (const c of a.commands) lines.push(`    ${c}`);
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
  if (!isBareHub(plan.hub)) saveLock(plan.hub, plan.lock);
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
  spec: string,
  commit: string,
  skillDir: string
): void {
  const decl = parseSourceSpec('skills', name, spec);
  const pin = { source: decl.spec, commit };
  const target = skillTarget(hub, decl) as string;
  fs.rmSync(vendorDir(hub, 'skills', name), { recursive: true, force: true });
  ensureDir(path.dirname(target));
  fs.cpSync(skillDir, target, { recursive: true });
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
