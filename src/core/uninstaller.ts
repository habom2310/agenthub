/**
 * Uninstaller and rollback engine for agenthub.
 * Safely restores pre-agenthub configuration backups, unlinks skills junctions,
 * restores original skills folders or .agentrc/skills, and cleans up generated rules.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createJunction, ensureDir } from '../utils/fs.js';
import { getHomeDir, getHubDir } from './detector.js';

export interface UninstallOptions {
  home?: string;
  hub?: string;
  dryRun?: boolean;
  purge?: boolean;
}

export interface UninstallResult {
  success: boolean;
  backupRestored: string | null;
  restoredFiles: string[];
  unlinkedJunctions: string[];
  restoredJunctions: string[];
  removedFiles: string[];
  purgedHub: boolean;
  errors: string[];
}

/**
 * Looks in path.join(hubDir, 'backups') for directories starting with 'pre-agenthub-'.
 * Sorts alphabetically and returns the first one (or null if none).
 */
export function findEarliestBackup(hubDir: string): string | null {
  const backupsDir = path.join(hubDir, 'backups');
  if (!fs.existsSync(backupsDir)) {
    return null;
  }

  try {
    const entries = fs.readdirSync(backupsDir, { withFileTypes: true });
    const matching = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('pre-agenthub-'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));

    if (matching.length === 0) {
      return null;
    }

    return path.join(backupsDir, matching[0]);
  } catch {
    return null;
  }
}

/**
 * Recursively walks backupDir and copies every file back to path.join(homeDir, relativePath).
 * Creates parent directories as needed.
 */
export function restoreFromBackup(
  backupDir: string,
  homeDir: string,
  dryRun?: boolean
): string[] {
  const restored: string[] = [];
  if (!fs.existsSync(backupDir)) {
    return restored;
  }

  function walk(current: string): void {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        const rel = path.relative(backupDir, fullPath);
        const relPosix = rel.replace(/\\/g, '/');
        const dest = path.join(homeDir, rel);

        if (!dryRun) {
          ensureDir(path.dirname(dest));
          fs.copyFileSync(fullPath, dest);
        }

        restored.push(relPosix);
      }
    }
  }

  walk(backupDir);
  return restored;
}

function isMatchingHubTarget(linkPath: string, hubDir: string): boolean {
  let rawTarget: string | null = null;
  try {
    rawTarget = fs.readlinkSync(linkPath);
  } catch {
    // ignore
  }

  let realTarget: string | null = null;
  try {
    realTarget = fs.realpathSync(linkPath);
  } catch {
    // ignore
  }

  const hubSkillsNorm = path
    .resolve(hubDir, 'skills')
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/^\\\\\?\\/, '');

  const targetsToCheck = [rawTarget, realTarget].filter(Boolean) as string[];
  for (const t of targetsToCheck) {
    const norm = t
      .toLowerCase()
      .replace(/\\/g, '/')
      .replace(/^\\\\\?\\/, '');

    if (norm.includes('.agenthub')) return true;
    if (norm === hubSkillsNorm) return true;
    if (norm.endsWith('/' + path.basename(hubDir).toLowerCase() + '/skills')) return true;

    try {
      const resolved = path
        .resolve(path.dirname(linkPath), t)
        .toLowerCase()
        .replace(/\\/g, '/')
        .replace(/^\\\\\?\\/, '');
      if (resolved === hubSkillsNorm) return true;
    } catch {
      // ignore
    }
  }

  return false;
}

/**
 * Checks .claude/skills, .codex/skills, .cursor/skills, .codeium/windsurf/skills, .windsurf/skills.
 * If it is a symlink/junction pointing to hubDir/skills or includes .agenthub:
 * Unlinks the junction.
 * If skills.old exists in parent directory, renames skills.old -> skills.
 * Else if ~/.agentrc/skills exists, creates junction pointing to ~/.agentrc/skills and adds to restored.
 */
