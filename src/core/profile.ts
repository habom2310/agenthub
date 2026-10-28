import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, safeWriteFile } from '../utils/fs.js';
import { getHomeDir, getHubDir } from './detector.js';
import { resolvePackageTarget } from './distribution.js';
import { linkSkillsForAllAssistants } from './linker.js';
import { syncMcpServers } from './mcp-sync.js';
import { projectAll } from './projector.js';
import { analyzePackage, findMcpConfigFile, parseMcpServers } from './security.js';

export interface ProfileListResult {
  active: string;
  profiles: string[];
}

export interface ProfileCreateResult {
  success: boolean;
  name: string;
  message: string;
}

export interface ProfileUseOptions {
  homeDir?: string;
  hubDir?: string;
  yes?: boolean;
}

export interface ProfileUseResult {
  success: boolean;
  name: string;
  previous: string;
  isRemote: boolean;
  message: string;
}

const MANAGED_HUB_ITEMS = ['rules', 'skills', 'mcp', 'agents', 'agenthub.json'];

function snapshotHubToProfile(hub: string, profileName: string): void {
  const profileDir = path.join(hub, 'profiles', profileName);
  ensureDir(profileDir);

  for (const item of MANAGED_HUB_ITEMS) {
    const src = path.join(hub, item);
    const dest = path.join(profileDir, item);

    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { recursive: true, force: true });
    }
    if (fs.existsSync(src)) {
      fs.cpSync(src, dest, { recursive: true });
    }
  }
}

function applyProfileToHub(hub: string, profileDir: string): void {
  for (const item of MANAGED_HUB_ITEMS) {
    const hubItem = path.join(hub, item);
    const profileItem = path.join(profileDir, item);

    if (fs.existsSync(hubItem)) {
      fs.rmSync(hubItem, { recursive: true, force: true });
    }
    if (fs.existsSync(profileItem)) {
      fs.cpSync(profileItem, hubItem, { recursive: true });
    }
  }

  // Handle flat package rules layout if rules/ directory does not exist
  if (!fs.existsSync(path.join(profileDir, 'rules')) && fs.existsSync(path.join(profileDir, 'rules.md'))) {
    const hubRulesDir = path.join(hub, 'rules');
    ensureDir(hubRulesDir);
    fs.copyFileSync(path.join(profileDir, 'rules.md'), path.join(hubRulesDir, 'common.md'));
  }

  // Handle root MCP config file if mcp/ directory does not exist
  if (!fs.existsSync(path.join(profileDir, 'mcp'))) {
    const mcpConfigFile = findMcpConfigFile(profileDir);
    if (mcpConfigFile) {
      const { servers } = parseMcpServers(mcpConfigFile);
      if (Object.keys(servers).length > 0) {
        const hubMcpDir = path.join(hub, 'mcp');
        ensureDir(hubMcpDir);
        safeWriteFile(
          path.join(hubMcpDir, 'servers.json'),
          JSON.stringify({ mcpServers: servers }, null, 2) + '\n'
        );
      }
    }
  }
}

/**
 * Lists all existing profiles in the hub and identifies the active one.
 */
