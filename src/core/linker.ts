import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import { backupSkillsDir, createJunction, ensureDir, isJunctionOrSymlink, safeWriteFile } from '../utils/fs.js';
import { getHomeDir, getHubDir, windsurfDirFor, SKILL_PLATFORMS, type SkillPlatformId } from './detector.js';

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
  return linkSkillsDir(path.join(homeDir || getHomeDir(), '.claude', 'skills'), hubDir || getHubDir(), 'Claude');
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
 * Links Codex skills to the central hub skills directory.
 * If ~/.codex is not a directory, fails gracefully.
 * If codex skills is a real directory, migrates contents and backs up to skills.old (or a timestamped skills.old.<ts> if that exists).
 * On junction creation, projects Codex skill manifests (openai.yaml).
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

  const res = linkSkillsDir(path.join(codexDir, 'skills'), hub, 'Codex');
  if (res.success) projectCodexSkillManifests(hub);
  return res;
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

/**
 * Links a skills directory to the hub: a real directory is first copied into the
 * hub (existing hub skills win) and renamed to skills.old, then the link is made.
 */
function linkSkillsDir(skillsDir: string, hub: string, label: string): LinkResult {
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
      for (const entry of fs.readdirSync(skillsDir)) {
        if (entry.endsWith('.old')) continue; // backups, such as the <name>.old that adopt leaves
        const destPath = path.join(hubSkills, entry);
        if (!fs.existsSync(destPath)) fs.cpSync(path.join(skillsDir, entry), destPath, { recursive: true });
      }
      backupSkillsDir(skillsDir);
    } catch (err) {
      return { success: false, message: `Failed to migrate skills: ${(err as Error).message}` };
    }
  }

  if (!createJunction(hubSkills, skillsDir)) {
    return { success: false, message: `Failed to create junction from ${skillsDir} to ${hubSkills}` };
  }
  return { success: true, message: `Linked ${label} skills to ${hubSkills}` };
}

/**
 * Cursor also loads ~/.claude/skills and ~/.codex/skills (https://cursor.com/docs/skills),
 * so when either already links to the hub, a ~/.cursor/skills link would list every
 * skill twice. Returns the directory that provides the hub skills, or null.
 */
export function cursorSkillsProvider(homeDir: string, hubDir: string): string | null {
  const hubSkills = path.join(hubDir, 'skills');
  for (const rel of [['.claude', 'skills'], ['.codex', 'skills']]) {
    const p = path.join(homeDir, ...rel);
    if (isLinkTo(p, hubSkills)) return p;
  }
  return null;
}

/**
 * Links Cursor skills (~/.cursor/skills) unless Claude or Codex already provide the
 * hub skills to Cursor. An existing hub link in ~/.cursor/skills is then removed so
 * skills are not shown twice. A real ~/.cursor/skills folder is left untouched.
 */
export function linkSkillsForCursor(homeDir?: string, hubDir?: string, cursorDir?: string): LinkResult {
  const home = homeDir || getHomeDir();
  const hub = hubDir || getHubDir();
  const cursorSkills = path.join(cursorDir || path.join(home, '.cursor'), 'skills');
  const provider = cursorSkillsProvider(home, hub);
  if (!provider) return linkSkillsDir(cursorSkills, hub, 'Cursor');

  if (isLinkTo(cursorSkills, path.join(hub, 'skills'))) fs.unlinkSync(cursorSkills);
  return {
    success: true,
    message: `Cursor loads hub skills through ${provider}; not linking ${cursorSkills} (it would list every skill twice)`,
  };
}

export function linkSkillsForWindsurf(homeDir?: string, hubDir?: string, windsurfDir?: string): LinkResult {
  const home = homeDir || getHomeDir();
  const hub = hubDir || getHubDir();
  return linkSkillsDir(path.join(windsurfDir || windsurfDirFor(home), 'skills'), hub, 'Windsurf');
}

/** Copilot CLI reads personal skills from ~/.copilot/skills, not ~/.claude/skills. */
export function linkSkillsForCopilot(homeDir?: string, hubDir?: string): LinkResult {
  const home = homeDir || getHomeDir();
  const hub = hubDir || getHubDir();
  return linkSkillsDir(path.join(home, '.copilot', 'skills'), hub, 'Copilot');
}

export interface LinkAllSkillsResult {
  claude: LinkResult;
  gemini: LinkResult;
  codex?: LinkResult;
  cursor?: LinkResult;
  windsurf?: LinkResult;
  copilot?: LinkResult;
}

/**
 * Links skills across all detected assistant platforms (Claude, Gemini, Codex,
 * Cursor, Windsurf, Copilot CLI).
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
  };
  const results: Partial<Record<SkillPlatformId, LinkResult>> = {};
  // Claude and Gemini are always linked (Claude's folder is created); the rest only when detected
  for (const p of SKILL_PLATFORMS) {
    if (p.id === 'claude' || p.detected(effectiveHome)) results[p.id] = linkers[p.id]();
  }
  const gemini = linkSkillsForGemini(effectiveHome, effectiveHub);
  projectCodexSkillManifests(effectiveHub);
  const { claude, codex, cursor, windsurf, copilot } = results;

  return { claude: claude as LinkResult, gemini, codex, cursor, windsurf, copilot };
}
