import fs from 'node:fs';
import path from 'node:path';
import { safeWriteFile } from '../utils/fs.js';
import { getHomeDir, getHubDir } from './detector.js';

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: 'stdio' | 'http';
  url?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

export interface McpPlatformStatus {
  path: string;
  exists: boolean;
  valid: boolean;
  servers: Record<string, McpServerConfig>;
}

export interface McpStatusReport {
  hub: McpPlatformStatus;
  claude: McpPlatformStatus;
  gemini: McpPlatformStatus;
  in_sync: boolean;
  missing_in_claude: string[];
  missing_in_gemini: string[];
  untracked_in_claude: string[];
  untracked_in_gemini: string[];
  drifted_in_claude: string[];
  drifted_in_gemini: string[];
}

export interface SyncMcpResult {
  success: boolean;
  actions: string[];
}

export function readJsonSafely<T = Record<string, unknown>>(
  filePath: string
): { data: T; success: boolean } {
  if (!fs.existsSync(filePath)) {
    return { data: {} as T, success: true };
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { data: {} as T, success: false };
    }
    return { data: parsed as T, success: true };
  } catch {
    return { data: {} as T, success: false };
  }
}

export function normalizeServerForHub(name: string, config: McpServerConfig): McpServerConfig {
  const clone = JSON.parse(JSON.stringify(config)) as McpServerConfig;
  delete clone.alwaysLoad;
  return clone;
}

export function adaptServerForClaude(name: string, config: McpServerConfig): McpServerConfig {
  const adapted = JSON.parse(JSON.stringify(config)) as McpServerConfig;
  if (adapted.url && !adapted.type) {
    adapted.type = 'http';
  } else if (adapted.command && !adapted.type) {
    adapted.type = 'stdio';
  }
  return adapted;
}

export function adaptServerForGemini(name: string, config: McpServerConfig): McpServerConfig {
  const adapted = JSON.parse(JSON.stringify(config)) as McpServerConfig;
  if (adapted.url && !adapted.type) {
    adapted.type = 'http';
  } else if (adapted.command && !adapted.type) {
    adapted.type = 'stdio';
  }
  return adapted;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA).filter((k) => objA[k] !== undefined).sort();
  const keysB = Object.keys(objB).filter((k) => objB[k] !== undefined).sort();
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i++) {
    const k = keysA[i];
    if (k !== keysB[i]) return false;
    if (!deepEqual(objA[k], objB[k])) return false;
  }
  return true;
}