export function cleanupJunctions(
  homeDir: string,
  hubDir: string,
  dryRun?: boolean
): { unlinked: string[]; restored: string[] } {
  const unlinked: string[] = [];
  const restored: string[] = [];

  const candidateLinks = [
    path.join(homeDir, '.claude', 'skills'),
    path.join(homeDir, '.codex', 'skills'),
    path.join(homeDir, '.cursor', 'skills'),
    path.join(homeDir, '.codeium', 'windsurf', 'skills'),
    path.join(homeDir, '.windsurf', 'skills'),
  ];

  for (const linkPath of candidateLinks) {
    let isLink = false;
    try {
      const stat = fs.lstatSync(linkPath);
      isLink = stat.isSymbolicLink();
    } catch {
      isLink = false;
    }

    if (!isLink) {
      continue;
    }

    if (!isMatchingHubTarget(linkPath, hubDir)) {
      continue;
    }

    unlinked.push(linkPath);

    if (!dryRun) {
      try {
        fs.unlinkSync(linkPath);
      } catch {
        try {
          fs.rmdirSync(linkPath);
        } catch {
          fs.rmSync(linkPath, { recursive: true, force: true });
        }
      }
    }

    const parentDir = path.dirname(linkPath);
    const skillsOld = path.join(parentDir, 'skills.old');

    if (fs.existsSync(skillsOld)) {
      if (!dryRun) {
        fs.renameSync(skillsOld, linkPath);
      }
    } else {
      const agentrcSkills = path.join(homeDir, '.agentrc', 'skills');
      if (fs.existsSync(agentrcSkills)) {
        if (!dryRun) {
          createJunction(agentrcSkills, linkPath);
        }
        restored.push(linkPath);
      }
    }
  }

  return { unlinked, restored };
}

/**
 * Cleans up generated rules and subagents that were not restored from backup.
 */
