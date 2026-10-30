import fs from 'node:fs';
import path from 'node:path';
import { getHomeDir, getHubDir } from './detector.js';
import { runDoctor, type DoctorResult } from './doctor.js';
import { hasDeclaredSources, itemLabel, planInstall } from './installer.js';
import { isLinkTo, linkSkillsForAllAssistants } from './linker.js';
import { probeMcpServers } from './mcp-probe.js';
import { expandServerPaths, readJsonSafely, syncMcpServers, type McpServerConfig } from './mcp-sync.js';
import {
  assistantSkillRoots,
  checkSkillDir,
  findDuplicateSkills,
  listSkillEntries,
  skillResolves,
  type CheckLevel,
} from './skill-check.js';
import { loadDeclaredSources, loadLock, pinOf, runtime } from './sources.js';

export type DoctorGroup = 'setup' | 'skills' | 'sources' | 'mcp';

export interface DoctorItem {
  group: DoctorGroup;
  name: string;
  level: CheckLevel;
  message: string;
}

export interface FullDoctorOptions {
  fix?: boolean;
  homeDir?: string;
  hubDir?: string;
  /** Run the checks that execute hub-declared commands (MCP probes, custom checks) */
  functional?: boolean;
  timeoutSec?: number;
  concurrency?: number;
  clientVersion?: string;
  /** Offers the install flow (with its own consent) for --fix; resolves to blockers */
  installFlow?: () => Promise<string[]>;
}

export interface FullDoctorResult {
  items: DoctorItem[];
  repairs: string[];
  notes: string[];
  counts: Record<CheckLevel, number>;
  ok: boolean;
}

export const countLevels = (items: DoctorItem[]): Record<CheckLevel, number> => {
  const counts: Record<CheckLevel, number> = { PASS: 0, WARN: 0, FAIL: 0 };
  for (const i of items) counts[i.level]++;
  return counts;
};

const worst = (levels: CheckLevel[]): CheckLevel => (levels.includes('FAIL') ? 'FAIL' : levels.includes('WARN') ? 'WARN' : 'PASS');

export function structuralItems(res: Pick<DoctorResult, 'passed_checks' | 'issues'>): DoctorItem[] {
  return [
    ...res.passed_checks.map((m): DoctorItem => ({ group: 'setup', name: m, level: 'PASS', message: m })),
    ...res.issues.map((m): DoctorItem => ({ group: 'setup', name: m, level: 'FAIL', message: m })),
  ];
}

function hubServers(hub: string, home: string): Record<string, McpServerConfig> {
  const read = readJsonSafely<{ mcpServers?: Record<string, McpServerConfig> }>(path.join(hub, 'mcp', 'servers.json'));
  const raw = read.data.mcpServers;
  const out: Record<string, McpServerConfig> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [name, cfg] of Object.entries(raw)) if (cfg && typeof cfg === 'object') out[name] = expandServerPaths(cfg, home, hub);
  }
  return out;
}

// ---- MCP: start each server and list its tools ----

/** What a probe would start, one line per hub server, expanded as it would run. */
export function probeTargets(home: string, hub: string): string[] {
  return Object.entries(hubServers(hub, home)).map(([name, cfg]) =>
    typeof cfg.url === 'string' && !cfg.command
      ? `${name}: connect to ${cfg.url.replace(/\/\/[^/@]*@/, '//').replace(/\?.*$/, '')}`
      : `${name}: ${[cfg.command, ...(cfg.args ?? [])].filter((x) => x !== undefined).join(' ')}`
  );
}

export async function mcpItems(home: string, hub: string, options: FullDoctorOptions): Promise<DoctorItem[]> {
  const servers = hubServers(hub, home);
  const results = await probeMcpServers(servers, {
    timeoutMs: (options.timeoutSec ?? 20) * 1000,
    concurrency: options.concurrency ?? 4,
    clientVersion: options.clientVersion,
    home,
  });
  return results.map((r): DoctorItem => ({
    group: 'mcp',
    name: r.name,
    level: r.status === 'PASS' ? 'PASS' : r.status === 'SKIP' || r.status === 'WARN' ? 'WARN' : 'FAIL',
    message: r.status === 'PASS' ? `${r.message} (${(r.ms / 1000).toFixed(1)}s)` : r.message,
  }));
}