export function getMcpStatus(homeDir?: string, hubDir?: string): McpStatusReport {
  const home = homeDir || getHomeDir();
  const hub = hubDir || getHubDir();

  const hubPath = path.join(hub, 'mcp', 'servers.json');
  const hubExists = fs.existsSync(hubPath);
  const hubRead = readJsonSafely(hubPath);
  const hubServers: Record<string, McpServerConfig> =
    hubRead.success &&
    hubRead.data?.mcpServers &&
    typeof hubRead.data.mcpServers === 'object' &&
    !Array.isArray(hubRead.data.mcpServers)
      ? (hubRead.data.mcpServers as Record<string, McpServerConfig>)
      : {};

  const claudePath = path.join(home, '.claude.json');
  const claudeInstalled =
    fs.existsSync(claudePath) || fs.existsSync(path.join(home, '.claude'));
  const claudeExists = fs.existsSync(claudePath);
  const claudeRead = readJsonSafely(claudePath);
  const claudeServers: Record<string, McpServerConfig> =
    claudeRead.success &&
    claudeRead.data?.mcpServers &&
    typeof claudeRead.data.mcpServers === 'object' &&
    !Array.isArray(claudeRead.data.mcpServers)
      ? (claudeRead.data.mcpServers as Record<string, McpServerConfig>)
      : {};

  const geminiDir = path.join(home, '.gemini');
  const geminiMcpPath = path.join(geminiDir, 'config', 'mcp_config.json');
  const geminiSettingsPath = path.join(geminiDir, 'settings.json');
  const geminiMcpExists = fs.existsSync(geminiMcpPath);
  const geminiSettingsExists = fs.existsSync(geminiSettingsPath);
  const geminiInstalled =
    fs.existsSync(geminiDir) || geminiMcpExists || geminiSettingsExists;
  const geminiMcpRead = readJsonSafely(geminiMcpPath);
  const geminiSettingsRead = readJsonSafely(geminiSettingsPath);

  const geminiServers: Record<string, McpServerConfig> = {};
  if (
    geminiMcpRead.success &&
    geminiMcpRead.data?.mcpServers &&
    typeof geminiMcpRead.data.mcpServers === 'object' &&
    !Array.isArray(geminiMcpRead.data.mcpServers)
  ) {
    Object.assign(geminiServers, geminiMcpRead.data.mcpServers);
  }
  if (
    geminiSettingsRead.success &&
    geminiSettingsRead.data?.mcpServers &&
    typeof geminiSettingsRead.data.mcpServers === 'object' &&
    !Array.isArray(geminiSettingsRead.data.mcpServers)
  ) {
    Object.assign(geminiServers, geminiSettingsRead.data.mcpServers);
  }

  const geminiValid =
    (!geminiMcpExists || geminiMcpRead.success) &&
    (!geminiSettingsExists || geminiSettingsRead.success);

  const missing_in_claude: string[] = [];
  const untracked_in_claude: string[] = [];
  const drifted_in_claude: string[] = [];

  if (claudeInstalled) {
    for (const name of Object.keys(hubServers)) {
      if (!(name in claudeServers)) {
        missing_in_claude.push(name);
      } else {
        const expected = adaptServerForClaude(name, hubServers[name]);
        if (!deepEqual(claudeServers[name], expected)) {
          drifted_in_claude.push(name);
        }
      }
    }
    for (const name of Object.keys(claudeServers)) {
      if (!(name in hubServers)) {
        untracked_in_claude.push(name);
      }
    }
  }

  const missing_in_gemini: string[] = [];
  const untracked_in_gemini: string[] = [];
  const drifted_in_gemini: string[] = [];

  if (geminiInstalled) {
    for (const name of Object.keys(hubServers)) {
      if (!(name in geminiServers)) {
        missing_in_gemini.push(name);
      } else {
        const expected = adaptServerForGemini(name, hubServers[name]);
        if (!deepEqual(geminiServers[name], expected)) {
          drifted_in_gemini.push(name);
        }
      }
    }
    for (const name of Object.keys(geminiServers)) {
      if (!(name in hubServers)) {
        untracked_in_gemini.push(name);
      }
    }
  }

  const in_sync =
    hubRead.success &&
    claudeRead.success &&
    geminiValid &&
    missing_in_claude.length === 0 &&
    missing_in_gemini.length === 0 &&
    untracked_in_claude.length === 0 &&
    untracked_in_gemini.length === 0 &&
    drifted_in_claude.length === 0 &&
    drifted_in_gemini.length === 0;

  return {
    hub: {
      path: hubPath,
      exists: hubExists,
      valid: hubRead.success,
      servers: hubServers,
    },
    claude: {
      path: claudePath,
      exists: claudeExists,
      valid: claudeRead.success,
      servers: claudeServers,
    },
    gemini: {
      path: geminiSettingsExists && !geminiMcpExists ? geminiSettingsPath : geminiMcpPath,
      exists: geminiMcpExists || geminiSettingsExists,
      valid: geminiValid,
      servers: geminiServers,
    },
    in_sync,
    missing_in_claude,
    missing_in_gemini,
    untracked_in_claude,
    untracked_in_gemini,
    drifted_in_claude,
    drifted_in_gemini,
  };
}

