/**
 * Scaffold and migration initializer for agenthub.
 * Creates ~/.agenthub directory hierarchy, populates starter templates,
 * and performs safe whitelist backups.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDir, getUtcTimestamp, safeWriteFile } from '../utils/fs.js';
import { getHomeDir, getHubDir } from './detector.js';
import { DEFAULT_MANIFEST_MCP } from './manifest.js';

export interface ScaffoldOptions {
  templateDir?: string;
  force?: boolean;
  migrateFrom?: string;
}

export interface ScaffoldResult {
  hubDir: string;
  backedUpFiles: string[];
  copiedTemplates: string[];
  manifest: string;
  migratedFrom?: string;
  migratedFiles?: string[];
}

/**
 * Expands a leading tilde (~) in a path to the user's home directory.
 */
export function expandTilde(p: string): string {
  if (!p) return p;
  if (p === '~') {
    return getHomeDir();
  }
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(getHomeDir(), p.slice(2));
  }
  return p;
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

function resolveDefaultTemplateDir(): string | null {
  try {
    const currentFile = fileURLToPath(import.meta.url);
    const currentDir = path.dirname(currentFile);

    // From src/core/scaffold.ts -> ../../templates
    const fromSrc = path.resolve(currentDir, '../../templates');
    if (isDir(fromSrc)) {
      return fromSrc;
    }

    // From dist/scaffold.js or dist/core/scaffold.js -> ../templates or ../../templates
    const fromDist = path.resolve(currentDir, '../templates');
    if (isDir(fromDist)) {
      return fromDist;
    }

    const fromCwd = path.resolve(process.cwd(), 'templates');
    if (isDir(fromCwd)) {
      return fromCwd;
    }
  } catch {
    // fallback
  }
  return null;
}

/** The MCP servers the default template ships (mcp/servers.json), by name. */
export function defaultTemplateServers(): Record<string, unknown> {
  const dir = resolveDefaultTemplateDir();
  if (!dir) return {};
  try {
    const servers = JSON.parse(fs.readFileSync(path.join(dir, 'mcp', 'servers.json'), 'utf-8'))?.mcpServers;
    return servers && typeof servers === 'object' && !Array.isArray(servers) ? servers : {};
  } catch {
    return {};
  }
}

/**
 * Performs a safe whitelist backup of targeted configuration files
 * from ~/.claude, ~/.gemini, ~/.codex and the Cursor, Windsurf and Copilot MCP configs to prevent data loss.
 * Avoids backing up multi-gigabyte brain/ logs or SQLite databases.
 */
export function backupExistingConfigs(backupDir: string, customHome?: string): string[] {
  const home = customHome || getHomeDir();
  const backedUp: string[] = [];

  const targets = [
    path.join(home, '.gemini', 'GEMINI.md'),
    path.join(home, '.gemini', 'config', 'GEMINI.md'),
    path.join(home, '.gemini', 'config', 'skills.json'),
    path.join(home, '.gemini', 'config', 'hooks.json'),
    path.join(home, '.claude', 'CLAUDE.md'),
    path.join(home, '.claude', 'settings.json'),
    path.join(home, '.codex', 'AGENTS.md'),
    path.join(home, '.codex', 'config.toml'),
    path.join(home, '.cursor', 'mcp.json'),
    path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
    path.join(home, '.copilot', 'mcp-config.json'),
  ];

  for (const t of targets) {
    if (isFile(t)) {
      const rel = path.relative(home, t).replace(/\\/g, '/');
      const dest = path.join(backupDir, rel);
      ensureDir(path.dirname(dest));
      fs.copyFileSync(t, dest);
      backedUp.push(rel);
    }
  }

  // Whitelist backup for subagents
  const agentDirs = [
    path.join(home, '.gemini', 'config', 'agents'),
    path.join(home, '.claude', 'agents'),
  ];

  for (const agDir of agentDirs) {
    if (isDir(agDir)) {
      try {
        const files = fs.readdirSync(agDir);
        for (const f of files) {
          if (f.endsWith('.md')) {
            const filePath = path.join(agDir, f);
            if (isFile(filePath)) {
              const rel = path.relative(home, filePath).replace(/\\/g, '/');
              const dest = path.join(backupDir, rel);
              ensureDir(path.dirname(dest));
              fs.copyFileSync(filePath, dest);
              backedUp.push(rel);
            }
          }
        }
      } catch {
        // ignore
      }
    }
  }

  return backedUp;
}

const DEFAULT_MANIFEST_PLATFORMS: Record<string, any> = {
  claude: { enabled: true },
  antigravity: { enabled: true },
  codex: { enabled: true },
  cursor: { enabled: false },
  windsurf: { enabled: false },
};

/**
 * True if `content` is exactly what initHub writes for the hub-relative path
 * `rel` from the default templates (the manifest is compared without its
 * created_at and links, which vary per machine).
 */
