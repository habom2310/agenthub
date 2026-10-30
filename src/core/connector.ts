import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, safeWriteFile } from '../utils/fs.js';
import { getHomeDir, getHubDir, windsurfDirFor } from './detector.js';
import {
  linkSkillsForClaude,
  linkSkillsForCodex,
  linkSkillsForCursor,
  linkSkillsForGemini,
  linkSkillsForWindsurf,
} from './linker.js';
import {
  projectClaudeRules,
  projectCodexRules,
  projectCursorRules,
  projectGeminiRules,
  projectWindsurfRules,
} from './projector.js';

export interface ConnectResult {
  success: boolean;
  message: string;
}

/**
 * Updates the hub manifest (agenthub.json) with platform metadata.
 */
export function updateHubManifest(
  platformName: string,
  info: Record<string, unknown>,
  hubDir?: string
): void {
  const hub = hubDir || getHubDir();
  const hubJson = path.join(hub, 'agenthub.json');


  let manifestFile: string | null = null;
  if (fs.existsSync(hubJson)) {
    manifestFile = hubJson;


  }

  if (!manifestFile) {
    return;
  }

  try {
    const raw = fs.readFileSync(manifestFile, 'utf-8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      if (!data.platforms || typeof data.platforms !== 'object' || Array.isArray(data.platforms)) {
        data.platforms = {};
      }
      data.platforms[platformName] = info;
      safeWriteFile(manifestFile, JSON.stringify(data, null, 2) + '\n');
    }
  } catch {
    // safely ignore or handle parse errors
  }
}

/**
 * Connects Cursor to the hub:
 * - Links cursor_dir/skills to hubDir/skills (migrating existing skills, old dir kept as skills.old),
 *   unless Claude or Codex already provide the hub skills to Cursor.
 * - Projects Cursor rules.
 * - Updates the hub manifest.
 */
export function connectCursor(
  targetDir?: string,
  homeDir?: string,
  hubDir?: string
): ConnectResult {
  const home = homeDir || getHomeDir();
  const hub = hubDir || getHubDir();
  const cursor_dir = targetDir || path.join(home, '.cursor');

  ensureDir(path.join(hub, 'skills'));
  const link = linkSkillsForCursor(home, hub, cursor_dir);
  if (!link.success) return { success: false, message: link.message };

  projectCursorRules(cursor_dir, home, hub);

  updateHubManifest(
    'cursor',
    {
      enabled: true,
      connected_at: new Date().toISOString(),
      path: cursor_dir,
      rules_file: path.join(cursor_dir, 'rules', 'agenthub.mdc'),
    },
    hub
  );

  return {
    success: true,
    message: `Connected Cursor: ${link.message}; projected rules to ${cursor_dir}`,
  };
}

/**
 * Connects Windsurf to the hub:
 * - Migrates pre-existing skills to hub and renames old dir to skills.old (or a timestamped skills.old.<ts> if that exists).
 * - Creates a junction from windsurf_dir/skills pointing to hubDir/skills.
 * - Projects Windsurf rules.
 * - Updates the hub manifest.
 */
export function connectWindsurf(
  targetDir?: string,
  homeDir?: string,
  hubDir?: string
): ConnectResult {
  const home = homeDir || getHomeDir();
  const hub = hubDir || getHubDir();
  const windsurf_dir = targetDir || windsurfDirFor(home);

  ensureDir(path.join(hub, 'skills'));
  const link = linkSkillsForWindsurf(home, hub, windsurf_dir);
  if (!link.success) return { success: false, message: link.message };

  projectWindsurfRules(windsurf_dir, home, hub);

  updateHubManifest(
    'windsurf',
    {
      enabled: true,
      connected_at: new Date().toISOString(),
      path: windsurf_dir,
      rules_file: path.join(windsurf_dir, 'memories', 'global_rules.md'),
    },
    hub
  );

  return {
    success: true,
    message: `Connected Windsurf: linked skills junction and projected rules to ${windsurf_dir}`,
  };
}

/**
 * Connects an assistant platform by name with skills linking and rule projection.
 */
export function connectPlatform(
  platformName: string,
  targetDir?: string,
  homeDir?: string,
  hubDir?: string
): ConnectResult {
  const norm = platformName.trim().toLowerCase();

  if (targetDir && !['cursor', 'windsurf', 'codeium'].includes(norm)) {
    return {
      success: false,
      message: `Custom --target-dir is not supported for '${platformName}'. It is only supported for 'cursor' and 'windsurf'.`,
    };
  }

  const home = homeDir || getHomeDir();
  const hub = hubDir || getHubDir();

  switch (norm) {
    case 'cursor':
      return connectCursor(targetDir, home, hub);

    case 'windsurf':
    case 'codeium':
      return connectWindsurf(targetDir, home, hub);

    case 'codex':
    case 'chatgpt': {
      const resLink = linkSkillsForCodex(home, hub);
      const resProj = projectCodexRules(home, hub);
      const isSuccess = resLink.success && resProj.success;
      if (isSuccess) {
        updateHubManifest(
          'codex',
          {
            enabled: true,
            connected_at: new Date().toISOString(),
            path: path.join(home, '.codex'),
            rules_file: path.join(home, '.codex', 'AGENTS.md'),
          },
          hub
        );
      }
      return {
        success: isSuccess,
        message: `${resLink.message}; ${resProj.message}`,
      };
    }

    case 'claude':
    case 'claudecode': {
      const resLink = linkSkillsForClaude(home, hub);
      const resProj = projectClaudeRules({ homeDir: home, hubDir: hub });
      const isSuccess = resLink.success && resProj.success;
      if (isSuccess) {
        updateHubManifest(
          'claude',
          {
            enabled: true,
            connected_at: new Date().toISOString(),
            path: path.join(home, '.claude'),
            rules_file: path.join(home, '.claude', 'CLAUDE.md'),
          },
          hub
        );
      }
      return {
        success: isSuccess,
        message: `${resLink.message}; ${resProj.message}`,
      };
    }

    case 'gemini':
    case 'agy':
    case 'antigravity': {
      const resLink = linkSkillsForGemini(home, hub);
      const resProj = projectGeminiRules(home, hub);
      const isSuccess = resLink.success && resProj.success;
      if (isSuccess) {
        updateHubManifest(
          'antigravity',
          {
            enabled: true,
            connected_at: new Date().toISOString(),
            path: path.join(home, '.gemini'),
            rules_file: path.join(home, '.gemini', 'GEMINI.md'),
          },
          hub
        );
      }
      return {
        success: isSuccess,
        message: `${resLink.message}; ${resProj.message}`,
      };
    }

    default:
      return {
        success: false,
        message: `Unsupported platform '${platformName}'. Supported: cursor, windsurf, codex, claude, gemini`,
      };
  }
}
