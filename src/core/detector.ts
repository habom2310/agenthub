/**
 * Platform detector for agenthub.
 * Detects installed AI coding assistants and their configuration status.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findExecutable, isJunctionOrSymlink } from '../utils/fs.js';

let homeOverride: string | null = null;
let hubOverride: string | null = null;

export interface PlatformInfo {
  name: string;
  detected: boolean;
  path: string;
  rules_file?: string;
  rules_exists?: boolean;
  skills_json?: string;
  skills_json_exists?: boolean;
  skills_linked?: boolean;
  agents_dir?: string;
  agents_count?: number;
  hooks_file?: string;
  hooks_exists?: boolean;
  skills_dir?: string;
  skills_exists?: boolean;
  skills_is_junction?: boolean;
  settings_file?: string;
  settings_exists?: boolean;
  bin_path?: string;
  config_file?: string;
  config_exists?: boolean;
  [key: string]: unknown;
}

export interface HubReport {
  path: string;
  exists: boolean;
  manifest_exists: boolean;
  skills_count: number;
  rules_count: number;
}

export interface PlatformReport {
  hub: HubReport;
  platforms: {
    antigravity: PlatformInfo;
    claude: PlatformInfo;
    codex: PlatformInfo;
    cursor: PlatformInfo;
    windsurf: PlatformInfo;
    copilot: PlatformInfo;
    [key: string]: PlatformInfo;
  };
}

/**
 * Sets custom overrides for home and hub directories (useful for testing).
 */
export function setCustomHome(homePath?: string | null, hubPath?: string | null): void {
  homeOverride = homePath ?? null;
  hubOverride = hubPath ?? null;
}

/**
 * Resolves the user's home directory.
 * Priority: override > AGENTHUB_HOME > AGENTRC_HOME > os.homedir()
 */
export function getHomeDir(): string {
  if (homeOverride) {
    return homeOverride;
  }
  const envHub = process.env.AGENTHUB_HOME;
  if (envHub) {
    return envHub;
  }
  const envRc = process.env.AGENTRC_HOME;
  if (envRc) {
    return envRc;
  }
  return os.homedir();
}

/**
 * Resolves the hub directory path.
 * Priority: override > AGENTHUB_HUB > AGENTRC_HUB > ${getHomeDir()}/.agenthub
 */