export function isScaffoldDefault(rel: string, content: Buffer): boolean {
  if (rel === 'agenthub.json') {
    try {
      const data = JSON.parse(content.toString('utf-8'));
      delete data.created_at;
      delete data.links;
      const current = JSON.stringify(data);
      return (
        current === JSON.stringify({ version: '0.1.0', platforms: DEFAULT_MANIFEST_PLATFORMS }) ||
        current === JSON.stringify({ version: '0.1.0', platforms: DEFAULT_MANIFEST_PLATFORMS, mcp: DEFAULT_MANIFEST_MCP })
      );
    } catch {
      return false;
    }
  }
  const templateDir = resolveDefaultTemplateDir();
  if (!templateDir || !/^(rules|agents|mcp)\//.test(rel) || rel.split('/').includes('..')) return false;
  const src = path.join(templateDir, ...rel.split('/'));
  return isFile(src) && fs.readFileSync(src).equals(content);
}

/**
 * Scaffolds ~/.agenthub directory structure and populates initial files.
 */
export function initHub(options?: ScaffoldOptions): ScaffoldResult {
  const hub = getHubDir();
  const force = Boolean(options?.force);
  const timestamp = getUtcTimestamp();

  // 1. Perform Whitelist Backup
  const backupPath = path.join(hub, 'backups', `pre-agenthub-${timestamp}`);
  const backedUpFiles = backupExistingConfigs(backupPath);

  // 2. Create Directory Scaffold
  const subdirs = [
    path.join(hub, 'rules', 'overrides'),
    path.join(hub, 'skills'),
    path.join(hub, 'agents'),
    path.join(hub, 'mcp'),
    path.join(hub, 'backups'),
  ];

  for (const dir of subdirs) {
    ensureDir(dir);
  }

  // 3. Migrate from older hub if requested
  const migratedFiles: string[] = [];
  const migratedFilePaths = new Set<string>();
  let migratedFrom: string | undefined;
  let migratedPlatforms: Record<string, any> | undefined;

  if (options?.migrateFrom) {
    const sourceHub = path.resolve(expandTilde(options.migrateFrom));
    if (!fs.existsSync(sourceHub) || !isDir(sourceHub)) {
      throw new Error(`Migration source directory does not exist: ${sourceHub}`);
    }
    migratedFrom = sourceHub;

    const oldManifestAgenthub = path.join(sourceHub, 'agenthub.json');

    const sourceManifest = isFile(oldManifestAgenthub)
      ? oldManifestAgenthub


      : null;

    if (sourceManifest) {
      try {
        const parsed = JSON.parse(fs.readFileSync(sourceManifest, 'utf-8'));
        if (parsed && typeof parsed.platforms === 'object' && parsed.platforms !== null) {
          migratedPlatforms = parsed.platforms;
        }
      } catch {
        // ignore parse error
      }
    }

    // Migrate rules
    const oldRules = path.join(sourceHub, 'rules');
    if (isDir(oldRules)) {
      for (const file of fs.readdirSync(oldRules)) {
        const srcFile = path.join(oldRules, file);
        if (isFile(srcFile) && file.endsWith('.md')) {
          const destFile = path.join(hub, 'rules', file);
          if (!fs.existsSync(destFile) || force) {
            ensureDir(path.dirname(destFile));
            fs.copyFileSync(srcFile, destFile);
            migratedFiles.push(`rules/${file}`);
            migratedFilePaths.add(`rules/${file}`);
          }
        }
      }
      const oldOverrides = path.join(oldRules, 'overrides');
      if (isDir(oldOverrides)) {
        for (const file of fs.readdirSync(oldOverrides)) {
          const srcFile = path.join(oldOverrides, file);
          if (isFile(srcFile) && file.endsWith('.md')) {
            const destFile = path.join(hub, 'rules', 'overrides', file);
            if (!fs.existsSync(destFile) || force) {
              ensureDir(path.dirname(destFile));
              fs.copyFileSync(srcFile, destFile);
              migratedFiles.push(`rules/overrides/${file}`);
              migratedFilePaths.add(`rules/overrides/${file}`);
            }
          }
        }
      }
    }

    // Migrate skills
    const oldSkills = path.join(sourceHub, 'skills');
    if (isDir(oldSkills)) {
      for (const item of fs.readdirSync(oldSkills)) {
        const srcItem = path.join(oldSkills, item);
        const destItem = path.join(hub, 'skills', item);
        if (!fs.existsSync(destItem) || force) {
          if (isDir(srcItem)) {
            fs.cpSync(srcItem, destItem, { recursive: true, force });
            migratedFiles.push(`skills/${item}`);
            migratedFilePaths.add(`skills/${item}`);
          } else if (isFile(srcItem)) {
            fs.copyFileSync(srcItem, destItem);
            migratedFiles.push(`skills/${item}`);
            migratedFilePaths.add(`skills/${item}`);
          }
        }
      }
    }

    // Migrate agents
    const oldAgents = path.join(sourceHub, 'agents');
    if (isDir(oldAgents)) {
      for (const file of fs.readdirSync(oldAgents)) {
        const srcFile = path.join(oldAgents, file);
        if (isFile(srcFile) && file.endsWith('.md')) {
          const destFile = path.join(hub, 'agents', file);
          if (!fs.existsSync(destFile) || force) {
            ensureDir(path.dirname(destFile));
            fs.copyFileSync(srcFile, destFile);
            migratedFiles.push(`agents/${file}`);
            migratedFilePaths.add(`agents/${file}`);
          }
        }
      }
    }

    // Migrate MCP
    const oldMcp = path.join(sourceHub, 'mcp');
    if (isDir(oldMcp)) {
      for (const file of fs.readdirSync(oldMcp)) {
        const srcFile = path.join(oldMcp, file);
        if (isFile(srcFile) && file.endsWith('.json')) {
          const destFile = path.join(hub, 'mcp', file);
          if (!fs.existsSync(destFile) || force) {
            ensureDir(path.dirname(destFile));
            fs.copyFileSync(srcFile, destFile);
            migratedFiles.push(`mcp/${file}`);
            migratedFilePaths.add(`mcp/${file}`);
          }
        }
      }
    }
  }

  // 4. Copy Templates
  const copiedTemplates: string[] = [];
  const templateDir = options?.templateDir || resolveDefaultTemplateDir();

  if (templateDir && isDir(templateDir)) {
    // Copy rules
    const rulesSrc = path.join(templateDir, 'rules');
    if (isDir(rulesSrc)) {
      for (const f of fs.readdirSync(rulesSrc)) {
        const srcFile = path.join(rulesSrc, f);
        const relPath = `rules/${f}`;
        if (!migratedFilePaths.has(relPath) && isFile(srcFile) && f.endsWith('.md')) {
          const destFile = path.join(hub, 'rules', f);
          if (!fs.existsSync(destFile) || force) {
            ensureDir(path.dirname(destFile));
            fs.copyFileSync(srcFile, destFile);
            copiedTemplates.push(relPath);
          }
        }
      }

      const overridesSrc = path.join(rulesSrc, 'overrides');
      if (isDir(overridesSrc)) {
        for (const f of fs.readdirSync(overridesSrc)) {
          const srcFile = path.join(overridesSrc, f);
          const relPath = `rules/overrides/${f}`;
          if (!migratedFilePaths.has(relPath) && isFile(srcFile) && f.endsWith('.md')) {
            const destFile = path.join(hub, 'rules', 'overrides', f);
            if (!fs.existsSync(destFile) || force) {
              ensureDir(path.dirname(destFile));
              fs.copyFileSync(srcFile, destFile);
              copiedTemplates.push(relPath);
            }
          }
        }
      }
    }

    // Copy agents
    const agentsSrc = path.join(templateDir, 'agents');
    if (isDir(agentsSrc)) {
      for (const f of fs.readdirSync(agentsSrc)) {
        const srcFile = path.join(agentsSrc, f);
        const relPath = `agents/${f}`;
        if (!migratedFilePaths.has(relPath) && isFile(srcFile) && f.endsWith('.md')) {
          const destFile = path.join(hub, 'agents', f);
          if (!fs.existsSync(destFile) || force) {
            ensureDir(path.dirname(destFile));
            fs.copyFileSync(srcFile, destFile);
            copiedTemplates.push(relPath);
          }
        }
      }
    }

    // Copy MCP
    const mcpSrc = path.join(templateDir, 'mcp');
    if (isDir(mcpSrc)) {
      for (const f of fs.readdirSync(mcpSrc)) {
        const srcFile = path.join(mcpSrc, f);
        const relPath = `mcp/${f}`;
        if (!migratedFilePaths.has(relPath) && isFile(srcFile) && f.endsWith('.json')) {
          const destFile = path.join(hub, 'mcp', f);
          if (!fs.existsSync(destFile) || force) {
            ensureDir(path.dirname(destFile));
            fs.copyFileSync(srcFile, destFile);
            copiedTemplates.push(relPath);
          }
        }
      }
    }
  }

  // 5. Write manifest
  const manifestFile = path.join(hub, 'agenthub.json');
  const platforms: Record<string, any> = { ...DEFAULT_MANIFEST_PLATFORMS };
  if (migratedPlatforms) {
    for (const [key, val] of Object.entries(migratedPlatforms)) {
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        platforms[key] = {
          ...(platforms[key] || {}),
          ...val,
        };
      } else {
        platforms[key] = val;
      }
    }
  }

  const manifestData = {
    version: '0.1.0',
    created_at: new Date().toISOString(),
    platforms,
    mcp: DEFAULT_MANIFEST_MCP,
  };

  if (!fs.existsSync(manifestFile) || force) {
    safeWriteFile(manifestFile, JSON.stringify(manifestData, null, 2) + '\n');
  }

  const result: ScaffoldResult = {
    hubDir: hub,
    backedUpFiles,
    copiedTemplates,
    manifest: manifestFile,
  };

  if (migratedFrom) {
    result.migratedFrom = migratedFrom;
    result.migratedFiles = migratedFiles;
  }

  return result;
}