export function syncMcpServers(homeDir?: string, hubDir?: string): SyncMcpResult {
  const home = homeDir || getHomeDir();
  const hub = hubDir || getHubDir();
  const actions: string[] = [];

  const hubFile = path.join(hub, 'mcp', 'servers.json');
  const hubRead = readJsonSafely(hubFile);

  if (fs.existsSync(hubFile) && !hubRead.success) {
    return {
      success: false,
      actions: ['Aborting MCP sync: servers.json is corrupt or unparseable'],
    };
  }

  const hubServers: Record<string, McpServerConfig> =
    hubRead.success &&
    hubRead.data?.mcpServers &&
    typeof hubRead.data.mcpServers === 'object' &&
    !Array.isArray(hubRead.data.mcpServers)
      ? { ...hubRead.data.mcpServers }
      : {};
  let hubChanged = false;

  const claudeFile = path.join(home, '.claude.json');
  const claudeInstalled =
    fs.existsSync(claudeFile) || fs.existsSync(path.join(home, '.claude'));
  const claudeRead = readJsonSafely(claudeFile);

  const geminiDir = path.join(home, '.gemini');
  const geminiMcpFile = path.join(geminiDir, 'config', 'mcp_config.json');
  const geminiSettingsFile = path.join(geminiDir, 'settings.json');
  const geminiMcpExists = fs.existsSync(geminiMcpFile);
  const geminiSettingsExists = fs.existsSync(geminiSettingsFile);
  const geminiInstalled =
    fs.existsSync(geminiDir) || geminiMcpExists || geminiSettingsExists;
  const geminiMcpRead = readJsonSafely(geminiMcpFile);
  const geminiSettingsRead = readJsonSafely(geminiSettingsFile);

  // Ingest untracked from Claude
  if (claudeInstalled && claudeRead.success) {
    const claudeServers =
      claudeRead.data?.mcpServers &&
      typeof claudeRead.data.mcpServers === 'object' &&
      !Array.isArray(claudeRead.data.mcpServers)
        ? claudeRead.data.mcpServers
        : {};
    for (const [name, cfg] of Object.entries(claudeServers)) {
      if (typeof cfg === 'object' && cfg !== null && !(name in hubServers)) {
        hubServers[name] = normalizeServerForHub(name, cfg as McpServerConfig);
        hubChanged = true;
        actions.push(`Ingested server "${name}" from Claude into hub`);
      }
    }
  }

  // Ingest untracked from Gemini
  if (geminiInstalled) {
    if (geminiMcpRead.success) {
      const geminiServers =
        geminiMcpRead.data?.mcpServers &&
        typeof geminiMcpRead.data.mcpServers === 'object' &&
        !Array.isArray(geminiMcpRead.data.mcpServers)
          ? geminiMcpRead.data.mcpServers
          : {};
      for (const [name, cfg] of Object.entries(geminiServers)) {
        if (typeof cfg === 'object' && cfg !== null && !(name in hubServers)) {
          hubServers[name] = normalizeServerForHub(name, cfg as McpServerConfig);
          hubChanged = true;
          actions.push(`Ingested server "${name}" from Gemini into hub`);
        }
      }
    }
    if (geminiSettingsRead.success) {
      const geminiServers =
        geminiSettingsRead.data?.mcpServers &&
        typeof geminiSettingsRead.data.mcpServers === 'object' &&
        !Array.isArray(geminiSettingsRead.data.mcpServers)
          ? geminiSettingsRead.data.mcpServers
          : {};
      for (const [name, cfg] of Object.entries(geminiServers)) {
        if (typeof cfg === 'object' && cfg !== null && !(name in hubServers)) {
          hubServers[name] = normalizeServerForHub(name, cfg as McpServerConfig);
          hubChanged = true;
          actions.push(`Ingested server "${name}" from Gemini into hub`);
        }
      }
    }
  }

  // Save updated hub servers.json
  if (hubChanged || !fs.existsSync(hubFile)) {
    const hubData = { ...hubRead.data, mcpServers: hubServers };
    safeWriteFile(hubFile, JSON.stringify(hubData, null, 2) + '\n');
    actions.push('Updated hub servers.json');
  }

  // Downstream projection to Claude
  if (claudeInstalled) {
    if (fs.existsSync(claudeFile) && !claudeRead.success) {
      actions.push('[SKIP] Refusing to overwrite .claude.json: file is corrupt or unparseable');
    } else {
      const targetClaudeServers: Record<string, McpServerConfig> = {};
      for (const [name, cfg] of Object.entries(hubServers)) {
        targetClaudeServers[name] = adaptServerForClaude(name, cfg);
      }
      const currentClaudeServers = claudeRead.data?.mcpServers;
      if (!deepEqual(currentClaudeServers, targetClaudeServers)) {
        const targetData = { ...claudeRead.data, mcpServers: targetClaudeServers };
        safeWriteFile(claudeFile, JSON.stringify(targetData, null, 2) + '\n');
        actions.push('Updated Claude MCP configuration in .claude.json');
      }
    }
  }

  // Downstream projection to Gemini
  if (geminiInstalled) {
    const targetGeminiServers: Record<string, McpServerConfig> = {};
    for (const [name, cfg] of Object.entries(hubServers)) {
      targetGeminiServers[name] = adaptServerForGemini(name, cfg);
    }

    if (geminiMcpExists || !geminiSettingsExists) {
      if (geminiMcpExists && !geminiMcpRead.success) {
        actions.push('[SKIP] Refusing to overwrite mcp_config.json: file is corrupt or unparseable');
      } else {
        const currentServers = geminiMcpRead.data?.mcpServers;
        if (!deepEqual(currentServers, targetGeminiServers)) {
          const targetData = { ...geminiMcpRead.data, mcpServers: targetGeminiServers };
          safeWriteFile(geminiMcpFile, JSON.stringify(targetData, null, 2) + '\n');
          actions.push('Updated Gemini MCP configuration in mcp_config.json');
        }
      }
    }

    if (geminiSettingsExists) {
      if (!geminiSettingsRead.success) {
        actions.push('[SKIP] Refusing to overwrite settings.json: file is corrupt or unparseable');
      } else {
        const currentServers = geminiSettingsRead.data?.mcpServers;
        if (!deepEqual(currentServers, targetGeminiServers)) {
          const targetData = { ...geminiSettingsRead.data, mcpServers: targetGeminiServers };
          safeWriteFile(geminiSettingsFile, JSON.stringify(targetData, null, 2) + '\n');
          actions.push('Updated Gemini MCP configuration in settings.json');
        }
      }
    }
  }

  if (actions.length === 0) {
    actions.push('All MCP configurations are already synchronized.');
  }

  return { success: true, actions };
}