export function profileList(hubDir?: string): ProfileListResult {
  const hub = hubDir || getHubDir();
  const activeFile = path.join(hub, '.active-profile');

  let active = 'default';
  if (fs.existsSync(activeFile)) {
    try {
      const content = fs.readFileSync(activeFile, 'utf-8').trim();
      if (content) {
        active = content;
      }
    } catch {
      // ignore
    }
  }

  const profilesDir = path.join(hub, 'profiles');
  const profileSet = new Set<string>();

  if (fs.existsSync(profilesDir)) {
    try {
      if (fs.statSync(profilesDir).isDirectory()) {
        const entries = fs.readdirSync(profilesDir);
        for (const entry of entries) {
          try {
            const entryPath = path.join(profilesDir, entry);
            if (fs.statSync(entryPath).isDirectory()) {
              profileSet.add(entry);
            }
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
  }

  if (profileSet.size === 0 || active === 'default') {
    profileSet.add('default');
  }

  return {
    active,
    profiles: Array.from(profileSet).sort(),
  };
}

/**
 * Creates a named profile snapshot from the current hub configuration.
 */
export function profileCreate(name: string, hubDir?: string): ProfileCreateResult {
  const hub = hubDir || getHubDir();

  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    return {
      success: false,
      name,
      message: `Invalid profile name "${name}". Profile names must match ^[a-zA-Z0-9_-]+$`,
    };
  }

  try {
    snapshotHubToProfile(hub, name);
    return {
      success: true,
      name,
      message: `Profile "${name}" created successfully.`,
    };
  } catch (err) {
    return {
      success: false,
      name,
      message: `Failed to create profile "${name}": ${(err as Error).message}`,
    };
  }
}

/**
 * Switches the active hub configuration to a local profile or remote package.
 */
export function profileUse(target: string, options?: ProfileUseOptions): ProfileUseResult {
  const hub = options?.hubDir || getHubDir();
  const home = options?.homeDir || getHomeDir();
  const activeFile = path.join(hub, '.active-profile');

  let previous = 'default';
  if (fs.existsSync(activeFile)) {
    try {
      const content = fs.readFileSync(activeFile, 'utf-8').trim();
      if (content) {
        previous = content;
      }
    } catch {
      // ignore
    }
  }

  const profilesDir = path.join(hub, 'profiles');
  const defaultDir = path.join(profilesDir, 'default');

  // If current active profile is 'default', snapshot before switching if default profile dir doesn't exist
  if (previous === 'default' && !fs.existsSync(defaultDir)) {
    snapshotHubToProfile(hub, 'default');
  }

  const localProfileDir = path.join(profilesDir, target);
  let isLocalDirectory = false;
  try {
    isLocalDirectory = fs.existsSync(localProfileDir) && fs.statSync(localProfileDir).isDirectory();
  } catch {
    isLocalDirectory = false;
  }

  if (isLocalDirectory) {
    try {
      applyProfileToHub(hub, localProfileDir);
      safeWriteFile(activeFile, target + '\n');

      projectAll({ homeDir: home, hubDir: hub });
      linkSkillsForAllAssistants({ homeDir: home, hubDir: hub });
      syncMcpServers({ homeDir: home, hubDir: hub });

      return {
        success: true,
        name: target,
        previous,
        isRemote: false,
        message: `Switched to profile "${target}".`,
      };
    } catch (err) {
      return {
        success: false,
        name: target,
        previous,
        isRemote: false,
        message: `Failed to switch to profile "${target}": ${(err as Error).message}`,
      };
    }
  }

  // Target is remote repository or external package target
  try {
    const { dir, identifier, cleanup } = resolvePackageTarget(target);
    try {
      analyzePackage(dir, identifier);
      const profileName = identifier;
      const targetProfileDir = path.join(profilesDir, profileName);
      ensureDir(targetProfileDir);

      fs.cpSync(dir, targetProfileDir, {
        recursive: true,
        filter: (src) => !path.basename(src).startsWith('.git'),
      });

      applyProfileToHub(hub, targetProfileDir);
      safeWriteFile(activeFile, profileName + '\n');

      projectAll({ homeDir: home, hubDir: hub });
      linkSkillsForAllAssistants({ homeDir: home, hubDir: hub });
      syncMcpServers({ homeDir: home, hubDir: hub });

      return {
        success: true,
        name: profileName,
        previous,
        isRemote: true,
        message: `Switched to remote profile "${profileName}".`,
      };
    } finally {
      cleanup();
    }
  } catch (err) {
    const isLikelyRemote =
      target.includes('/') || target.startsWith('http://') || target.startsWith('https://') || target.startsWith('git@');
    return {
      success: false,
      name: target,
      previous,
      isRemote: isLikelyRemote,
      message: (err as Error).message,
    };
  }
}