// ---- skills: files, links, duplicates ----

function geminiSkillPaths(home: string): string[] {
  const p = path.join(home, '.gemini', 'config', 'skills.json');
  const read = readJsonSafely<{ entries?: Array<{ path?: string }> }>(p);
  const entries = Array.isArray(read.data.entries) ? read.data.entries : [];
  return entries.map((e) => (typeof e?.path === 'string' ? e.path : '')).filter(Boolean);
}

function skillName(entry: string): string {
  return `skill ${entry}`;
}

export function skillItems(home: string, hub: string): DoctorItem[] {
  const items: DoctorItem[] = [];
  const hubSkills = path.join(hub, 'skills');
  const hubNames: string[] = [];

  for (const entry of fs.existsSync(hubSkills) ? fs.readdirSync(hubSkills).sort() : []) {
    if (entry.startsWith('.')) continue;
    const dir = path.join(hubSkills, entry);
    try {
      fs.lstatSync(dir);
    } catch {
      continue;
    }
    if (!fs.existsSync(dir)) {
      items.push({ group: 'skills', name: skillName(entry), level: 'FAIL', message: `broken link ${path.relative(hub, dir)} (run: agenthub install)` });
      continue;
    }
    if (!fs.statSync(dir).isDirectory()) continue;
    hubNames.push(entry);
    const issues = checkSkillDir(dir, entry);
    items.push({
      group: 'skills',
      name: skillName(entry),
      level: worst(issues.map((i) => i.level)),
      message: issues.length === 0 ? 'SKILL.md valid' : issues.map((i) => i.message).join('; '),
    });
  }

  for (const a of assistantSkillRoots(home, geminiSkillPaths(home))) {
    // hub skills must resolve through the paths this assistant reads
    const unresolved = hubNames.filter((n) => !a.roots.some((r) => skillResolves(r, n).ok));
    if (hubNames.length > 0) {
      items.push({
        group: 'skills',
        name: `${a.label} skills`,
        level: unresolved.length ? 'FAIL' : 'PASS',
        message: unresolved.length
          ? `${unresolved.join(', ')} do not resolve to a readable SKILL.md (run: agenthub link)`
          : `${hubNames.length} hub skill(s) resolve`,
      });
    }

    // skills that live only in this assistant's own folder
    if (a.linked && fs.existsSync(a.linked) && !isLinkTo(a.linked, hubSkills) && !fs.lstatSync(a.linked).isSymbolicLink()) {
      const own = listSkillEntries(a.linked).filter((n) => !hubNames.includes(n));
      const problems = own.flatMap((n) => checkSkillDir(path.join(a.linked as string, n), n).map((i) => ({ ...i, message: `${n}: ${i.message}` })));
      if (own.length > 0) {
        items.push({
          group: 'skills',
          name: `${a.label} own skills`,
          level: worst(problems.map((p) => p.level)),
          message: problems.length ? problems.map((p) => p.message).join('; ') : `${own.length} skill(s) in ${a.linked} valid`,
        });
      }
    }

    // the same skill name loaded twice by one assistant
    const dups = findDuplicateSkills(a.roots).filter((d) => d.conflicting || (a.linked && d.paths.some((p) => path.dirname(p) === a.linked)));
    for (const d of dups) {
      items.push({
        group: 'skills',
        name: `${a.label} duplicate ${d.name}`,
        level: 'WARN',
        message: d.conflicting
          ? `"${d.name}" comes from different folders: ${d.paths.join(', ')}`
          : `"${d.name}" is listed twice: ${d.paths.join(', ')} (run: agenthub link)`,
      });
    }
    if (dups.length === 0) items.push({ group: 'skills', name: `${a.label} duplicates`, level: 'PASS', message: 'no skill name is loaded twice' });
  }
  return items;
}

// ---- declared sources: manifest vs lockfile vs installed ----

