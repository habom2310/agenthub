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

// Core Chunker
export {
  normalizeContent,
  computeNormalizedHash,
  parseMarkdownChunks,
  diffChunks,
  type MarkdownChunk,
  type ChunkDiff,
} from './core/chunker.js';

// Core Projector
export {
  HEADER_GUARD,
  PLATFORM_RULE_FILES,
  parseFrontmatter,
  projectGeminiRules,
  projectClaudeRules,
  projectCodexRules,
  projectCursorRules,
  projectWindsurfRules,
  projectSubagents,
  projectRules,
  projectAll,
  type AgentFrontmatter,
  type ParsedAgentTemplate,
  type ProjectResult,
  type ProjectSubagentsResult,
  type ProjectRulesResult,
  type ProjectOptions,
} from './core/projector.js';

// Core Promoter
export {
  getExpectedRulesText,
  detectRuleDrift,
  promoteChunk,
  type PlatformDriftReport,
  type PlatformDriftTarget,
  type RuleDriftAudit,
  type PromoteOptions,
  type PromoteResult,
} from './core/promoter.js';

// Core Linker
export {
  linkSkillsForClaude,
  linkSkillsForGemini,
  linkSkillsForCodex,
  projectCodexSkillManifests,
  type LinkResult,
} from './core/linker.js';

// Core MCP Sync
export {
  readJsonSafely,
  normalizeServerForHub,
  adaptServerForClaude,
  adaptServerForGemini,
  getMcpStatus,
  syncMcpServers,
  type McpServerConfig,
  type McpPlatformStatus,
  type McpStatusReport,
  type SyncMcpResult,
} from './core/mcp-sync.js';

// Core Connector
export {
  updateHubManifest,
  connectCursor,
  connectWindsurf,
  connectPlatform,
  type ConnectResult,
} from './core/connector.js';

// Core Doctor
export {
  runDoctor,
  type DoctorOptions,
  type DoctorResult,
} from './core/doctor.js';


