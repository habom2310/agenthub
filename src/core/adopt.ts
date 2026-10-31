import fs from 'node:fs';
import path from 'node:path';
import { findExecutable, getUtcTimestamp, isJunctionOrSymlink, isWithin, safeWriteFile, ensureDir } from '../utils/fs.js';
import { getHomeDir, getHubDir, windsurfDirFor } from './detector.js';
import { isLinkTo } from './linker.js';
import { setDeclaredSource, type SourceSpec } from './manifest.js';
import { MCP_PLATFORMS, MCP_PLATFORM_IDS, isDisabled } from './mcp-platforms.js';
import { contractPaths, expandServerPaths, getMcpStatus, normalizeServerForHub, readJsonSafely, type McpServerConfig } from './mcp-sync.js';
import { ignoredNames } from './local.js';
import { assistantSkillRoots } from './skill-check.js';
import { loadDeclaredSources, parseSourceSpec, type SourceKind } from './sources.js';

/** One way to bring an item under the hub. Nothing in it has been executed. */
export interface AdoptProposal {
  /** Short text: the source it would declare */
  label: string;
  /** The declaration; a custom source has no `install` unless the user (or an inference) supplies one */
  spec: SourceSpec;
  /** Safe to apply without asking: the source was read from the item itself */
  confident: boolean;
  /** Input the user must give before it can be applied (an `install` may be left empty: check-only) */
  needs?: 'install' | 'build';
  /** Copy `from` into the hub at `to`, then move the original into hub/backups/adopt-<ts>/ */
  move?: { from: string; to: string };
  /** Replace this path prefix in the MCP entry with the hub location */
  rewrite?: { from: string; to: string };
  note?: string;
}

export interface AdoptItem {
  kind: SourceKind;
  name: string;
  /** What was found and where, one line each */
  found: string[];
  proposal?: AdoptProposal;
  /** Skills only: the folder is the user's own, move it into hub/skills as "local" */
  selfBuilt?: AdoptProposal;
  /** Nothing to declare; why */
  report?: string;
}

export type AdoptChoice = 'accept' | 'self-built' | 'source' | 'skip';

export interface AdoptPrompter {
  choose(item: AdoptItem, choices: AdoptChoice[]): Promise<AdoptChoice>;
  ask(question: string): Promise<string>;
}

export interface AdoptOptions {
  homeDir?: string;
  hubDir?: string;
  yes?: boolean;
  dryRun?: boolean;
  /** Present when stdin is a TTY and --yes was not given */
  prompter?: AdoptPrompter;
}

export interface AdoptApplied {
  item: string;
  declared: string;
  detail: string[];
}

export interface AdoptReport {
  mode: 'dry-run' | 'preview' | 'auto' | 'interactive';
  items: AdoptItem[];
  applied: AdoptApplied[];
  skipped: Array<{ item: string; reason: string }>;
}

const itemId = (i: Pick<AdoptItem, 'kind' | 'name'>): string => `${i.kind === 'skills' ? 'skill' : 'mcp'} ${i.name}`;

const tilde = (p: string, home: string): string => (isWithin(home, p) && path.resolve(p) !== path.resolve(home) ? '~/' + path.relative(home, p).replace(/\\/g, '/') : p);

