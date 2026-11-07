import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Reads the global lockfile of `npx skills` (https://github.com/vercel-labs/skills, src/skill-lock.ts):
 * ~/.agents/.skill-lock.json, or $XDG_STATE_HOME/skills/.skill-lock.json. The file is untrusted
 * input: every field is validated, credentials are removed from URLs, and nothing is executed.
 */

export interface LockedSkill {
  /** github:owner/repo or git:<url>, without credentials */
  base: string;
  /** Folder of the skill inside the repository ("" for the root); undefined when the lock names none */
  subpath?: string;
  ref?: string;
}

const MAX_BYTES = 5 * 1024 * 1024;
const REPO = /^[\w.-]+\/[\w.-]+$/;
// https://, http://, ssh://, git:// or scp-like user@host:path; no whitespace or control characters
const GIT_URL = /^(?:(?:https?|ssh|git):\/\/[^\s\x00-\x1f]{1,2000}|[\w.-]+@[\w.-]+:[\w./~+-]{1,500})$/;
const REF =/^[A-Za-z0-9][\w./@+-]{0,199}$/;
const SUBPATH_SEGMENT = /^[\w@+][\w.@+-]*$/;

function lockPaths(home: string): string[] {
  const out = [path.join(home, '.agents', '.skill-lock.json')];
  // the real XDG location only counts when working on the real home
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg && path.resolve(home) === path.resolve(os.homedir())) out.push(path.join(xdg, 'skills', '.skill-lock.json'));
  return out;
}

/** The folder of a lock `skillPath` (a SKILL.md path inside the repo); null when it is not a plain relative path. */
function skillDir(skillPath: string): string | null {
  const posix = skillPath.replace(/\\/g, '/');
  const segments = posix.split('/');
  if (segments[segments.length - 1] !== 'SKILL.md') return null;
  const dirs = segments.slice(0, -1);
  if (!dirs.every((s) => s !== '.' && s !== '..' && SUBPATH_SEGMENT.test(s))) return null;
  return dirs.join('/');
}

/** A clean `github:` or `git:` base for a lock entry, or null. `toBase` is sourceFromRemote. */
function entryBase(
  entry: Record<string, unknown>,
  toBase: (url: string) => { base: string } | null
): string | null {
  const { source, sourceType, sourceUrl } = entry;
  if (sourceType !== 'github' && sourceType !== 'gitlab' && sourceType !== 'git') return null;
  if (sourceType === 'github' && typeof source === 'string' && REPO.test(source) && !source.includes('..')) return `github:${source}`;
  return typeof sourceUrl === 'string' && GIT_URL.test(sourceUrl) ? (toBase(sourceUrl)?.base ?? null) : null;
}

/** Every well-formed entry of the lock file(s); the first file wins. */
function lockEntries(home: string): Array<[string, Record<string, unknown>]> {
  const out = new Map<string, Record<string, unknown>>();
  for (const file of lockPaths(home)) {
    let data: unknown;
    try {
      if (fs.statSync(file).size > MAX_BYTES) continue;
      data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      continue;
    }
    const skills = data && typeof data === 'object' ? (data as Record<string, unknown>).skills : undefined;
    if (!skills || typeof skills !== 'object' || Array.isArray(skills)) continue;
    for (const [name, raw] of Object.entries(skills)) {
      if (!out.has(name) && raw && typeof raw === 'object' && !Array.isArray(raw)) out.set(name, raw as Record<string, unknown>);
    }
  }
  return [...out];
}

/** Names of every skill in the lock, whatever its source; only plain folder names (they end up in .git/info/exclude). */
export function readSkillLockNames(home: string): string[] {
  return lockEntries(home)
    .map(([n]) => n)
    .filter((n) => /^[A-Za-z0-9][\w.-]{0,100}$/.test(n));
}

/** Entries of the lock that point at a git source, by skill name. A malformed entry is skipped. */
export function readSkillLock(
  home: string,
  toBase: (url: string) => { base: string } | null
): Map<string, LockedSkill> {
  const out = new Map<string, LockedSkill>();
  for (const [name, entry] of lockEntries(home)) {
    const base = entryBase(entry, toBase);
    if (!base) continue;
    const found: LockedSkill = { base };
    if (entry.skillPath !== undefined) {
      const dir = typeof entry.skillPath === 'string' ? skillDir(entry.skillPath) : null;
      if (dir === null) continue;
      found.subpath = dir;
    }
    if (entry.ref !== undefined) {
      if (typeof entry.ref !== 'string' || !REF.test(entry.ref) || entry.ref.includes('..')) continue;
      found.ref = entry.ref;
    }
    out.set(name, found);
  }
  return out;
}

/** Hash of a skill folder's files (names and bytes, links followed, agenthub's own additions left out), or null when it cannot be read. */
export function skillContentHash(dir: string): string | null {
  const hash = createHash('sha256');
  const walk = (d: string, rel: string, depth: number): void => {
    if (depth > 8) throw new Error('too deep');
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      // .git, and the agents/openai.yaml that agenthub itself projects for Codex
      if (name === '.git' || r === 'agents/openai.yaml') continue;
      if (fs.statSync(full).isDirectory()) walk(full, r, depth + 1);
      else hash.update(`${r}\0`).update(fs.readFileSync(full)).update('\0');
    }
  };
  try {
    walk(dir, '', 0);
    return hash.digest('hex');
  } catch {
    return null;
  }
}
