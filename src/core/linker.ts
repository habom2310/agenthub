import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import { backupSkillsDir, createJunction, ensureDir, isJunctionOrSymlink, isWithin, safeWriteFile } from '../utils/fs.js';
import { agentsSkillsDir, getHomeDir, getHubDir, windsurfDirFor, skillPlatform, SKILL_PLATFORMS, type SkillPlatform, type SkillPlatformId } from './detector.js';

export interface LinkResult {
  success: boolean;
  message: string;
}

/**
 * Links Claude skills to the central hub skills directory.
 * If Claude skills directory is a real directory (not junction/symlink),
 * migrates any existing skills into hub and renames to skills.old (or a timestamped skills.old.<ts> if that exists).
 */
export function linkSkillsForClaude(
  homeDir?: string,
  hubDir?: string
): LinkResult {
  const home = homeDir || getHomeDir();
  return linkSkillsDir(path.join(home, '.claude', 'skills'), hubDir || getHubDir(), 'Claude', home);
}

/**
 * Links Gemini skills by configuring ~/.gemini/config/skills.json.
 * Uses posix-style forward slashes for the resolved hub skills path.
 */
export function linkSkillsForGemini(
  homeDir?: string,
  hubDir?: string
): LinkResult {
  const home = homeDir || getHomeDir();
  const hub = hubDir || getHubDir();

  const geminiConfig = path.join(home, '.gemini', 'config');
  const skillsJsonPath = path.join(geminiConfig, 'skills.json');
  const hubSkillsPosix = path.resolve(hub, 'skills').replace(/\\/g, '/');

  let data: { entries?: Array<{ path?: string; [key: string]: unknown }> } = {
    entries: [],
  };

  if (fs.existsSync(skillsJsonPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(skillsJsonPath, 'utf-8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
          success: false,
          message: `Refusing to overwrite invalid or corrupt skills.json: ${skillsJsonPath}`,
        };
      }
      data = parsed;
    } catch {
      return {
        success: false,
        message: `Refusing to overwrite invalid or corrupt skills.json: ${skillsJsonPath}`,
      };
    }
  }

  if (!Array.isArray(data.entries)) {
    data.entries = [];
  }

  let found = false;
  for (const entry of data.entries) {
    const p = String(entry?.path || '');
    if (
      p === hubSkillsPosix ||
      p.includes('.agenthub') ||
      p.includes('agenthub') ||


      p.includes('.claude')
    ) {
      if (typeof entry === 'object' && entry !== null) {
        entry.path = hubSkillsPosix;
      }
      found = true;
      break;
    }
  }

  if (!found) {
    data.entries.push({ path: hubSkillsPosix });
  }

  safeWriteFile(skillsJsonPath, JSON.stringify(data, null, 2) + '\n');

  return {
    success: true,
    message: `Linked Gemini skills to ${hubSkillsPosix}`,
  };
}

/**
 * Gives Codex the hub skills. Codex loads user skills from ~/.agents/skills
 * (https://developers.openai.com/codex/skills), so that folder is linked and ~/.codex/skills,
 * which holds Codex's own .system folder, is left alone (a hub link there from an older
 * agenthub is removed and its skills.old restored).
 * If ~/.codex is not a directory, fails gracefully.
 * On success, projects Codex skill manifests (openai.yaml).
 */
export function linkSkillsForCodex(
  homeDir?: string,
  hubDir?: string
): LinkResult {
  const home = homeDir || getHomeDir();
  const hub = hubDir || getHubDir();

  const codexDir = path.join(home, '.codex');
  if (!fs.existsSync(codexDir) || !fs.statSync(codexDir).isDirectory()) {
    return {
      success: false,
      message: '~/.codex directory does not exist',
    };
  }

  const res = linkSkillsViaAgentsDir('codex', home, hub);
  if (res.success) projectCodexSkillManifests(hub);
  return res;
}

/**
 * The cross-agent folder ~/.agents/skills linked to the hub (a real folder is migrated like any
 * other). Migrating one means skills installed with `npx skills` move into the hub, so the result
 * says what that changes.
 */
