import { byCodeUnit } from '../utils/sort.js';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { isWithin } from '../utils/fs.js';

export interface DiscoveredSkill {
  name: string;
  /** Absolute folder of the skill */
  dir: string;
  /** Folder relative to the searched root, forward slashes; "" for a SKILL.md at the root */
  rel: string;
  description?: string;
}

/** Folders of a repo searched for skills, in order; the first skill with a given name wins. */
export const SKILL_DIRS = ['skills', 'skills/.curated', 'skills/.experimental', '.agents/skills', '.claude/skills'];
/** How many folder levels below a search folder a skill may sit: flat, or one or two category levels. */
export const MAX_DEPTH = 3;
const SKIP = new Set(['node_modules', '.git']);
const MAX_MANIFEST_BYTES = 1024 * 1024;

const isFile = (p: string): boolean => {
  try {
    return fs.lstatSync(p).isFile(); // a SKILL.md that is a symlink does not count
  } catch {
    return false;
  }
};

function frontmatter(dir: string): { name?: string; description?: string } {
  try {
    const text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8');
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const data = m ? parseYaml(m[1]) : null;
    if (!data || typeof data !== 'object') return {};
    const { name, description } = data as Record<string, unknown>;
    return {
      name: typeof name === 'string' ? name : undefined,
      description: typeof description === 'string' ? description.trim().split(/\r?\n/)[0] : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Finds skills in a checkout: a SKILL.md at the root (it shadows everything under it),
 * else the folders in SKILL_DIRS searched up to MAX_DEPTH levels deep, then the paths
 * listed in the `skills` arrays of .claude-plugin/marketplace.json and plugin.json.
 * With scanRoot, the root folder itself is searched too (for a path given in a URL).
 * A folder with a SKILL.md is a skill and is not searched further, so a shallower
 * SKILL.md shadows deeper ones. Symlinks are never followed.
 */
export function discoverSkills(root: string, options: DiscoverOptions = {}): DiscoveredSkill[] {
  return findSkills(root, options).skills;
}

export interface DiscoverOptions {
  scanRoot?: boolean;
  /** Name for a SKILL.md at the root that has no usable name of its own (default: the folder name) */
  rootName?: string;
}

/** discoverSkills, plus warnings: folders skipped for lack of a SKILL.md, and duplicate names. */
export function findSkills(root: string, options: DiscoverOptions = {}): { skills: DiscoveredSkill[]; warnings: string[] } {
  const realRoot = fs.realpathSync(root);
  const found: DiscoveredSkill[] = [];
  const warnings: string[] = [];
  const seenDirs = new Set<string>();

  const relOf = (dir: string): string => path.relative(realRoot, dir).split(path.sep).join('/');
  const add = (dir: string, name: string): void => {
    const real = fs.realpathSync(dir);
    if (seenDirs.has(real)) return;
    seenDirs.add(real);
    const first = found.find((s) => s.name === name);
    if (first) {
      warnings.push(`duplicate skill "${name}": using ${first.rel || '.'}, ignoring ${relOf(real) || '.'}`);
      return;
    }
    found.push({ name, dir: real, rel: relOf(real), description: frontmatter(real).description });
  };

  if (isFile(path.join(realRoot, 'SKILL.md'))) {
    const fm = frontmatter(realRoot).name;
    add(realRoot, fm && /^[A-Za-z0-9][\w.-]*$/.test(fm) ? fm : options.rootName ?? path.basename(realRoot));
    return { skills: found, warnings };
  }

  // Adds the skills below dir and returns how many it found, plus the folders that held none
  // (reported once, at their top).
  const scan = (dir: string, depth: number): { count: number; empty: string[] } => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return { count: 0, empty: [] };
    }
    let count = 0;
    const empty: string[] = [];
    for (const entry of entries.sort((a, b) => byCodeUnit(a.name, b.name))) {
      if (!entry.isDirectory() || SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
      const sub = path.join(dir, entry.name);
      if (isFile(path.join(sub, 'SKILL.md'))) {
        add(sub, entry.name);
        count++;
        continue;
      }
      const below = depth < MAX_DEPTH ? scan(sub, depth + 1) : { count: 0, empty: [] };
      count += below.count;
      if (below.count === 0) empty.push(sub);
      else empty.push(...below.empty);
    }
    return { count, empty };
  };
  const scanReporting = (dir: string): void => {
    for (const sub of scan(dir, 1).empty) warnings.push(`skipped ${relOf(sub)}: no SKILL.md`);
  };

  // a folder named on purpose (a URL path) is searched itself, not only its standard subfolders
  if (options.scanRoot) scan(realRoot, 1);

  for (const d of SKILL_DIRS) {
    const dir = path.join(realRoot, ...d.split('/'));
    try {
      if (fs.lstatSync(dir).isDirectory() && isWithin(realRoot, fs.realpathSync(dir))) scanReporting(dir);
    } catch {
      // not there
    }
  }

  for (const rel of pluginSkillPaths(realRoot)) {
    const dir = path.join(realRoot, rel);
    let real: string;
    try {
      real = fs.realpathSync(dir);
    } catch {
      continue;
    }
    if (!isWithin(realRoot, real) || !fs.statSync(real).isDirectory()) continue;
    if (isFile(path.join(real, 'SKILL.md'))) add(real, path.basename(real));
    else scanReporting(real);
  }
  return { skills: found, warnings };
}

/** A manifest path must be "./..." and stay inside the repo: no "..", no absolute or drive paths. */
function safeRelative(p: unknown): string | null {
  if (typeof p !== 'string' || !p.startsWith('./') || p.includes('\\') || p.includes('\0')) return null;
  const parts = p.slice(2).split('/').filter((s) => s !== '' && s !== '.');
  return parts.length > 0 && !parts.includes('..') ? parts.join('/') : null;
}

function readManifest(root: string, file: string): Record<string, unknown> | null {
  const p = path.join(root, '.claude-plugin', file);
  try {
    if (!fs.statSync(p).isFile() || fs.statSync(p).size > MAX_MANIFEST_BYTES) return null;
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

/** Skill paths (relative to root) named by Claude plugin manifests; unsafe entries are dropped. */
function pluginSkillPaths(root: string): string[] {
  const out: string[] = [];
  const take = (base: string, list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      const rel = safeRelative(item);
      if (rel) out.push(base ? `${base}/${rel}` : rel);
    }
  };
  const market = readManifest(root, 'marketplace.json');
  if (market) {
    take('', market.skills);
    if (Array.isArray(market.plugins)) {
      for (const plugin of market.plugins) {
        if (!plugin || typeof plugin !== 'object') continue;
        const { source, skills } = plugin as Record<string, unknown>;
        // a plugin may live in its own folder; its skills are relative to it
        const base = typeof source === 'string' ? safeRelative(source) : source === undefined ? '' : null;
        if (base !== null) take(base, skills);
      }
    }
  }
  const plugin = readManifest(root, 'plugin.json');
  if (plugin) take('', plugin.skills);
  return out;
}

/** Picks the named skills; an unknown name is an error that lists what exists. */
export function selectSkills(found: DiscoveredSkill[], wanted: string[]): DiscoveredSkill[] {
  if (wanted.length === 0) return found;
  const missing = wanted.filter((w) => !found.some((s) => s.name === w));
  if (missing.length > 0) {
    throw new Error(
      `Skill ${missing.map((m) => `"${m}"`).join(', ')} not found. ${found.length ? `Available: ${found.map((s) => s.name).join(', ')}` : 'No skills were found.'}`
    );
  }
  return found.filter((s) => wanted.includes(s.name));
}