export async function sourceItems(hub: string, functional: boolean): Promise<DoctorItem[]> {
  const items: DoctorItem[] = [];
  const { sources } = loadDeclaredSources(hub);
  if (!hasDeclaredSources(hub)) return items;
  const plan = await planInstall(hub);
  const locked = loadLock(hub);

  for (const e of plan.errors) items.push({ group: 'sources', name: e.item, level: 'FAIL', message: e.message });
  for (const w of plan.warnings) items.push({ group: 'sources', name: 'warning', level: 'WARN', message: w });

  for (const d of sources) {
    const label = itemLabel(d.kind, d.name);
    if (plan.errors.some((e) => e.item === label)) continue;

    if (d.parsed.type === 'custom') {
      if (!functional) continue;
      const res = runtime.shell(d.parsed.check, hub);
      items.push({
        group: 'sources',
        name: label,
        level: res.status === 0 ? 'PASS' : 'FAIL',
        message: res.status === 0 ? `check passed: ${d.parsed.check}` : `check failed (exit ${res.status}): ${d.parsed.check}; install: ${d.parsed.install || 'not declared'}`,
      });
      continue;
    }

    const action = plan.actions.find((a) => a.item === d.name && a.kind === d.kind);
    const pin = plan.lock[d.kind][d.name];
    const notLocked = pin !== undefined && pinOf(locked[d.kind][d.name]) !== pinOf(pin);
    if (action) {
      items.push({ group: 'sources', name: label, level: 'WARN', message: `${action.reason}, not installed at the declared version (run: agenthub install)` });
    } else if (notLocked) {
      items.push({ group: 'sources', name: label, level: 'WARN', message: 'declared but not in agenthub.lock.json (run: agenthub install)' });
    } else {
      items.push({ group: 'sources', name: label, level: 'PASS', message: `${d.spec}${pin ? ` @ ${(pinOf(pin) ?? '').slice(0, 12)}` : ''} installed` });
    }
  }
  return items;
}

/**
 * The checks beyond file structure. Skill and source checks read files only; the
 * MCP probes and custom `check` commands run what the hub declares, so they run
 * only with options.functional (the caller must have user intent).
 */
export async function runFunctionalChecks(options: FullDoctorOptions = {}): Promise<DoctorItem[]> {
  const home = options.homeDir || getHomeDir();
  const hub = options.hubDir || getHubDir();
  const items: DoctorItem[] = [];
  const functional = options.functional !== false;

  try {
    items.push(...skillItems(home, hub));
  } catch (err) {
    items.push({ group: 'skills', name: 'skills', level: 'FAIL', message: (err as Error).message });
  }
  try {
    items.push(...(await sourceItems(hub, functional)));
  } catch (err) {
    items.push({ group: 'sources', name: 'sources', level: 'FAIL', message: (err as Error).message });
  }
  if (functional) items.push(...(await mcpItems(home, hub, options)));
  return items;
}

/** Structural checks plus the functional ones, optionally repairing first. */
export async function runFullDoctor(options: FullDoctorOptions = {}): Promise<FullDoctorResult> {
  const homeDir = options.homeDir || getHomeDir();
  const hubDir = options.hubDir || getHubDir();
  const repairs: string[] = [];
  const notes: string[] = [];

  if (options.fix) {
    if (options.installFlow && hasDeclaredSources(hubDir)) {
      const blockers = await options.installFlow();
      if (blockers.length > 0) notes.push(`install flow left ${blockers.length} problem(s)`);
    }
    linkSkillsForAllAssistants({ homeDir, hubDir });
    repairs.push(...syncMcpServers({ homeDir, hubDir, force: true }).actions.filter((a) => !a.startsWith('All MCP')));
  }

  const structural = runDoctor({ fix: options.fix, force: options.fix, homeDir, hubDir });
  repairs.push(...structural.repairs);

  const items = structuralItems(structural);
  items.push(...(await runFunctionalChecks({ ...options, homeDir, hubDir })));
  if (options.functional === false) notes.push('MCP probes and custom checks skipped (--no-functional)');

  const counts = countLevels(items);
  return { items, repairs, notes, counts, ok: counts.FAIL === 0 };
}