export function linkAgentsSkills(homeDir?: string, hubDir?: string): LinkResult {
  const home = homeDir || getHomeDir();
  const dir = agentsSkillsDir(home);
  const migrating = isRealDir(dir) && fs.readdirSync(dir).some((e) => !e.endsWith('.old'));
  const res = linkSkillsDir(dir, hubDir || getHubDir(), '~/.agents', home);
  if (res.success && migrating) res.message += `. ${NPX_SKILLS_NOTICE}`;
  return res;
}

export const NPX_SKILLS_NOTICE =
  'Skills installed with `npx skills` were moved into the hub (the original folder is kept as ~/.agents/skills.old). ' +
  '`npx skills update` and `npx skills remove` now write into the hub. Run `agenthub adopt` to declare where they came from; ' +
  'until then agenthub keeps the skills named in ~/.agents/.skill-lock.json out of git';

function isRealDir(p: string): boolean {
  try {
    const st = fs.lstatSync(p);
    return !st.isSymbolicLink() && st.isDirectory();
  } catch {
    return false;
  }
}

/**
 * True when an assistant that gets the hub only through ~/.agents/skills is set up on this
 * machine. Its own folder (~/.codex, ~/.pi/agent) must exist: a binary on PATH alone writes nothing.
 */
export function needsAgentsSkillsLink(home: string): boolean {
  return SKILL_PLATFORMS.some((p) => p.readsAgentsDir && !p.linksOwnDir && p.detected(home) && isRealDir(path.dirname(p.skillsDir(home))));
}

/**
 * Links ~/.agents/skills when an assistant needs it. It must come before any other skills link:
 * an assistant folder that holds links into ~/.agents/skills (the `npx skills` layout) would
 * otherwise be copied into the hub as links that loop once ~/.agents/skills links to the hub.
 * linkSkillsForAllAssistants, doctor --fix and connect all call this first.
 */
export function linkAgentsSkillsFirst(home: string, hub: string): LinkResult | undefined {
  return needsAgentsSkillsLink(home) ? linkAgentsSkills(home, hub) : undefined;
}

/**
 * Codex and Pi: links ~/.agents/skills and releases the assistant's own folder (falling back to
 * linking its own folder when ~/.agents/skills cannot be linked). Pi's own ~/.pi/agent/skills is
 * otherwise left alone.
 */
export function linkSkillsViaAgentsDir(id: 'codex' | 'pi', homeDir?: string, hubDir?: string): LinkResult {
  const home = homeDir || getHomeDir();
  const hub = hubDir || getHubDir();
  const p = skillPlatform(id);
  const own = p.skillsDir(home);
  const canonical = linkAgentsSkills(home, hub);
  if (!canonical.success) return linkSkillsDir(own, hub, p.label, home);
  releaseHubLink(own, hub, true);
  const notice = canonical.message.includes(NPX_SKILLS_NOTICE) ? `. ${NPX_SKILLS_NOTICE}` : '';
  return { success: true, message: `${p.label} loads hub skills through ${agentsSkillsDir(home)}${notice}` };
}

/**
 * Removes `dir` when it links to the hub skills. With restoreOld, the skills.old that linking
 * left there comes back, but only in this same call and only into the place just freed.
 */
