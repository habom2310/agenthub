import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import { createJunction, ensureDir, safeWriteFile } from '../utils/fs.js';
import { getHomeDir, getHubDir } from './detector.js';

export interface LinkResult {
  success: boolean;
  message: string;
}

/**
 * Links Claude skills to the central hub skills directory.
 * If Claude skills directory is a real directory (not junction/symlink),
 * migrates any existing skills into hub and renames to skills.old.
 */
export function linkSkillsForClaude(
  homeDir?: string,
  hubDir?: string
): LinkResult {
  const home = homeDir || getHomeDir();
  const hub = hubDir || getHubDir();

  const claudeSkills = path.join(home, '.claude', 'skills');
  const hubSkills = path.join(hub, 'skills');

  ensureDir(hubSkills);

  let lstat: fs.Stats | null = null;
  try {
    lstat = fs.lstatSync(claudeSkills);
  } catch {
    lstat = null;
  }

  if (lstat && !lstat.isSymbolicLink() && lstat.isDirectory()) {
    try {
      const entries = fs.readdirSync(claudeSkills);
      for (const entry of entries) {
        const srcPath = path.join(claudeSkills, entry);
        const destPath = path.join(hubSkills, entry);
        if (!fs.existsSync(destPath)) {
          fs.cpSync(srcPath, destPath, { recursive: true });
        }
      }

      const skillsOld = path.join(path.dirname(claudeSkills), 'skills.old');
      if (fs.existsSync(skillsOld)) {
        fs.rmSync(skillsOld, { recursive: true, force: true });
      }
      fs.renameSync(claudeSkills, skillsOld);
    } catch (err) {
      return {
        success: false,
        message: `Failed to migrate skills: ${(err as Error).message}`,
      };
    }
  }

  const junctionCreated = createJunction(hubSkills, claudeSkills);
  if (!junctionCreated) {
    return {
      success: false,
      message: `Failed to create junction from ${claudeSkills} to ${hubSkills}`,
    };
  }

  return {
    success: true,
    message: `Linked Claude skills to ${hubSkills}`,
  };
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
      p.includes('.agentrc') ||
      p.includes('agentrc') ||
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
 * If codex skills is a real directory, migrates contents and backs up to skills.old.
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

  const codexSkills = path.join(codexDir, 'skills');
  const hubSkills = path.join(hub, 'skills');
  ensureDir(hubSkills);

  let lstat: fs.Stats | null = null;
  try {
    lstat = fs.lstatSync(codexSkills);
  } catch {
    lstat = null;
  }

  if (lstat && !lstat.isSymbolicLink() && lstat.isDirectory()) {
    try {
      const entries = fs.readdirSync(codexSkills);
      for (const entry of entries) {
        const srcPath = path.join(codexSkills, entry);
        const destPath = path.join(hubSkills, entry);
        if (!fs.existsSync(destPath)) {
          fs.cpSync(srcPath, destPath, { recursive: true });
        }
      }

      const skillsOld = path.join(codexDir, 'skills.old');
      if (fs.existsSync(skillsOld)) {
        fs.rmSync(skillsOld, { recursive: true, force: true });
      }
      fs.renameSync(codexSkills, skillsOld);
    } catch (err) {
      return {
        success: false,
        message: `Failed to migrate skills: ${(err as Error).message}`,
      };
    }
  }

  const junctionCreated = createJunction(hubSkills, codexSkills);
  if (!junctionCreated) {
    return {
      success: false,
      message: `Failed to create junction from ${codexSkills} to ${hubSkills}`,
    };
  }

  projectCodexSkillManifests(hub);

  return {
    success: true,
    message: `Linked Codex skills to ${hubSkills}`,
  };
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

    const yamlContent = [
      'interface:',
      `  display_name: "${displayName.replace(/"/g, '\\"')}"`,
      `  short_description: "${shortDesc.replace(/"/g, '\\"')}"`,
      `  default_prompt: "Use ${name.replace(/"/g, '\\"')} skill for this task."`,
      '',
    ].join('\n');

    safeWriteFile(manifestPath, yamlContent);
    generated.push(name);
  }

  return {
    success: true,
    message: `Generated ${generated.length} Codex skill manifest(s)`,
  };
}