/** Escapes for inside double quotes: " \\ $ and backtick, so a name like $(cmd) stays text. */
const dq = (s: string): string => s.replace(/(["\\$`])/g, '\\$1');

const shq = (s: string): string => (/^[\w@%+=:,./~-]+$/.test(s) ? s : `"${dq(s)}"`);

/** A path as a shell word: "$HOME/..." inside the home folder so it works on every machine. */
function shellPath(p: string, home: string): string {
  return isWithin(home, p) && path.resolve(p) !== path.resolve(home) ? `"$HOME/${dq(path.relative(home, p).replace(/\\/g, '/'))}"` : shq(p);
}

// ---- git: read the remote from .git/config, never run git ----

function findGitRoot(start: string, hub: string): string | null {
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git')) && path.resolve(dir) !== path.resolve(hub) && !isWithin(dir, hub)) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function gitConfigFile(root: string): string | null {
  const dotGit = path.join(root, '.git');
  try {
    if (fs.statSync(dotGit).isDirectory()) return path.join(dotGit, 'config');
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf-8'));
    if (!m) return null;
    const gitdir = path.resolve(root, m[1].trim());
    try {
      return path.join(path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf-8').trim()), 'config');
    } catch {
      return path.join(gitdir, 'config');
    }
  } catch {
    return null;
  }
}

export function readRemoteUrl(root: string): string | null {
  return readRemote(root)?.url ?? null;
}

/** origin (or the first remote) from .git/config. */
export function readRemote(root: string): { name: string; url: string } | null {
  const file = gitConfigFile(root);
  if (!file) return null;
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  const remotes = new Map<string, string>();
  let current: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const section = /^\s*\[remote\s+"([^"]+)"\]/.exec(line);
    if (section) current = section[1];
    else if (/^\s*\[/.test(line)) current = null;
    else if (current) {
      const url = /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
      if (url && !remotes.has(current)) remotes.set(current, url[1]);
    }
  }
  const name = remotes.has('origin') ? 'origin' : [...remotes.keys()][0];
  return name ? { name, url: remotes.get(name) as string } : null;
}

/** The git directory and the directory holding refs (they differ in a worktree). */
function gitDirs(root: string): { gitDir: string; commonDir: string } | null {
  const dotGit = path.join(root, '.git');
  try {
    if (fs.statSync(dotGit).isDirectory()) return { gitDir: dotGit, commonDir: dotGit };
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf-8'));
    if (!m) return null;
    const gitDir = path.resolve(root, m[1].trim());
    let commonDir = gitDir;
    try {
      commonDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf-8').trim());
    } catch {
      // not a linked worktree
    }
    return { gitDir, commonDir };
  } catch {
    return null;
  }
}

function resolveRef(dirs: { gitDir: string; commonDir: string }, ref: string, depth = 0): string | null {
  if (depth > 5) return null;
  const read = (p: string): string | null => {
    try {
      return fs.readFileSync(p, 'utf-8').trim();
    } catch {
      return null;
    }
  };
  const value = read(path.join(dirs.gitDir, ref)) ?? read(path.join(dirs.commonDir, ref));
  if (value !== null) {
    if (/^[0-9a-f]{40}$/.test(value)) return value;
    const sym = /^ref:\s*(.+)$/.exec(value);
    return sym ? resolveRef(dirs, sym[1].trim(), depth + 1) : null;
  }
  const packed = read(path.join(dirs.commonDir, 'packed-refs'));
  const hit = packed?.split(/\r?\n/).find((l) => l.endsWith(` ${ref}`) && /^[0-9a-f]{40} /.test(l));
  return hit ? hit.slice(0, 40) : null;
}

/** The checked-out commit and the remote's last fetched HEAD, read from files; git is never run. */
export function readCommits(root: string, remoteName: string): { local?: string; remote?: string } {
  const dirs = gitDirs(root);
  if (!dirs) return {};
  let head: string | null = null;
  try {
    head = fs.readFileSync(path.join(dirs.gitDir, 'HEAD'), 'utf-8').trim();
  } catch {
    return {};
  }
  const local = /^[0-9a-f]{40}$/.test(head) ? head : (resolveRef(dirs, head.replace(/^ref:\s*/, '')) ?? undefined);
  const remote = resolveRef(dirs, `refs/remotes/${remoteName}/HEAD`) ?? undefined;
  return { local, remote };
}

/**
 * The declaration for a checkout: pinned to the local commit when it is known.
 * Confident only when that commit is what the remote was last seen at. Local
 * edits cannot be detected without running git, so the note says so.
 */
function checkoutSpec(root: string, base: string, remoteName: string, home: string): { spec: SourceSpec; confident: boolean; note: string } {
  const { local, remote } = readCommits(root, remoteName);
  const where = `checkout ${tilde(root, home)}`;
  const short = (c: string): string => c.slice(0, 12);
  if (!local) return { spec: base, confident: false, note: `${where}: its commit could not be read, so nothing is pinned; local edits not checked` };
  const spec: SourceSpec = { source: base, ref: local };
  if (remote && remote === local) {
    return { spec, confident: true, note: `${where} at ${short(local)}, same as ${remoteName}; pinned to it; local edits not checked` };
  }
  const why = remote ? `differs from ${remoteName}'s last fetched ${short(remote)}` : `${remoteName}'s commit is unknown (never fetched?)`;
  return { spec, confident: false, note: `${where}: local commit ${short(local)} ${why}; pinned to the local commit, which may not exist on the remote; local edits not checked` };
}

/** Maps a remote URL to a github: or git: source, with credentials removed. Null for local-path remotes. */
export function sourceFromRemote(remote: string): { base: string; host: string } | null {
  let host: string;
  let repoPath: string;
  let clean: string;
  const scp = /^(?:([\w.-]+)@)?([\w.-]+):(?!\/\/)(.+)$/.exec(remote);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(remote) && !/^[A-Za-z]:[\\/]/.test(remote)) {
    host = scp[2];
    repoPath = scp[3];
    clean = `ssh://${scp[1] ? scp[1] + '@' : ''}${host}/${repoPath.replace(/^\/+/, '')}`;
  } else {
    let url: URL;
    try {
      url = new URL(remote);
    } catch {
      return null;
    }
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return null;
    host = url.hostname;
    repoPath = url.pathname.replace(/^\/+/, '');
    const keepUser = url.protocol === 'ssh:' && url.username && !url.password ? `${url.username}@` : '';
    clean = `${url.protocol}//${keepUser}${url.host}${url.pathname}`;
  }
  const gh = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(repoPath);
  if (host.toLowerCase() === 'github.com' && gh) return { base: `github:${gh[1]}/${gh[2]}`, host };
  return { base: `git:${clean}`, host };
}

// ---- skills ----

interface SkillSeen {
  name: string;
  /** Path where it was found (inside an assistant folder or the hub) */
  at: string;
  label: string;
}

const PLUGINS = (home: string): string => path.join(home, '.claude', 'plugins');

/** plugin@marketplace from a path under ~/.claude/plugins, when it follows a known layout. */
export function pluginOfPath(real: string, home: string): string | null {
  const rel = path.relative(PLUGINS(home), real).split(path.sep);
  if (rel[0] === 'cache' && rel.length >= 4) return `${rel[2]}@${rel[1]}`;
  if (rel[0] === 'marketplaces' && rel.length >= 3) {
    const at = rel.indexOf('plugins', 2);
    const plugin = at > 0 ? rel[at + 1] : rel[2];
    return plugin ? `${plugin}@${rel[1]}` : null;
  }
  return null;
}

function realOf(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function scanSkillDirs(home: string, hub: string): SkillSeen[] {
  const out: SkillSeen[] = [];
  const hubSkills = path.join(hub, 'skills');
  const dirs: Array<{ dir: string; label: string }> = [{ dir: hubSkills, label: 'hub' }];
  for (const a of assistantSkillRoots(home)) {
    if (a.linked) dirs.push({ dir: a.linked, label: a.label });
  }
  dirs.push({ dir: path.join(home, '.agents', 'skills'), label: 'Agents' });
  const windsurf = windsurfDirFor(home);
  if (!dirs.some((d) => d.dir === path.join(windsurf, 'skills'))) dirs.push({ dir: path.join(windsurf, 'skills'), label: 'Windsurf' });

  const seenDirs = new Set<string>();
  for (const { dir, label } of dirs) {
    if (label !== 'hub' && isLinkTo(dir, hubSkills)) continue; // its entries are the hub's
    const real = realOf(dir);
    if (!real || seenDirs.has(real)) continue;
    seenDirs.add(real);
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries.sort()) {
      if (name.startsWith('.') || name.endsWith('.old')) continue;
      const at = path.join(dir, name);
      if (!fs.existsSync(path.join(at, 'SKILL.md'))) continue;
      out.push({ name, at, label });
    }
  }
  return out;
}

function skillProposal(seen: SkillSeen[], home: string, hub: string): Pick<AdoptItem, 'proposal' | 'selfBuilt' | 'report'> {
  const hubSkills = path.join(hub, 'skills');
  const first = seen.find((s) => s.label !== 'hub') ?? seen[0];
  const real = realOf(first.at) as string;
  const isLink = isJunctionOrSymlink(first.at);

  const plugin = isWithin(PLUGINS(home), real) ? pluginOfPath(real, home) : null;
  if (isWithin(PLUGINS(home), real)) {
    const base: Pick<AdoptItem, 'report'> = { report: 'Claude Code plugin skill, managed by its plugin system' };
    if (!plugin) return base;
    return {
      ...base,
      proposal: {
        label: `custom (claude plugin install ${plugin})`,
        spec: { install: `claude plugin install ${plugin}`, check: `test -f ${shellPath(path.join(real, 'SKILL.md'), home)}`, path: tilde(real, home) },
        confident: false,
        note: 'optional: lets agenthub re-install the plugin on another machine',
      },
    };
  }

  const root = findGitRoot(real, hub);
  const remote = root ? readRemote(root) : null;
  const mapped = remote ? sourceFromRemote(remote.url) : null;
  if (root && remote && mapped) {
    const sub = path.relative(root, real).replace(/\\/g, '/');
    const source = mapped.base + (sub ? `#${sub}` : '');
    const cs = checkoutSpec(root, source, remote.name, home);
    return { proposal: { label: source, spec: cs.spec, confident: cs.confident, note: cs.note } };
  }

  // a link into something that is not a checkout and not the hub: installed by a tool
  if (isLink && !isWithin(hub, real)) {
    return {
      proposal: {
        label: `custom (check: SKILL.md at ${tilde(real, home)})`,
        spec: { check: `test -f ${shellPath(path.join(real, 'SKILL.md'), home)}`, path: tilde(real, home) },
        confident: false,
        needs: 'install',
        note: 'managed by another tool: add an install command, or leave it check-only (then you install it yourself on a new machine)',
      },
    };
  }
  if (isLink && isWithin(hub, real)) return { report: 'linked into the hub already (vendored or hub-managed)' };

  const dest = path.join(hubSkills, first.name);
  const inHub = path.resolve(path.dirname(first.at)) === path.resolve(hubSkills);
  return {
    selfBuilt: {
      label: 'local',
      spec: 'local',
      confident: false,
      ...(inHub ? {} : { move: { from: first.at, to: dest }, note: 'moves it into the hub, the original is kept in backups/' }),
    },
  };
}

// ---- MCP servers ----

const SCRIPT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.py', '.sh', '.bash', '.rb', '.pl', '.php', '.ps1', '.jar']);
const BUILD_DIRS = new Set(['dist', 'build', 'out', 'target', 'bin', 'node_modules', '.venv']);

function isAbs(p: string): boolean {
  return path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p);
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function findScript(cfg: McpServerConfig): string | null {
  const cands = (cfg.args ?? []).filter((a): a is string => typeof a === 'string' && isAbs(a) && isFile(a));
  const scored = cands.find((a) => SCRIPT_EXT.has(path.extname(a).toLowerCase())) ?? cands[0];
  if (scored) return scored;
  return typeof cfg.command === 'string' && isAbs(cfg.command) && isFile(cfg.command) ? cfg.command : null;
}

/** A binary managed by a tool or package manager, not a script of the user's own. */
export function isToolBinPath(real: string, home: string): boolean {
  const posix = real.split(path.sep).join('/');
  if (/\/lib\/node_modules\/(?:@[\w.-]+\/)?[\w.-]+\//.test(posix) || /\/node_modules\/\.bin\//.test(posix) || /\/(\.?venvs?|pipx\/venvs\/[^/]+)\/(bin|Scripts)\//.test(posix)) return true;
  if (/^\/(opt\/homebrew|usr\/local\/Cellar|home\/linuxbrew\/\.linuxbrew)\//.test(posix)) return true;
  const known = ['.local/bin', '.cargo/bin', '.bun/bin', '.npm-global', '.deno/bin', '.local/share/pipx'].map((d) => path.join(home, d));
  if (known.some((d) => isWithin(d, real))) return true;
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((d) => realOf(d) ?? d);
  return dirs.some((d) => isWithin(d, real));
}

const GENERIC_DIRS = new Set(['hooks', 'scripts', 'script', 'bin', 'tools', 'tool', 'utils', 'lib', 'src', 'mcp', 'servers', 'downloads', 'documents', 'desktop', 'projects', 'code', 'tmp']);

/**
 * True when a script's folder belongs to one server: it has its own package.json or
 * pyproject.toml, or it is named after the server and is not a shared folder like hooks/.
 */
export function isDedicatedDir(dir: string, serverName: string, home: string): boolean {
  if (path.resolve(dir) === path.resolve(home)) return false;
  if (fs.existsSync(path.join(dir, 'package.json')) || fs.existsSync(path.join(dir, 'pyproject.toml'))) return true;
  const norm = (v: string): string => v.toLowerCase().replace(/[^a-z0-9]/g, '');
  const base = path.basename(dir).toLowerCase();
  return !GENERIC_DIRS.has(base) && norm(serverName).length > 0 && norm(base).includes(norm(serverName));
}

function npxSource(args: string[]): string | null {
  const rest = [...args];
  while (rest.length && /^-/.test(rest[0])) {
    if (/^(-y|--yes|-q|--quiet|--no-install)$/.test(rest[0])) rest.shift();
    else return null; // -p/--package, --call and friends: not a plain package run
  }
  const pkg = rest[0];
  if (!pkg || !/^(?:@[a-z0-9][\w.~-]*\/)?[a-z0-9][\w.~-]*(?:@[\w.^~<>=*+-]+)?$/i.test(pkg)) return null;
  return `npm:${pkg}`;
}

// uvx flags that take no value; any other flag before the package might consume the next word
const UVX_NO_VALUE_FLAGS = new Set(['-q', '--quiet', '--isolated', '--no-cache', '--offline']);

function uvxSource(args: string[]): string | null {
  let pkg: string | undefined;
  for (const a of args) {
    if (a.startsWith('-')) {
      if (!UVX_NO_VALUE_FLAGS.has(a)) return null;
    } else {
      pkg = a;
      break;
    }
  }
  const m = pkg ? /^([A-Za-z0-9][\w.-]*)(?:==(\d[\w.+-]*))?$/.exec(pkg) : null;
  return m ? `pypi:${m[1]}${m[2] ? `@${m[2]}` : ''}` : null;
}

/** The package manager install for a file inside a pipx venv or the npm global prefix. Reads only. */
function toolPackage(real: string): { install: string; how: string } | null {
  const posix = real.split(path.sep).join('/');
  const venv = /\/pipx\/venvs\/([A-Za-z0-9][\w.-]*)\//.exec(posix);
  let pipx = venv?.[1];
  if (!pipx) {
    try {
      const fd = fs.openSync(real, 'r');
      try {
        const buf = Buffer.alloc(512);
        const head = buf.toString('utf-8', 0, fs.readSync(fd, buf, 0, 512, 0)).split(/\r?\n/)[0];
        pipx = /^#!.*\/pipx\/venvs\/([A-Za-z0-9][\w.-]*)\//.exec(head)?.[1];
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // unreadable: no inference
    }
  }
  if (pipx) return { install: `pipx install ${pipx}`, how: 'a pipx venv script' };
  const npm = /\/lib\/node_modules\/((?:@[A-Za-z0-9][\w.-]*\/)?[A-Za-z0-9][\w.-]*)\//.exec(posix)?.[1];
  return npm ? { install: `npm install -g ${npm}`, how: 'an npm global package' } : null;
}

function mcpProposal(name: string, cfg: McpServerConfig, home: string, hub: string): Pick<AdoptItem, 'proposal' | 'report'> {
  if (typeof cfg.url === 'string' && !cfg.command) return { report: 'remote server (url), nothing to install' };
  const command = typeof cfg.command === 'string' ? cfg.command : '';
  if (!command) return { report: 'no command or url' };
  const args = (cfg.args ?? []).map(String);
  const exe = path.basename(command).replace(/\.(cmd|exe)$/i, '');

  if (exe === 'npx') {
    const spec = npxSource(args);
    if (spec) return { proposal: { label: spec, spec, confident: true } };
  }
  if (exe === 'uvx') {
    const spec = uvxSource(args);
    if (spec) return { proposal: { label: spec, spec, confident: true } };
  }

  const script = findScript(cfg);
  if (script) {
    const real = realOf(script) ?? script;
    if (isToolBinPath(real, home)) {
      const base = path.basename(script);
      const pkg = toolPackage(real);
      // the command itself is the binary and its bare name finds the same file: a portable command
      const found = script === cfg.command ? findExecutable(base) : null;
      const portable = found !== null && (realOf(found) ?? found) === real;
      const where = `${tilde(real, home)} is a program managed by a tool, so it is not moved into the hub`;
      return {
        proposal: {
          label: `custom (${pkg ? `${pkg.install}; ` : ''}check: command -v ${base})`,
          spec: { ...(pkg ? { install: pkg.install } : {}), check: `command -v ${shq(base)}` },
          confident: false,
          needs: pkg ? undefined : 'install',
          ...(portable ? { rewrite: { from: script, to: base } } : {}),
          note: [where, portable ? `the hub command becomes "${base}" (found on PATH, same file)` : '', pkg ? `${pkg.how}; confirm it before accepting` : ''].filter(Boolean).join('; '),
        },
      };
    }
    const root = findGitRoot(path.dirname(real), hub);
    const remote = root ? readRemote(root) : null;
    const mapped = remote ? sourceFromRemote(remote.url) : null;
    if (root && remote && mapped) {
      const rel = path.relative(root, real).split(path.sep);
      const built = rel.some((seg) => BUILD_DIRS.has(seg));
      const cs = checkoutSpec(root, mapped.base, remote.name, home);
      return {
        proposal: {
          label: `${mapped.base} (checkout ${tilde(root, home)})`,
          spec: cs.spec,
          confident: cs.confident && !built,
          needs: built ? 'build' : undefined,
          rewrite: { from: root, to: `\${HUB}/vendor/mcp/${name}` },
          note: built ? `the command runs build output, so it needs a build command; ${cs.note}` : cs.note,
        },
      };
    }
    if (!root && isWithin(home, real)) {
      const dir = path.dirname(real);
      if (isDedicatedDir(dir, name, home)) {
        return {
          proposal: {
            label: 'local',
            spec: 'local',
            confident: false,
            move: { from: dir, to: path.join(hub, 'mcp', 'servers', name) },
            rewrite: { from: dir, to: `\${HUB}/mcp/servers/${name}` },
            note: `moves the whole folder ${tilde(dir, home)} into the hub, the original is kept in backups/ (other tools that call it by path will lose it)`,
          },
        };
      }
      return {
        proposal: {
          label: `custom (check: ${tilde(real, home)} exists)`,
          spec: { check: `test -e ${shellPath(real, home)}` },
          confident: false,
          needs: 'install',
          note: `${tilde(dir, home)} holds other files too, so the script is not moved: add an install command, or leave it check-only`,
        },
      };
    }
    if (!root) {
      return {
        proposal: {
          label: `custom (check: ${tilde(real, home)} exists)`,
          spec: { check: `test -e ${shellPath(real, home)}` },
          confident: false,
          needs: 'install',
        },
      };
    }
  }

  const bare = isAbs(command) ? path.basename(command) : command;
  const onPath = findExecutable(command) !== null;
  return {
    proposal: {
      label: `custom (check: command -v ${bare})`,
      spec: { check: isAbs(command) ? `test -x ${shellPath(command, home)}` : `command -v ${shq(command)}` },
      confident: false,
      needs: 'install',
      note: onPath ? undefined : `${command} was not found on this machine's PATH`,
    },
  };
}

// ---- scan ----

/** Finds skills and MCP servers that exist in the hub or an assistant but are not declared. Reads files only. */
export function scanAdoptable(homeDir?: string, hubDir?: string): AdoptItem[] {
  const home = homeDir || getHomeDir();
  const hub = hubDir || getHubDir();
  const declared = loadDeclaredSources(hub).sources;
  const ignored = { skills: ignoredNames(hub, 'skills'), mcp: ignoredNames(hub, 'mcp') };
  const isDeclared = (kind: SourceKind, name: string): boolean =>
    ignored[kind].has(name) || declared.some((d) => d.kind === kind && d.name === name);
  const items: AdoptItem[] = [];

  const byName = new Map<string, SkillSeen[]>();
  for (const s of scanSkillDirs(home, hub)) {
    if (isDeclared('skills', s.name)) continue;
    byName.set(s.name, [...(byName.get(s.name) ?? []), s]);
  }
  for (const [name, seen] of byName) {
    const found = seen.map((s) => {
      const real = realOf(s.at);
      const link = isJunctionOrSymlink(s.at) && real ? ` -> ${tilde(real, home)}` : '';
      return `${s.label}: ${tilde(s.at, home)}${link}`;
    });
    items.push({ kind: 'skills', name, found, ...skillProposal(seen, home, hub) });
  }

  const status = getMcpStatus(home, hub);
  const servers = new Map<string, { cfg: McpServerConfig; at: string[] }>();
  const add = (label: string, name: string, cfg: McpServerConfig): void => {
    const e = servers.get(name);
    if (e) e.at.push(label);
    else servers.set(name, { cfg, at: [label] });
  };
  for (const [n, c] of Object.entries(status.hub.servers)) add('hub', n, c);
  for (const id of MCP_PLATFORM_IDS) {
    const p = MCP_PLATFORMS[id];
    if (!status.platforms[id].installed) continue;
    for (const [n, c] of Object.entries(status.platforms[id].servers)) {
      if (!isDisabled(c as Record<string, unknown>)) add(p.label, n, p.fromNative(c as Record<string, unknown>));
    }
  }
  for (const [name, { cfg, at }] of servers) {
    if (isDeclared('mcp', name)) continue;
    const expanded = expandServerPaths(cfg, home, hub);
    const cmd = ([expanded.command, ...(expanded.args ?? [])].filter(Boolean).join(' ') || String(expanded.url ?? '')).split(home).join('~');
    const where = at.length > 3 ? `${at.slice(0, 2).join(', ')} and ${at.length - 2} more` : at.join(', ');
    items.push({ kind: 'mcp', name, found: [`${where}: ${cmd}`], ...mcpProposal(name, expanded, home, hub) });
  }
  return items.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind.localeCompare(b.kind)));
}

// ---- apply ----

/** Where originals that adopt moves go: not next to them, where skill loaders would still scan them. */
function adoptBackupDir(hub: string): string {
  return path.join(hub, 'backups', `adopt-${getUtcTimestamp()}`);
}

/** Moves a path, falling back to copy and remove across devices (the copy exists before anything is removed). */
function moveAway(from: string, to: string): void {
  ensureDir(path.dirname(to));
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

/**
 * Copies from -> to, then moves the original into hub/backups/adopt-<ts>/<label>.
 * Refuses to replace anything at `to`; a failed copy is removed again. Returns the backup path.
 */
function moveWithBackup(from: string, to: string, hub: string, label: string): string {
  if (fs.existsSync(to)) throw new Error(`${to} already exists, not replacing it`);
  ensureDir(path.dirname(to));
  try {
    fs.cpSync(from, to, { recursive: true });
  } catch (err) {
    fs.rmSync(to, { recursive: true, force: true });
    throw err;
  }
  const backup = path.join(adoptBackupDir(hub), label);
  moveAway(from, backup);
  return backup;
}

/** Replaces a path prefix only at path boundaries, so /a/b does not match /a/bc. */
function rewriteStrings(value: unknown, variants: string[], to: string): unknown {
  if (typeof value === 'string') {
    let out = value;
    for (const v of variants) {
      const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(
        new RegExp(`(^|[=:;\\s'"])${esc}((?:[\\\\/][^\\s'";:]*)?)(?=$|[:;\\s'"])`, 'g'),
        (_m, pre: string, rest: string) => pre + to + rest.replace(/\\/g, '/')
      );
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((x) => rewriteStrings(x, variants, to));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewriteStrings(v, variants, to)]));
  }
  return value;
}

/** Makes sure hub servers.json has the entry (ingesting it from the platform) and rewrites its paths. */
function writeMcpEntry(item: AdoptItem, proposal: AdoptProposal, home: string, hub: string): void {
  const file = path.join(hub, 'mcp', 'servers.json');
  const read = readJsonSafely<{ mcpServers?: Record<string, McpServerConfig> }>(file);
  if (!read.success) throw new Error('mcp/servers.json is unparseable, not modifying it');
  const servers: Record<string, McpServerConfig> = { ...(read.data.mcpServers ?? {}) };
  let changed = false;

  if (!servers[item.name]) {
    const status = getMcpStatus(home, hub);
    let cfg: McpServerConfig | undefined;
    for (const id of MCP_PLATFORM_IDS) {
      const native = status.platforms[id].servers[item.name];
      if (!cfg && native) cfg = MCP_PLATFORMS[id].fromNative(native as Record<string, unknown>);
    }
    if (!cfg) throw new Error(`no server named "${item.name}" found to adopt`);
    servers[item.name] = normalizeServerForHub(item.name, cfg, home, hub);
    changed = true;
  }
  if (proposal.rewrite) {
    const from = proposal.rewrite.from;
    const variants = [...new Set([from, contractPaths(from, home, hub), from.replace(/\\/g, '/')])].filter(Boolean);
    const next = rewriteStrings(servers[item.name], variants, proposal.rewrite.to) as McpServerConfig;
    if (JSON.stringify(next) !== JSON.stringify(servers[item.name])) {
      servers[item.name] = next;
      changed = true;
    }
  }
  if (changed) safeWriteFile(file, JSON.stringify({ ...read.data, mcpServers: servers }, null, 2) + '\n');
}

/** A hub/skills real folder in the way of a link goes to hub/backups instead of being replaced. */
function backupHubSkillFolder(hub: string, name: string): string | null {
  const p = path.join(hub, 'skills', name);
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
  } catch {
    return null;
  }
  const dest = path.join(adoptBackupDir(hub), 'skills', name);
  ensureDir(path.dirname(dest));
  fs.renameSync(p, dest);
  return dest;
}

export function applyProposal(item: AdoptItem, proposal: AdoptProposal, homeDir: string, hubDir: string): AdoptApplied {
  const detail: string[] = [];
  const decl = parseSourceSpec(item.kind, item.name, proposal.spec); // validates before anything is written

  if (item.kind === 'skills') {
    if (proposal.move) {
      const backup = moveWithBackup(proposal.move.from, proposal.move.to, hubDir, path.join('skills', item.name));
      detail.push(`moved to ${tilde(proposal.move.to, homeDir)}, original kept in ${tilde(backup, homeDir)}`);
    }
    if (decl.parsed.type !== 'local') {
      const backup = backupHubSkillFolder(hubDir, item.name);
      if (backup) detail.push(`hub folder skills/${item.name} kept at ${tilde(backup, homeDir)}`);
    }
  } else {
    if (proposal.move) {
      const backup = moveWithBackup(proposal.move.from, proposal.move.to, hubDir, path.join('mcp', item.name));
      detail.push(`moved to ${tilde(proposal.move.to, homeDir)}, original kept in ${tilde(backup, homeDir)}`);
    }
    writeMcpEntry(item, proposal, homeDir, hubDir);
  }
  setDeclaredSource(hubDir, item.kind, item.name, proposal.spec);
  detail.push(`declared ${item.kind}.${item.name}`);
  return { item: itemId(item), declared: typeof proposal.spec === 'string' ? proposal.spec : JSON.stringify(proposal.spec), detail };
}

/** The proposal as the declaration text a user would write in agenthub.json. */
export function describeDeclaration(p: AdoptProposal): string {
  return JSON.stringify(p.spec);
}

async function resolveInteractive(item: AdoptItem, prompter: AdoptPrompter): Promise<AdoptProposal | null | { error: string }> {
  const choices: AdoptChoice[] = [];
  if (item.proposal) choices.push('accept');
  if (item.selfBuilt) choices.push('self-built');
  choices.push('source', 'skip');
  const choice = await prompter.choose(item, choices);
  if (choice === 'skip') return null;
  if (choice === 'self-built') return item.selfBuilt ?? null;

  if (choice === 'source') {
    const text = (await prompter.ask('source (github:owner/repo[#subpath], git:<url>, npm:pkg@ver, pypi:pkg@ver, local): ')).trim();
    if (!text) return null;
    try {
      const decl = parseSourceSpec(item.kind, item.name, text);
      if (decl.parsed.type === 'local') {
        return item.selfBuilt ?? (item.proposal?.move ? { ...item.proposal, spec: 'local', label: 'local' } : { label: 'local', spec: 'local', confident: false });
      }
      return { label: text, spec: text, confident: false };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  const proposal = item.proposal as AdoptProposal;
  if (proposal.needs === 'install' && typeof proposal.spec === 'object') {
    const install = (await prompter.ask('install command (run on a new machine when the check fails; empty: check-only, you install it yourself): ')).trim();
    return install ? { ...proposal, spec: { ...proposal.spec, install } } : proposal;
  }
  if (proposal.needs === 'build') {
    const build = (await prompter.ask('build command to run in the checkout (empty for none): ')).trim();
    const base = typeof proposal.spec === 'string' ? { source: proposal.spec } : proposal.spec;
    return build ? { ...proposal, spec: { ...base, build } } : proposal;
  }
  return proposal;
}

/**
 * Scans and, depending on the mode, applies. TTY with a prompter: asks per item.
 * --yes: applies only inferences read from the item itself (confident). Otherwise
 * (non-TTY, --dry-run): changes nothing. Never executes anything from an item.
 */
export async function runAdopt(options: AdoptOptions = {}): Promise<AdoptReport> {
  const home = options.homeDir || getHomeDir();
  const hub = options.hubDir || getHubDir();
  const items = scanAdoptable(home, hub);
  const mode: AdoptReport['mode'] = options.dryRun ? 'dry-run' : options.yes ? 'auto' : options.prompter ? 'interactive' : 'preview';
  const report: AdoptReport = { mode, items, applied: [], skipped: [] };
  if (mode === 'dry-run' || mode === 'preview') return report;

  for (const item of items) {
    const id = itemId(item);
    if (!item.proposal && !item.selfBuilt) {
      report.skipped.push({ item: id, reason: item.report ?? 'nothing to adopt' });
      continue;
    }
    try {
      let chosen: AdoptProposal | null | { error: string };
      if (mode === 'auto') {
        chosen = item.proposal?.confident && !item.proposal.needs ? item.proposal : null;
        if (!chosen) {
          report.skipped.push({ item: id, reason: 'not a confident inference, run adopt in a terminal to decide' });
          continue;
        }
      } else {
        chosen = await resolveInteractive(item, options.prompter as AdoptPrompter);
      }
      if (!chosen) {
        report.skipped.push({ item: id, reason: 'skipped' });
        continue;
      }
      if ('error' in chosen) {
        report.skipped.push({ item: id, reason: chosen.error });
        continue;
      }
      report.applied.push(applyProposal(item, chosen, home, hub));
    } catch (err) {
      report.skipped.push({ item: id, reason: (err as Error).message });
    }
  }
  return report;
}