function releaseHubLink(dir: string, hub: string, restoreOld: boolean): void {
  if (!isLinkTo(dir, path.join(hub, 'skills'))) return;
  try {
    fs.unlinkSync(dir);
  } catch {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const old = path.join(path.dirname(dir), 'skills.old');
  if (restoreOld && isRealDir(old) && !exists(dir)) fs.renameSync(old, dir);
}

/** lstat-based: a dangling link counts as there. */
function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function toTitleCase(str: string): string {
  return str
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function getFirstSentence(desc: string): string {
  if (!desc) return '';
  const trimmed = desc.trim();
  const match = trimmed.match(/^([^.!?\r\n]+[.!?]?)/);
  let sentence = match ? match[1].trim() : trimmed;
  if (sentence.length > 80) {
    sentence = sentence.slice(0, 80).trim();
  }
  return sentence;
}

/**
 * Projects Codex skill manifests (agents/openai.yaml) for skills in hubDir/skills.
 */
export function projectCodexSkillManifests(
  hubDir?: string
): LinkResult {
  const hub = hubDir || getHubDir();
  const skillsDir = path.join(hub, 'skills');

  if (!fs.existsSync(skillsDir) || !fs.statSync(skillsDir).isDirectory()) {
    return {
      success: true,
      message: 'No skills directory found to project manifests',
    };
  }

  const generated: string[] = [];
  const entries = fs.readdirSync(skillsDir);

  for (const entry of entries) {
    const skillPath = path.join(skillsDir, entry);
    try {
      if (!fs.statSync(skillPath).isDirectory()) continue;
    } catch {
      continue;
    }

    const skillMdPath = path.join(skillPath, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) continue;

    const manifestPath = path.join(skillPath, 'agents', 'openai.yaml');
    if (fs.existsSync(manifestPath)) continue;

    let name = entry;
    let description = '';

    const content = fs.readFileSync(skillMdPath, 'utf-8');
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fmMatch) {
      try {
        const parsed = yaml.parse(fmMatch[1]);
        if (parsed && typeof parsed === 'object') {
          if (parsed.name && typeof parsed.name === 'string') {
            name = parsed.name.trim();
          }
          if (parsed.description && typeof parsed.description === 'string') {
            description = parsed.description.trim();
          }
        }
      } catch {
        const nameMatch = fmMatch[1].match(/^name:\s*(.+)$/m);
        if (nameMatch) name = nameMatch[1].trim().replace(/^["']|["']$/g, '');
        const descMatch = fmMatch[1].match(/^description:\s*(.+)$/m);
        if (descMatch) description = descMatch[1].trim().replace(/^["']|["']$/g, '');
      }
    }

    const displayName = toTitleCase(name);
    const shortDesc = getFirstSentence(description);

    const yamlContent = yaml.stringify({
      interface: {
        display_name: displayName,
        short_description: shortDesc,
        default_prompt: `Use ${name} skill for this task.`,
      },
    });

    safeWriteFile(manifestPath, yamlContent);
    generated.push(name);
  }

  return {
    success: true,
    message: `Generated ${generated.length} Codex skill manifest(s)`,
  };
}

/** True when linkPath is a symlink/junction that resolves to targetPath. */
export function isLinkTo(linkPath: string, targetPath: string): boolean {
  try {
    if (!fs.existsSync(linkPath) || !isJunctionOrSymlink(linkPath)) return false;
    const linkReal = fs.realpathSync(linkPath);
    let targetReal: string;
    try {
      targetReal = fs.realpathSync(targetPath);
    } catch {
      targetReal = path.resolve(targetPath);
    }
    return process.platform === 'win32' ? linkReal.toLowerCase() === targetReal.toLowerCase() : linkReal === targetReal;
  } catch {
    return false;
  }
}

const realOrNull = (p: string): string | null => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};

/** The skills folders agenthub links or reads: a link into one of them is content agenthub manages. */
function managedSkillRoots(home: string, hubSkills: string): string[] {
  const roots = [hubSkills, agentsSkillsDir(home), path.join(windsurfDirFor(home), 'skills')];
  for (const p of SKILL_PLATFORMS) roots.push(p.skillsDir(home), ...p.alsoReads(home));
  return roots.map((r) => realOrNull(r) ?? path.resolve(r));
}

/**
 * Links a skills directory to the hub: a real directory is first copied into the
 * hub (existing hub skills win) and renamed to skills.old, then the link is made.
 * An entry that is a link into a folder agenthub manages (the `npx skills` layout: ~/.claude/skills/x
 * -> ~/.agents/skills/x) is copied as content, since that folder is about to become a link to the hub;
 * links to anywhere else (tool-managed folders) stay links. A hub entry that resolves to itself
 * is removed and reported.
 */
function linkSkillsDir(skillsDir: string, hub: string, label: string, home: string): LinkResult {
  const hubSkills = path.join(hub, 'skills');
  ensureDir(hubSkills);

  let lstat: fs.Stats | null = null;
  try {
    lstat = fs.lstatSync(skillsDir);
  } catch {
    lstat = null;
  }

  if (lstat && !lstat.isSymbolicLink() && lstat.isDirectory()) {
    try {
      const managed = managedSkillRoots(home, hubSkills);
      const moving = realOrNull(skillsDir) ?? skillsDir;
      for (const entry of fs.readdirSync(skillsDir)) {
        if (entry.endsWith('.old')) continue; // backups, such as the <name>.old that adopt leaves
        const src = path.join(skillsDir, entry);
        const destPath = path.join(hubSkills, entry);
        const real = isJunctionOrSymlink(src) ? realOrNull(src) : null;
        const source = real && managed.some((r) => isWithin(r, real)) ? real : src;
        if (exists(destPath)) {
          // a hub link into the folder being moved would dangle (or loop) once that folder links to the hub
          const into = isJunctionOrSymlink(destPath) ? realOrNull(destPath) : null;
          if (!into || !isWithin(moving, into)) continue;
          fs.rmSync(destPath, { force: true });
        }
        if (path.resolve(source) !== path.resolve(destPath)) fs.cpSync(source, destPath, { recursive: true });
      }
      backupSkillsDir(skillsDir);
    } catch (err) {
      return { success: false, message: `Failed to migrate skills: ${(err as Error).message}` };
    }
  }

  const loops = removeSelfLinks(hubSkills);
  if (!createJunction(hubSkills, skillsDir)) {
    return { success: false, message: `Failed to create junction from ${skillsDir} to ${hubSkills}` };
  }
  const note = loops.length ? `; removed hub skill link(s) that resolved to themselves: ${loops.join(', ')} (restore them from skills.old)` : '';
  return { success: true, message: `Linked ${label} skills to ${hubSkills}${note}` };
}

/** Removes hub entries that are links resolving to themselves (ELOOP); returns their names. */
function removeSelfLinks(hubSkills: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(hubSkills)) {
    const p = path.join(hubSkills, entry);
    try {
      if (!fs.lstatSync(p).isSymbolicLink()) continue;
      fs.realpathSync(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ELOOP') continue;
      fs.rmSync(p, { force: true });
      out.push(entry);
    }
  }
  return out;
}

/**
 * Another folder an assistant loads (~/.agents/skills, and for Cursor ~/.claude/skills and
 * ~/.codex/skills) that already links to the hub: its own link would list every skill twice
 * (https://cursor.com/docs/skills). Returns that folder, or null.
 */
export function skillsProvider(p: SkillPlatform, homeDir: string, hubDir: string): string | null {
  if (!p.readsAgentsDir) return null;
  const hubSkills = path.join(hubDir, 'skills');
  const own = p.skillsDir(homeDir);
  return p.alsoReads(homeDir).find((r) => r !== own && isLinkTo(r, hubSkills)) ?? null;
}

export const cursorSkillsProvider = (homeDir: string, hubDir: string): string | null => skillsProvider(skillPlatform('cursor'), homeDir, hubDir);

/**
 * Links an assistant's own skills folder unless another folder it loads already provides the
 * hub skills. An existing hub link in its own folder is then removed so skills are not shown
 * twice. A real folder is left untouched.
 */
function linkUnlessProvided(p: SkillPlatform, skillsDir: string, home: string, hub: string): LinkResult {
  const provider = skillsProvider(p, home, hub);
  if (!provider) return linkSkillsDir(skillsDir, hub, p.label, home);
  releaseHubLink(skillsDir, hub, false);
  return {
    success: true,
    message: `${p.label} loads hub skills through ${provider}; not linking ${skillsDir} (it would list every skill twice)`,
  };
}

/** Links Cursor skills (~/.cursor/skills) unless ~/.agents/skills, Claude or Codex already provide them. */
export function linkSkillsForCursor(homeDir?: string, hubDir?: string, cursorDir?: string): LinkResult {
  const home = homeDir || getHomeDir();
  const hub = hubDir || getHubDir();
  return linkUnlessProvided(skillPlatform('cursor'), path.join(cursorDir || path.join(home, '.cursor'), 'skills'), home, hub);
}

export function linkSkillsForWindsurf(homeDir?: string, hubDir?: string, windsurfDir?: string): LinkResult {
  const home = homeDir || getHomeDir();
  const hub = hubDir || getHubDir();
  return linkUnlessProvided(skillPlatform('windsurf'), path.join(windsurfDir || windsurfDirFor(home), 'skills'), home, hub);
}

/** Copilot CLI reads personal skills from ~/.copilot/skills and ~/.agents/skills, not ~/.claude/skills. */
export function linkSkillsForCopilot(homeDir?: string, hubDir?: string): LinkResult {
  const home = homeDir || getHomeDir();
  const hub = hubDir || getHubDir();
  return linkUnlessProvided(skillPlatform('copilot'), path.join(home, '.copilot', 'skills'), home, hub);
}

/** Where `p` gets the hub skills: its own folder, another folder it loads, or null. */
export function skillsReachedVia(p: SkillPlatform, homeDir: string, hubDir: string): string | null {
  const own = p.skillsDir(homeDir);
  return isLinkTo(own, path.join(hubDir, 'skills')) ? own : skillsProvider(p, homeDir, hubDir);
}

export interface LinkAllSkillsResult {
  /** ~/.agents/skills, linked when Codex or Pi is detected */
  agents?: LinkResult;
  claude: LinkResult;
  gemini: LinkResult;
  codex?: LinkResult;
  cursor?: LinkResult;
  windsurf?: LinkResult;
  copilot?: LinkResult;
  pi?: LinkResult;
}

/**
 * Links skills across all detected assistant platforms (Claude, Gemini, Codex,
 * Cursor, Windsurf, Copilot CLI, Pi). ~/.agents/skills is linked first when Codex or Pi
 * is detected, so the assistants that also read it skip their own link.
 */
export function linkSkillsForAllAssistants(
  optionsOrHome?: string | { homeDir?: string; hubDir?: string },
  hubDir?: string
): LinkAllSkillsResult {
  let home: string | undefined;
  let hub: string | undefined;
  if (typeof optionsOrHome === 'object' && optionsOrHome !== null) {
    home = optionsOrHome.homeDir;
    hub = optionsOrHome.hubDir;
  } else {
    home = optionsOrHome;
    hub = hubDir;
  }
  const effectiveHome = home || getHomeDir();
  const effectiveHub = hub || getHubDir();
  const linkers: Record<SkillPlatformId, () => LinkResult> = {
    claude: () => linkSkillsForClaude(effectiveHome, effectiveHub),
    codex: () => linkSkillsForCodex(effectiveHome, effectiveHub),
    cursor: () => linkSkillsForCursor(effectiveHome, effectiveHub),
    windsurf: () => linkSkillsForWindsurf(effectiveHome, effectiveHub),
    copilot: () => linkSkillsForCopilot(effectiveHome, effectiveHub),
    pi: () => linkSkillsViaAgentsDir('pi', effectiveHome, effectiveHub),
  };
  const agents = linkAgentsSkillsFirst(effectiveHome, effectiveHub);
  const results: Partial<Record<SkillPlatformId, LinkResult>> = {};
  // Claude and Gemini are always linked (Claude's folder is created); the rest only when detected
  for (const p of SKILL_PLATFORMS) {
    if (p.id === 'claude' || p.detected(effectiveHome)) results[p.id] = linkers[p.id]();
  }
  const gemini = linkSkillsForGemini(effectiveHome, effectiveHub);
  projectCodexSkillManifests(effectiveHub);
  const { claude, codex, cursor, windsurf, copilot, pi } = results;

  return { agents, claude: claude as LinkResult, gemini, codex, cursor, windsurf, copilot, pi };
}
