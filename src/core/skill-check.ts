import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import { isJunctionOrSymlink } from '../utils/fs.js';
import { SKILL_PLATFORMS } from './detector.js';

export type CheckLevel = 'PASS' | 'INFO' | 'WARN' | 'FAIL';

export interface SkillIssue {
  level: Exclude<CheckLevel, 'PASS'>;
  message: string;
}

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// what Claude Code loads without complaint: word characters, dots and hyphens
const CLAUDE_NAME_RE = /^\w[\w.-]*$/;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;

export function parseSkillFrontmatter(content: string): { data: Record<string, unknown> | null; error?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content.replace(/^﻿/, ''));
  if (!match) return { data: null, error: 'no frontmatter block (--- ... ---) at the top of SKILL.md' };
  try {
    const data = yaml.parse(match[1]);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { data: null, error: 'frontmatter is not a YAML mapping' };
    return { data: data as Record<string, unknown> };
  } catch (err) {
    return { data: null, error: `frontmatter is not valid YAML: ${(err as Error).message.split('\n')[0]}` };
  }
}

/** Relative targets of markdown links, ignoring fenced code, urls, anchors and absolute paths. */
export function relativeLinks(content: string): string[] {
  const text = content.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '');
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<!\!)\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    let target = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('/') || target.startsWith('~')) continue;
    target = target.replace(/[#?].*$/, '');
    if (target) out.add(decodeURI(target));
  }
  return [...out];
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...listFiles(full));
      else if (e.isFile()) out.push(full);
    }
  } catch {
    // unreadable folder
  }
  return out;
}

function hasShebang(file: string): boolean {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(2);
    return fs.readSync(fd, buf, 0, 2, 0) === 2 && buf.toString('latin1') === '#!';
  } finally {
    fs.closeSync(fd);
  }
}

/** Validates one skill folder. `folderName` is the name it is linked under. */
export function checkSkillDir(dir: string, folderName: string): SkillIssue[] {
  const issues: SkillIssue[] = [];
  const skillMd = path.join(dir, 'SKILL.md');
  let content: string;
  try {
    content = fs.readFileSync(skillMd, 'utf-8');
  } catch {
    return [{ level: 'FAIL', message: 'SKILL.md is missing or unreadable' }];
  }

  const { data, error } = parseSkillFrontmatter(content);
  if (!data) {
    issues.push({ level: 'FAIL', message: error as string });
  } else {
    const name = data.name;
    if (typeof name !== 'string' || !name.trim()) {
      issues.push({ level: 'FAIL', message: 'frontmatter has no name' });
    } else {
      if (!CLAUDE_NAME_RE.test(name)) {
        issues.push({ level: 'FAIL', message: `name "${name}" must be letters, digits, hyphens or underscores without spaces` });
      } else if (!NAME_RE.test(name)) {
        issues.push({ level: 'WARN', message: `name "${name}" loads in Claude Code but is not portable to some assistants (the Agent Skills format uses lowercase letters, digits and single hyphens)` });
      } else if (name.length > MAX_NAME) {
        issues.push({ level: 'WARN', message: `name is ${name.length} characters (max ${MAX_NAME})` });
      }
      // Claude Code identifies a skill by its folder, so a different name does not stop it loading
      if (name !== folderName) issues.push({ level: 'WARN', message: `name "${name}" does not match the folder name "${folderName}"` });
    }
    const description = data.description;
    if (typeof description !== 'string' || !description.trim()) {
      issues.push({ level: 'FAIL', message: 'frontmatter has no description' });
    } else if (description.length > MAX_DESCRIPTION) {
      issues.push({ level: 'FAIL', message: `description is ${description.length} characters (max ${MAX_DESCRIPTION})` });
    }
  }

  const missing = relativeLinks(content).filter((rel) => !fs.existsSync(path.resolve(dir, rel)));
  if (missing.length > 0) issues.push({ level: 'WARN', message: `SKILL.md links to missing file(s): ${missing.join(', ')}` });

  if (process.platform !== 'win32') {
    // only a file that starts with #! is meant to be run directly; data files and `python x.py` scripts are not
    const scripts = listFiles(path.join(dir, 'scripts')).filter((f) => {
      try {
        return (fs.statSync(f).mode & 0o111) === 0 && hasShebang(f);
      } catch {
        return false;
      }
    });
    if (scripts.length > 0) {
      const shown = scripts.slice(0, 3).map((f) => path.relative(dir, f)).join(', ');
      issues.push({ level: 'WARN', message: `not executable: ${shown}${scripts.length > 3 ? ` (+${scripts.length - 3} more)` : ''}` });
    }
  }
  return issues;
}

// ---- where each assistant looks for skills ----

export interface SkillRoots {
  id: string;
  label: string;
  /** Directories the assistant loads user-level skills from, in its documented order */
  roots: string[];
  /** The directory agenthub links for it, if any */
  linked?: string;
}

