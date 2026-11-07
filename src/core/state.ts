import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureDir } from '../utils/fs.js';
import { getHomeDir } from './detector.js';

/**
 * Machine-local state (approvals, ignore list, MCP origins) lives outside the hub
 * work tree, because whoever controls the hub repo controls every file in it,
 * .gitignore or not:
 *   $XDG_STATE_HOME/agenthub/<id>/   (default ~/.local/state/agenthub/<id>/)
 *   %LOCALAPPDATA%\agenthub\<id>\    (Windows)
 * <id> is the first 16 hex characters of sha256(realpath of the hub).
 * When --home or AGENTHUB_HOME points elsewhere, the state goes under that home,
 * so such runs never touch the real machine state.
 */

function realish(p: string): string {
  let cur = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest);
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return path.resolve(p);
      rest.unshift(path.basename(cur));
      cur = up;
    }
  }
}

export function hubId(hub: string): string {
  return createHash('sha256').update(realish(hub)).digest('hex').slice(0, 16);
}

export function stateDir(hub: string): string {
  const home = getHomeDir();
  const overridden = path.resolve(home) !== path.resolve(os.homedir());
  let base: string;
  if (process.platform === 'win32') {
    const local = !overridden && process.env.LOCALAPPDATA;
    base = path.join(local || path.join(home, 'AppData', 'Local'), 'agenthub');
  } else {
    const xdg = !overridden && process.env.XDG_STATE_HOME;
    base = path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(home, '.local', 'state'), 'agenthub');
  }
  return path.join(base, hubId(hub));
}

function isTracked(hub: string, rel: string): boolean {
  const res = spawnSync('git', ['ls-files', '--error-unmatch', '--', rel], { cwd: hub, encoding: 'utf-8', windowsHide: true });
  return res.status === 0;
}

const warned = new Set<string>();

/**
 * Path of a machine-local state file. The first time, a file at the old in-tree
 * location moves here if this one does not exist yet. A file that git tracks came
 * from whoever controls the repo, so it is never imported: it is warned about and
 * untracked on the next push.
 */
export function stateFile(hub: string, name: string, oldRel: string = name): string {
  const next = path.join(stateDir(hub), name);
  const old = path.join(hub, oldRel);
  if (fs.existsSync(old) && !fs.existsSync(next)) {
    if (isTracked(hub, oldRel.replace(/\\/g, '/'))) {
      if (!warned.has(old)) {
        warned.add(old);
        console.error(`Warning: ${oldRel} is tracked in the hub repo, so it came from the repo and is ignored. It is untracked on the next push; machine-local state now lives in ${stateDir(hub)}.`);
      }
    } else {
      ensureDir(path.dirname(next));
      try {
        fs.renameSync(old, next);
      } catch {
        fs.copyFileSync(old, next);
        fs.rmSync(old, { force: true });
      }
    }
  }
  return next;
}

/** Old in-tree locations of the state files, for untracking when a repo carries them. */
export const OLD_STATE_PATHS = ['approvals.json', 'local.json', 'mcp/origins.json'];