export function getHubDir(): string {
  if (hubOverride) {
    return hubOverride;
  }
  const envHub = process.env.AGENTHUB_HUB;
  if (envHub) {
    return envHub;
  }
  const envRc = process.env.AGENTRC_HUB;
  if (envRc) {
    return envRc;
  }
  return path.join(getHomeDir(), '.agenthub');
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function countMdFiles(dirPath: string): number {
  try {
    if (!isDir(dirPath)) return 0;
    return fs.readdirSync(dirPath).filter((f) => f.endsWith('.md') && isFile(path.join(dirPath, f))).length;
  } catch {
    return 0;
  }
}

function countDirEntries(dirPath: string): number {
  try {
    if (!isDir(dirPath)) return 0;
    return fs.readdirSync(dirPath).length;
  } catch {
    return 0;
  }
}

/**
 * Detects AI coding assistant platforms and configuration state.
 */
export function detectPlatforms(): PlatformReport {
  const home = getHomeDir();
  const hub = getHubDir();

  const manifestExists =
    isFile(path.join(hub, 'agenthub.json')) || isFile(path.join(hub, 'agentrc.json'));

  const report: PlatformReport = {
    hub: {
      path: hub,
      exists: isDir(hub),
      manifest_exists: manifestExists,
      skills_count: countDirEntries(path.join(hub, 'skills')),
      rules_count: countMdFiles(path.join(hub, 'rules')),
    },
    platforms: {} as PlatformReport['platforms'],
  };

  // 1. Antigravity / Gemini
  const geminiDir = path.join(home, '.gemini');
  const geminiConfig = path.join(geminiDir, 'config');
  const geminiRules = path.join(geminiDir, 'GEMINI.md');
  const geminiSkillsJson = path.join(geminiConfig, 'skills.json');
  const geminiAgents = path.join(geminiConfig, 'agents');
  const geminiHooks = path.join(geminiConfig, 'hooks.json');

  let skillsMappedToHub = false;
  if (isFile(geminiSkillsJson)) {
    try {
      const data = JSON.parse(fs.readFileSync(geminiSkillsJson, 'utf-8'));
      const entries = Array.isArray(data?.entries) ? data.entries : [];
      for (const entry of entries) {
        const p = String(entry?.path || '');
        if (
          p.includes('.agenthub') ||
          p.includes('agenthub') ||
          p.includes('.agentrc') ||
          p.includes('agentrc')
        ) {
          skillsMappedToHub = true;
          break;
        }
      }
    } catch {
      // ignore JSON parse error
    }
  }

  report.platforms.antigravity = {
    name: 'Google Antigravity (AGY)',
    detected: isDir(geminiDir),
    path: geminiDir,
    rules_file: geminiRules,
    rules_exists: isFile(geminiRules),
    skills_json: geminiSkillsJson,
    skills_json_exists: isFile(geminiSkillsJson),
    skills_linked: skillsMappedToHub,
    agents_dir: geminiAgents,
    agents_count: countMdFiles(geminiAgents),
    hooks_file: geminiHooks,
    hooks_exists: isFile(geminiHooks),
  };

  // 2. Claude Code
  const claudeDir = path.join(home, '.claude');
  const claudeRules = path.join(claudeDir, 'CLAUDE.md');
  const claudeSkills = path.join(claudeDir, 'skills');
  const claudeAgents = path.join(claudeDir, 'agents');
  const claudeSettings = path.join(claudeDir, 'settings.json');

  const claudeSkillsExists = isDir(claudeSkills);
  const claudeSkillsIsJunction = claudeSkillsExists && isJunctionOrSymlink(claudeSkills);

  report.platforms.claude = {
    name: 'Claude Code',
    detected: isDir(claudeDir),
    path: claudeDir,
    rules_file: claudeRules,
    rules_exists: isFile(claudeRules),
    skills_dir: claudeSkills,
    skills_exists: claudeSkillsExists,
    skills_is_junction: claudeSkillsIsJunction,
    skills_linked: claudeSkillsIsJunction,
    agents_dir: claudeAgents,
    agents_count: countMdFiles(claudeAgents),
    settings_file: claudeSettings,
    settings_exists: isFile(claudeSettings),
  };

  // 3. OpenAI Codex CLI & ChatGPT
  const codexDir = path.join(home, '.codex');
  const codexRules = path.join(codexDir, 'AGENTS.md');
  const codexSkills = path.join(codexDir, 'skills');
  const codexConfig = path.join(codexDir, 'config.toml');
  const codexBin = findExecutable('codex');

  const codexSkillsExists = isDir(codexSkills);
  const codexSkillsLinked = codexSkillsExists && isJunctionOrSymlink(codexSkills);

  report.platforms.codex = {
    name: 'OpenAI Codex CLI & ChatGPT',
    detected: isDir(codexDir) || codexBin !== null,
    path: codexDir,
    bin_path: codexBin || '',
    rules_file: codexRules,
    rules_exists: isFile(codexRules),
    skills_dir: codexSkills,
    skills_exists: codexSkillsExists,
    skills_linked: codexSkillsLinked,
    config_file: codexConfig,
    config_exists: isFile(codexConfig),
  };

  // 4. Cursor
  const cursorDir = path.join(home, '.cursor');
  const cursorSkills = path.join(cursorDir, 'skills');
  const cursorRulesMdcHub = path.join(cursorDir, 'rules', 'agenthub.mdc');
  const cursorRulesMdcRc = path.join(cursorDir, 'rules', 'agentrc.mdc');
  const cursorRulesLegacy = path.join(home, '.cursorrules');

  const cursorSkillsLinked = isDir(cursorSkills) && isJunctionOrSymlink(cursorSkills);

  report.platforms.cursor = {
    name: 'Cursor',
    detected: isDir(cursorDir),
    path: cursorDir,
    rules_exists: isFile(cursorRulesMdcHub) || isFile(cursorRulesMdcRc) || isFile(cursorRulesLegacy),
    skills_linked: cursorSkillsLinked,
  };

  // 5. Windsurf
  let windsurfDir = path.join(home, '.codeium', 'windsurf');
  if (!isDir(windsurfDir)) {
    windsurfDir = path.join(home, '.windsurf');
  }
  const windsurfSkills = path.join(windsurfDir, 'skills');
  const windsurfRules = path.join(windsurfDir, 'memories', 'global_rules.md');
  const windsurfRulesLegacy = path.join(home, '.windsurfrules');

  const windsurfSkillsLinked = isDir(windsurfSkills) && isJunctionOrSymlink(windsurfSkills);

  report.platforms.windsurf = {
    name: 'Windsurf',
    detected: isDir(windsurfDir),
    path: windsurfDir,
    rules_exists: isFile(windsurfRules) || isFile(windsurfRulesLegacy),
    skills_linked: windsurfSkillsLinked,
  };

  // 6. GitHub Copilot CLI
  const copilotPath = findExecutable('copilot');

  report.platforms.copilot = {
    name: 'GitHub Copilot CLI',
    detected: copilotPath !== null,
    path: copilotPath || '',
  };

  return report;
}