/**
 * User-level skill directories per detected assistant (docs: cursor.com/docs/skills,
 * docs.github.com Copilot CLI skills, docs.devin.ai for Windsurf).
 */
export function assistantSkillRoots(home: string, geminiHubPaths: string[] = []): SkillRoots[] {
  const out: SkillRoots[] = SKILL_PLATFORMS.filter((p) => p.detected(home)).map((p) => ({
    id: p.id,
    label: p.label,
    // the assistant's own folder first, then the others it also loads
    roots: [p.skillsDir(home), ...p.alsoReads(home)],
    linked: p.skillsDir(home),
  }));
  if (fs.existsSync(path.join(home, '.gemini')) && geminiHubPaths.length > 0) {
    out.push({ id: 'gemini', label: 'Antigravity', roots: geminiHubPaths });
  }
  return out;
}

export function listSkillEntries(root: string): string[] {
  try {
    return fs.readdirSync(root).filter((n) => {
      try {
        return fs.statSync(path.join(root, n)).isDirectory();
      } catch {
        return isJunctionOrSymlink(path.join(root, n)); // broken link, reported by the caller
      }
    });
  } catch {
    return [];
  }
}

function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

export interface DuplicateSkill {
  name: string;
  paths: string[];
  /** True when the paths are different folders, not one folder reached twice */
  conflicting: boolean;
}

/** Skill names an assistant sees more than once, with the paths that provide them. */
export function findDuplicateSkills(roots: string[]): DuplicateSkill[] {
  const seen = new Map<string, string[]>();
  for (const root of new Set(roots)) {
    for (const entry of listSkillEntries(root)) {
      const skillMd = path.join(root, entry, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      let name = entry;
      try {
        const fm = parseSkillFrontmatter(fs.readFileSync(skillMd, 'utf-8')).data;
        if (fm && typeof fm.name === 'string' && fm.name.trim()) name = fm.name.trim();
      } catch {
        // keep the folder name
      }
      seen.set(name, [...(seen.get(name) ?? []), path.join(root, entry)]);
    }
  }
  const dups: DuplicateSkill[] = [];
  for (const [name, paths] of seen) {
    if (paths.length < 2) continue;
    const reals = new Set(paths.map((p) => realOrNull(path.join(p, 'SKILL.md')) ?? p));
    dups.push({ name, paths, conflicting: reals.size > 1 });
  }
  return dups;
}

/** True when `<root>/<name>/SKILL.md` resolves to a readable file. */
export function skillResolves(root: string, name: string): { ok: boolean; real: string | null } {
  const real = realOrNull(path.join(root, name, 'SKILL.md'));
  if (!real) return { ok: false, real: null };
  try {
    fs.accessSync(real, fs.constants.R_OK);
    return { ok: true, real };
  } catch {
    return { ok: false, real };
  }
}

// ---- assistant-managed collections ----

/** Assistants known to write a skills subfolder themselves. */
const COLLECTION_OWNERS: Record<string, string> = {
  synced: 'Claude',
  '.system': 'Codex',
  'codex-primary-runtime': 'Codex',
};

function countNestedSkills(dir: string, depth = 0): number {
  if (depth > 6) return 0;
  let n = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== 'node_modules') n += countNestedSkills(path.join(dir, e.name), depth + 1);
      else if (e.name === 'SKILL.md' && depth > 0) n++;
    }
  } catch {
    // unreadable folder
  }
  return n;
}

export interface SkillCollection {
  nested: number;
  owner?: string;
  /** known: a folder an assistant is known to write; dot: any dot-directory; unknown: nested skills, owner unknown */
  kind: 'known' | 'dot' | 'unknown';
}

/**
 * A top-level skills folder with no SKILL.md of its own: a known assistant-managed
 * folder (synced/, .system/, codex-primary-runtime/), another dot-directory, or a folder
 * that holds nested skills (kind "unknown": agenthub does not manage it).
 * Returns null for a skill, a file, or a folder with none of those.
 */
export function skillCollection(skillsDir: string, entry: string): SkillCollection | null {
  const dir = path.join(skillsDir, entry);
  try {
    if (fs.lstatSync(dir).isSymbolicLink() || !fs.statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  if (fs.existsSync(path.join(dir, 'SKILL.md'))) return null;
  const nested = countNestedSkills(dir);
  const owner = COLLECTION_OWNERS[entry];
  if (owner) return { nested, owner, kind: 'known' };
  if (entry.startsWith('.')) return { nested, kind: 'dot' };
  return nested > 0 ? { nested, kind: 'unknown' } : null;
}

/** Collections agenthub keeps out of git: known owners and dot-directories. */
export function listSkillCollections(skillsDir: string): string[] {
  try {
    return fs
      .readdirSync(skillsDir)
      .filter((n) => {
        const c = skillCollection(skillsDir, n);
        return c !== null && c.kind !== 'unknown';
      })
      .sort();
  } catch {
    return [];
  }
}
