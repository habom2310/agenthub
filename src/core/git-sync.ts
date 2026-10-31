import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, findExecutable, getUtcTimestamp, safeWriteFile } from '../utils/fs.js';
import { getHubDir } from './detector.js';
import { isScaffoldDefault } from './scaffold.js';
import { projectCodexSkillManifests } from './linker.js';
import { projectAll } from './projector.js';

export interface GitStatusResult {
  git_installed: boolean;
  is_repo: boolean;
  branch: string | null;
  is_clean: boolean;
  modified: string[];
  untracked: string[];
  remotes: Record<string, string>;
}

export interface GitOperationResult {
  ok: boolean;
  message: string;
}

export const STANDARD_IGNORE_ENTRIES = [
  'backups/',
  '*.backup_*',
  '*.tmp',
  '__pycache__/',
  '*.pyc',
  '.DS_Store',
  'Thumbs.db',
  '.env',
  '*.env',
  '/vendor/',
  '/mcp/origins.json',
];

export const MANAGED_BLOCK_START = '# >>> agenthub managed (do not edit)';
export const MANAGED_BLOCK_END = '# <<< agenthub managed';

interface GitExecResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Redacts credentials and auth tokens from git remote URLs and command outputs.
 */
export function redactGitSecrets(text: string): string {
  return text.replace(/(https?:\/\/)([^:@\s]+)(?::([^@\s]+))?@/g, (_m, proto, user, pass) => {
    return pass !== undefined ? `${proto}${user}:***@` : `${proto}***@`;
  });
}

