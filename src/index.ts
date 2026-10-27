/**
 * agenthub - Unified configuration, skills, rules, and MCP management engine
 */

export const VERSION = '0.1.0';

// Utils
export {
  createJunction,
  isJunctionOrSymlink,
  ensureDir,
  safeWriteFile,
  findExecutable,
  type JunctionOptions,
} from './utils/fs.js';

// Core Detector
export {
  setCustomHome,
  getHomeDir,
  getHubDir,
  detectPlatforms,
  type PlatformInfo,
  type HubReport,
  type PlatformReport,
} from './core/detector.js';

// Core Scaffold
export {
  backupExistingConfigs,
  initHub,
  expandTilde,
  type ScaffoldOptions,
  type ScaffoldResult,
} from './core/scaffold.js';