export function cleanupGeneratedRules(
  homeDir: string,
  hubDir: string,
  restoredFiles: Set<string>,
  dryRun?: boolean
): string[] {
  const removed: string[] = [];

  function isRestored(filePath: string): boolean {
    const rel = path.relative(homeDir, filePath);
    const relPosix = rel.replace(/\\/g, '/');
    const relWin = rel.replace(/\//g, '\\');
    const absPath = path.resolve(filePath);

    return (
      restoredFiles.has(filePath) ||
      restoredFiles.has(absPath) ||
      restoredFiles.has(rel) ||
      restoredFiles.has(relPosix) ||
      restoredFiles.has(relWin)
    );
  }

  function readContentSafely(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  function checkFileRemoval(filePath: string, condition: () => boolean): void {
    if (!fs.existsSync(filePath)) {
      return;
    }
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return;
    } catch {
      return;
    }

    if (isRestored(filePath)) {
      return;
    }

    if (condition()) {
      removed.push(filePath);
      if (!dryRun) {
        try {
          fs.unlinkSync(filePath);
        } catch {
          // ignore unlink error
        }
      }
    }
  }

  // 1. path.join(homeDir, '.cursor', 'rules', 'agenthub.mdc'): if exists, remove
  const cursorMdc = path.join(homeDir, '.cursor', 'rules', 'agenthub.mdc');
  checkFileRemoval(cursorMdc, () => true);

  // 2. path.join(homeDir, '.cursorrules'): if exists and not in restoredFiles and file content includes 'agenthub', remove
  const cursorrules = path.join(homeDir, '.cursorrules');
  checkFileRemoval(cursorrules, () => {
    const content = readContentSafely(cursorrules);
    return content !== null && content.toLowerCase().includes('agenthub');
  });

  // 3. path.join(homeDir, '.windsurfrules'): if exists and not in restoredFiles and file content includes 'agenthub', remove
  const windsurfrules = path.join(homeDir, '.windsurfrules');
  checkFileRemoval(windsurfrules, () => {
    const content = readContentSafely(windsurfrules);
    return content !== null && content.toLowerCase().includes('agenthub');
  });

  // 4. path.join(homeDir, '.windsurf', 'memories', 'global_rules.md')
  const windsurfGlobalRules = path.join(homeDir, '.windsurf', 'memories', 'global_rules.md');
  checkFileRemoval(windsurfGlobalRules, () => {
    const content = readContentSafely(windsurfGlobalRules);
    return content !== null && content.toLowerCase().includes('agenthub');
  });

  // 5. path.join(homeDir, '.codeium', 'windsurf', 'memories', 'global_rules.md')
  const codeiumGlobalRules = path.join(homeDir, '.codeium', 'windsurf', 'memories', 'global_rules.md');
  checkFileRemoval(codeiumGlobalRules, () => {
    const content = readContentSafely(codeiumGlobalRules);
    return content !== null && content.toLowerCase().includes('agenthub');
  });

  // 6. path.join(homeDir, '.gemini', 'GEMINI.md') and path.join(homeDir, '.gemini', 'config', 'GEMINI.md')
  const geminiRules = path.join(homeDir, '.gemini', 'GEMINI.md');
  checkFileRemoval(geminiRules, () => {
    const content = readContentSafely(geminiRules);
    return content !== null && content.toLowerCase().includes('agenthub');
  });
  const geminiConfigRules = path.join(homeDir, '.gemini', 'config', 'GEMINI.md');
  checkFileRemoval(geminiConfigRules, () => {
    const content = readContentSafely(geminiConfigRules);
    return content !== null && content.toLowerCase().includes('agenthub');
  });

  // 7. path.join(homeDir, '.claude', 'CLAUDE.md'): if exists and not in restoredFiles and file content includes '.agenthub', remove
  const claudeRules = path.join(homeDir, '.claude', 'CLAUDE.md');
  checkFileRemoval(claudeRules, () => {
    const content = readContentSafely(claudeRules);
    return (
      content !== null &&
      (content.toLowerCase().includes('.agenthub') || content.toLowerCase().includes('agenthub'))
    );
  });

  // 8. path.join(homeDir, '.codex', 'AGENTS.md'): if exists and not in restoredFiles and file content includes 'agenthub', remove
  const codexRules = path.join(homeDir, '.codex', 'AGENTS.md');
  checkFileRemoval(codexRules, () => {
    const content = readContentSafely(codexRules);
    return content !== null && content.toLowerCase().includes('agenthub');
  });

  // 9. In .claude/agents/*.md and .gemini/config/agents/*.md:
  // if not in restoredFiles, if file contains 'agenthub' or is scout.md/implementer.md/reviewer.md without prior backup, remove
  const agentDirs = [
    path.join(homeDir, '.claude', 'agents'),
    path.join(homeDir, '.gemini', 'config', 'agents'),
  ];

  const defaultAgentNames = new Set(['scout.md', 'implementer.md', 'reviewer.md']);

  for (const agentDir of agentDirs) {
    if (!fs.existsSync(agentDir)) continue;
    try {
      const entries = fs.readdirSync(agentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const agentFile = path.join(agentDir, entry.name);
        if (isRestored(agentFile)) continue;

        const isDefault = defaultAgentNames.has(entry.name.toLowerCase());
        const content = readContentSafely(agentFile);
        const hasAgenthub = content !== null && content.toLowerCase().includes('agenthub');

        if (isDefault || hasAgenthub) {
          removed.push(agentFile);
          if (!dryRun) {
            try {
              fs.unlinkSync(agentFile);
            } catch {
              // ignore
            }
          }
        }
      }
    } catch {
      // ignore readdir error
    }
  }

  return removed;
}

/**
 * Orchestrates full uninstallation and rollback of agenthub.
 */
export function uninstallHub(options?: UninstallOptions): UninstallResult {
  const homeDir = options?.home || getHomeDir();
  const hubDir = options?.hub || getHubDir();
  const dryRun = Boolean(options?.dryRun);
  const purge = Boolean(options?.purge);

  const errors: string[] = [];

  // 1. Find earliest backup
  const earliestBackup = findEarliestBackup(hubDir);

  // 2. Restore backed up files
  let restoredFiles: string[] = [];
  if (earliestBackup) {
    try {
      restoredFiles = restoreFromBackup(earliestBackup, homeDir, dryRun);
    } catch (err) {
      errors.push(`Failed to restore from backup: ${(err as Error).message}`);
    }
  }

  const restoredFilesSet = new Set<string>();
  for (const f of restoredFiles) {
    restoredFilesSet.add(f);
    restoredFilesSet.add(f.replace(/\\/g, '/'));
    restoredFilesSet.add(path.resolve(homeDir, f));
  }

  // 3. Clean up junctions and restore skills.old or ~/.agentrc/skills
  let unlinkedJunctions: string[] = [];
  let restoredJunctions: string[] = [];
  try {
    const junctionRes = cleanupJunctions(homeDir, hubDir, dryRun);
    unlinkedJunctions = junctionRes.unlinked;
    restoredJunctions = junctionRes.restored;
  } catch (err) {
    errors.push(`Failed to clean up junctions: ${(err as Error).message}`);
  }

  // 4. Clean up leftover generated rules and agents not in backup
  let removedFiles: string[] = [];
  try {
    removedFiles = cleanupGeneratedRules(homeDir, hubDir, restoredFilesSet, dryRun);
  } catch (err) {
    errors.push(`Failed to clean up generated rules: ${(err as Error).message}`);
  }

  // 5. Purge hub directory if requested
  let purgedHub = false;
  if (purge) {
    if (!dryRun) {
      try {
        if (fs.existsSync(hubDir)) {
          fs.rmSync(hubDir, { recursive: true, force: true });
        }
        purgedHub = true;
      } catch (err) {
        errors.push(`Failed to purge hub directory: ${(err as Error).message}`);
      }
    } else {
      purgedHub = true;
    }
  }

  return {
    success: errors.length === 0,
    backupRestored: earliestBackup,
    restoredFiles,
    unlinkedJunctions,
    restoredJunctions,
    removedFiles,
    purgedHub,
    errors,
  };
}