function runGit(args: string[], cwd?: string): GitExecResult {
  try {
    const res = spawnSync('git', args, {
      cwd: cwd || process.cwd(),
      encoding: 'utf-8',
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });

    if (res.error) {
      return {
        status: -1,
        stdout: '',
        stderr: res.error.message,
      };
    }

    return {
      status: res.status ?? -1,
      stdout: res.stdout || '',
      stderr: res.stderr || '',
    };
  } catch (err) {
    return {
      status: -1,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Checks whether git is installed and available in the system PATH.
 */
export function isGitInstalled(): boolean {
  if (findExecutable('git') !== null) {
    return true;
  }
  const res = runGit(['--version']);
  return res.status === 0;
}

/**
 * Checks if the given hub directory is a valid git repository.
 */
export function isGitRepo(hubDir?: string): boolean {
  const hub = hubDir || getHubDir();
  const gitDir = path.join(hub, '.git');
  if (!fs.existsSync(gitDir)) {
    return false;
  }
  const res = runGit(['rev-parse', '--is-inside-work-tree'], hub);
  return res.status === 0 && res.stdout.trim() === 'true';
}

/**
 * Ensures standard ignore entries exist in the hub's .gitignore file.
 * Appends missing entries without destroying existing user entries.
 */
export function ensureGitignore(hubDir?: string): void {
  const hub = hubDir || getHubDir();
  ensureDir(hub);
  const gitignorePath = path.join(hub, '.gitignore');

  if (!fs.existsSync(gitignorePath)) {
    safeWriteFile(gitignorePath, STANDARD_IGNORE_ENTRIES.join('\n') + '\n');
    return;
  }

  const existingContent = fs.readFileSync(gitignorePath, 'utf-8');
  const existingLines = existingContent.split(/\r?\n/).map((l) => l.trim());
  const missing = STANDARD_IGNORE_ENTRIES.filter((entry) => !existingLines.includes(entry));

  if (missing.length > 0) {
    const endsWithNewline = existingContent.endsWith('\n') || existingContent.endsWith('\r');
    const prefix = existingContent.length > 0 && !endsWithNewline ? '\n' : '';
    const toAppend = prefix + missing.join('\n') + '\n';
    fs.appendFileSync(gitignorePath, toAppend, 'utf-8');
  }
}

function managedBlockRange(lines: string[]): { start: number; end: number } | null {
  const start = lines.indexOf(MANAGED_BLOCK_START);
  if (start < 0) return null;
  return { start, end: lines.indexOf(MANAGED_BLOCK_END, start) };
}

/** Entries currently listed in the hub .gitignore managed block. */
export function readManagedIgnoreBlock(hubDir: string): string[] {
  try {
    const lines = fs.readFileSync(path.join(hubDir, '.gitignore'), 'utf-8').split(/\r?\n/);
    const range = managedBlockRange(lines);
    return range && range.end >= 0 ? lines.slice(range.start + 1, range.end).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Rewrites the agenthub managed block of the hub .gitignore with the given
 * entries (skill symlinks that point into vendor/ or outside the hub).
 * An empty list removes the block. Other lines and the file's line endings are
 * kept; a start marker without an end marker is dropped on its own.
 */
export function updateManagedIgnoreBlock(hubDir: string, entries: string[]): void {
  const gitignorePath = path.join(hubDir, '.gitignore');
  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const lines = existing.split(/\r?\n/);
  const range = managedBlockRange(lines);
  let kept = lines;
  if (range) {
    kept =
      range.end >= 0
        ? [...lines.slice(0, range.start), ...lines.slice(range.end + 1)]
        : [...lines.slice(0, range.start), ...lines.slice(range.start + 1)];
  }
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();

  const sorted = [...new Set(entries)].sort();
  const block = sorted.length > 0 ? [MANAGED_BLOCK_START, ...sorted, MANAGED_BLOCK_END] : [];
  const next = [...kept, ...block].join(eol) + (kept.length + block.length > 0 ? eol : '');
  if (next !== existing) safeWriteFile(gitignorePath, next);
}

/**
 * Inspects git repository status in the hub directory.
 */
export function gitStatus(hubDir?: string): GitStatusResult {
  const hub = hubDir || getHubDir();

  if (!isGitInstalled()) {
    return {
      git_installed: false,
      is_repo: false,
      branch: null,
      is_clean: true,
      modified: [],
      untracked: [],
      remotes: {},
    };
  }

  if (!isGitRepo(hub)) {
    return {
      git_installed: true,
      is_repo: false,
      branch: null,
      is_clean: true,
      modified: [],
      untracked: [],
      remotes: {},
    };
  }

  // Branch detection
  let branch: string | null = null;
  const branchRes = runGit(['branch', '--show-current'], hub);
  if (branchRes.status === 0 && branchRes.stdout.trim()) {
    branch = branchRes.stdout.trim();
  } else {
    const headRes = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], hub);
    if (headRes.status === 0) {
      const b = headRes.stdout.trim();
      branch = b === 'HEAD' ? 'main' : b;
    } else {
      branch = 'main';
    }
  }

  // Porcelain status parsing (-u ensures untracked directories list individual files)
  const statusRes = runGit(['status', '--porcelain', '-u'], hub);
  const modified: string[] = [];
  const untracked: string[] = [];

  if (statusRes.status === 0 && statusRes.stdout) {
    const lines = statusRes.stdout.split(/\r?\n/);
    for (const rawLine of lines) {
      if (!rawLine.trim()) continue;
      const prefix = rawLine.slice(0, 2);
      let filePath = rawLine.slice(3).trim();
      if (filePath.startsWith('"') && filePath.endsWith('"')) {
        filePath = filePath.slice(1, -1);
      }
      if (prefix === '??') {
        untracked.push(filePath);
      } else {
        modified.push(filePath);
      }
    }
  }

  // Remotes parsing
  const remotes: Record<string, string> = {};
  const remotesRes = runGit(['remote', '-v'], hub);
  if (remotesRes.status === 0 && remotesRes.stdout) {
    const lines = remotesRes.stdout.split(/\r?\n/);
    for (const line of lines) {
      const match = line.trim().match(/^(\S+)\s+(\S+)/);
      if (match) {
        remotes[match[1]] = redactGitSecrets(match[2]);
      }
    }
  }

  const is_clean = modified.length === 0 && untracked.length === 0;

  return {
    git_installed: true,
    is_repo: true,
    branch,
    is_clean,
    modified,
    untracked,
    remotes,
  };
}

/**
 * Initializes a git repository in the hub directory and configures ignore rules.
 */
export function gitInitHub(hubDir?: string, remoteUrl?: string): GitOperationResult {
  const hub = hubDir || getHubDir();
  ensureDir(hub);

  if (!isGitInstalled()) {
    return { ok: false, message: 'Git is not installed on this system' };
  }

  let initRes = runGit(['init', '-b', 'main'], hub);
  if (initRes.status !== 0) {
    initRes = runGit(['init'], hub);
    if (initRes.status !== 0) {
      return {
        ok: false,
        message: `Failed to initialize git repository: ${initRes.stderr || initRes.stdout}`.trim(),
      };
    }
  }

  ensureGitignore(hub);

  if (remoteUrl) {
    const remotesRes = runGit(['remote'], hub);
    const existingRemotes = remotesRes.stdout.split(/\r?\n/).map((r) => r.trim());
    if (existingRemotes.includes('origin')) {
      const setRemoteRes = runGit(['remote', 'set-url', 'origin', remoteUrl], hub);
      if (setRemoteRes.status !== 0) {
        return {
          ok: false,
          message: redactGitSecrets(`Failed to update remote URL: ${setRemoteRes.stderr || setRemoteRes.stdout}`.trim()),
        };
      }
    } else {
      const addRemoteRes = runGit(['remote', 'add', 'origin', remoteUrl], hub);
      if (addRemoteRes.status !== 0) {
        return {
          ok: false,
          message: redactGitSecrets(`Failed to add remote: ${addRemoteRes.stderr || addRemoteRes.stdout}`.trim()),
        };
      }
    }
  }

  return { ok: true, message: 'Initialized git repository in hub' };
}

export interface GitPushOptions {
  hubDir?: string;
  commitMessage?: string;
  message?: string;
  remote?: string;
  branch?: string;
}

/**
 * Adds, commits, and pushes changes from the hub to remote repository.
 */
export function gitPush(
  optionsOrHubDir?: string | GitPushOptions,
  message?: string,
  remote = 'origin',
  branch?: string
): GitOperationResult {
  let hubDir: string | undefined;
  let commitMsg: string | undefined;
  let remoteName = remote;
  let targetBranch = branch;

  if (optionsOrHubDir && typeof optionsOrHubDir === 'object') {
    hubDir = optionsOrHubDir.hubDir;
    commitMsg = optionsOrHubDir.commitMessage ?? optionsOrHubDir.message;
    remoteName = optionsOrHubDir.remote || 'origin';
    targetBranch = optionsOrHubDir.branch;
  } else {
    hubDir = optionsOrHubDir;
    commitMsg = message;
  }

  const hub = hubDir || getHubDir();

  if (!isGitInstalled()) {
    return { ok: false, message: 'git is not installed or not in PATH' };
  }

  if (!isGitRepo(hub)) {
    const initRes = gitInitHub(hub);
    if (!initRes.ok) {
      return initRes;
    }
  }

  // Stage changes
  const addRes = runGit(['add', '-A'], hub);
  if (addRes.status !== 0) {
    return {
      ok: false,
      message: redactGitSecrets(`Failed to stage changes: ${addRes.stderr || addRes.stdout}`.trim()),
    };
  }

  // Check porcelain status for uncommitted changes
  const statusRes = runGit(['status', '--porcelain'], hub);
  if (statusRes.stdout.trim()) {
    const finalCommitMsg = commitMsg || `agenthub sync: ${new Date().toISOString()}`;

    // Check git user.name and user.email independently
    const userNameRes = runGit(['config', 'user.name'], hub);
    const userEmailRes = runGit(['config', 'user.email'], hub);
    const userName = userNameRes.stdout.trim();
    const userEmail = userEmailRes.stdout.trim();

    const commitArgs: string[] = [];
    if (!userName) {
      commitArgs.push('-c', 'user.name=agenthub');
    }
    if (!userEmail) {
      commitArgs.push('-c', 'user.email=agenthub@local');
    }
    commitArgs.push('commit', '-m', finalCommitMsg);

    const commitRes = runGit(commitArgs, hub);
    if (commitRes.status !== 0) {
      return {
        ok: false,
        message: redactGitSecrets(`Commit failed: ${commitRes.stderr || commitRes.stdout}`.trim()),
      };
    }
  }

  // Check remotes
  const status = gitStatus(hub);
  if (!status.remotes[remoteName]) {
    return {
      ok: true,
      message: 'Changes committed locally. No remote configured, skipping push.',
    };
  }

  const pushBranch = targetBranch || status.branch || 'main';
  let pushRes = runGit(['push', '-u', remoteName, pushBranch], hub);
  if (pushRes.status !== 0) {
    pushRes = runGit(['push', remoteName, pushBranch], hub);
    if (pushRes.status !== 0) {
      return {
        ok: false,
        message: redactGitSecrets(`Failed to push to ${remoteName}: ${pushRes.stderr || pushRes.stdout}`.trim()),
      };
    }
  }

  return {
    ok: true,
    message: redactGitSecrets(`Pushed changes to ${remoteName}/${pushBranch}`),
  };
}

const GENERATED_GITIGNORE = STANDARD_IGNORE_ENTRIES.join('\n') + '\n';

/**
 * Before the first checkout of a remote branch: moves hub files that would be
 * overwritten and are not untouched scaffold output into backups/pre-pull-<ts>/.
 */
function backupCollidingFiles(hub: string, remoteRef: string): { dir: string; files: string[] } {
  const dir = path.join('backups', `pre-pull-${getUtcTimestamp()}`);
  const files: string[] = [];
  const tree = runGit(['ls-tree', '-r', '-z', '--name-only', remoteRef], hub);
  for (const rel of tree.stdout.split('\0').filter(Boolean)) {
    const abs = path.join(hub, rel);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(abs);
    } catch {
      continue;
    }
    if (stat.isFile()) {
      const content = fs.readFileSync(abs);
      const generated = rel === '.gitignore' && content.toString('utf-8') === GENERATED_GITIGNORE;
      if (generated || isScaffoldDefault(rel, content)) continue;
    }
    const dest = path.join(hub, dir, rel);
    ensureDir(path.dirname(dest));
    fs.renameSync(abs, dest);
    files.push(rel);
  }
  return { dir: dir.replace(/\\/g, '/'), files };
}

/**
 * Pulls changes from remote repository into the hub and optionally reprojects rules/skills.
 */
export function gitPull(
  hubDir?: string,
  remote = 'origin',
  branch?: string,
  reproject = true
): GitOperationResult {
  const hub = hubDir || getHubDir();

  if (!isGitInstalled()) {
    return { ok: false, message: 'Git is not installed on this system' };
  }

  if (!isGitRepo(hub)) {
    return { ok: false, message: 'Hub is not a git repository' };
  }

  const status = gitStatus(hub);
  if (!status.remotes[remote]) {
    return { ok: false, message: `Remote '${remote}' does not exist` };
  }

  const targetBranch = branch || status.branch || 'main';

  // Unborn HEAD (fresh `git init`): setup's scaffold files would block a merge.
  // Untouched scaffold files are replaced by the remote branch; anything else
  // that collides is moved to backups/ first.
  const unborn = runGit(['rev-parse', '--verify', '-q', 'HEAD'], hub).status !== 0;
  let pullRes: GitExecResult;
  let backupNote = '';
  if (unborn) {
    pullRes = runGit(['fetch', remote, `+refs/heads/${targetBranch}:refs/remotes/${remote}/${targetBranch}`], hub);
    if (pullRes.status === 0) {
      const backedUp = backupCollidingFiles(hub, `${remote}/${targetBranch}`);
      if (backedUp.files.length > 0) {
        backupNote = `\nBacked up ${backedUp.files.length} conflicting file(s) to ${backedUp.dir}: ${backedUp.files.join(', ')}`;
      }
      pullRes = runGit(['checkout', '-f', '-B', targetBranch, '--track', `${remote}/${targetBranch}`], hub);
    }
  } else {
    pullRes = runGit(['pull', remote, targetBranch], hub);
  }
  if (pullRes.status !== 0) {
    return {
      ok: false,
      message: redactGitSecrets(`Failed to pull from ${remote}: ${pullRes.stderr || pullRes.stdout}`.trim()),
    };
  }

  if (reproject) {
    projectAll({ hubDir: hub });
    projectCodexSkillManifests(hub);
  }

  return {
    ok: true,
    message: redactGitSecrets(`Successfully pulled from ${remote}/${targetBranch}`) + backupNote,
  };
}
