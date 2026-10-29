/**
 * agenthub - Unified configuration, skills, rules, and MCP management engine
 */

export const VERSION = '0.3.1';

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
  getAddonRuleFiles,
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
  linkSkillsForAllAssistants,
  type LinkAllSkillsResult,
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

// Core Git Sync
export {
  STANDARD_IGNORE_ENTRIES,
  isGitInstalled,
  isGitRepo,
  ensureGitignore,
  gitStatus,
  gitInitHub,
  gitPush,
  gitPull,
  redactGitSecrets,
  type GitStatusResult,
  type GitOperationResult,
} from './core/git-sync.js';

// Core Exporter
export {
  EXPORT_TARGETS,
  exportRules,
  type ExportTargetConfig,
  type ExportResult,
} from './core/exporter.js';

// Core Token Budget
export {
  ESTIMATED_CHARS_PER_TOKEN,
  TARGET_BUDGET,
  estimateTokens,
  auditTokenBudget,
  type BudgetAuditResult,
} from './core/token-budget.js';

// Core Manifest
export {
  DEFAULT_PLATFORMS,
  loadManifest,
  inferManifest,
  getEffectiveManifest,
  writeManifest,
  type AgentPackageManifest,
} from './core/manifest.js';

// Core Security
export {
  analyzePackage,
  findMcpConfigFile,
  parseMcpServers,
  type McpServerAnalysis,
  type ScriptAnalysis,
  type PackageAnalysisReport,
} from './core/security.js';


// Core Distribution Engine
export {
  resolvePackageTarget,
  packageInfo,
  packageAdd,
  sanitizeIdentifier,
  type AddPackageOptions,
  type AddPackageResult,
} from './core/distribution.js';

// Core Profile Manager
export {
  profileList,
  profileCreate,
  profileUse,
  type ProfileListResult,
  type ProfileCreateResult,
  type ProfileUseOptions,
  type ProfileUseResult,
} from './core/profile.js';

// Core Share Publisher
export {
  shareSetup,
  extractRepoShorthand,
  type ShareOptions,
  type ShareResult,
} from './core/share.js';

// Core Uninstaller
export {
  findEarliestBackup,
  restoreFromBackup,
  cleanupJunctions,
  cleanupGeneratedRules,
  uninstallHub,
  type UninstallOptions,
  type UninstallResult,
} from './core/uninstaller.js';

// Core Registry
export {
  DEFAULT_REGISTRY_URL,
  getDefaultRegistryUrl,
  searchRegistry,
  publishToRegistry,
  buildPackagePayload,
  getCleanBaseUrl,
  checkTokenRegistryUrl,
  fetchAuthConfig,
  whoami,
  unpublishFromRegistry,
  type RegistryUser,
  type RegistryCallResult,
  type RegistryPackageSummary,
  type SearchRegistryOptions,
  type SearchRegistryResult,
  type PublishToRegistryOptions,
  type PublishToRegistryResult,
} from './core/registry.js';

// Core Auth
export {
  getAuthFilePath,
  getStoredCredential,
  saveCredential,
  deleteCredential,
  resolveToken,
  runDeviceFlow,
  deviceFlowRuntime,
  type StoredCredential,
  type DeviceFlowOptions,
} from './core/auth.js';


