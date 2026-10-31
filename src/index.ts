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
  linkSkillsForCursor,
  linkSkillsForWindsurf,
  linkSkillsForCopilot,
  cursorSkillsProvider,
  projectCodexSkillManifests,
  linkSkillsForAllAssistants,
  type LinkAllSkillsResult,
  type LinkResult,
} from './core/linker.js';

// Core MCP Sync
export {
  readJsonSafely,
  expandPathPlaceholders,
  contractPaths,
  normalizeServerForHub,
  adaptServerForClaude,
  adaptServerForGemini,
  getMcpStatus,
  syncMcpServers,
  type McpServerConfig,
  type McpExtraPlatformStatus,
  type McpPlatformStatus,
  type McpStatusReport,
  type SyncMcpResult,
} from './core/mcp-sync.js';

// Core MCP platform adapters (Codex, Cursor, Windsurf, Copilot CLI)
export {
  MCP_PLATFORMS,
  MCP_PLATFORM_IDS,
  readPlatformFile,
  projectPlatformServers,
  writePlatformServers,
  spliceCodexServers,
  type McpPlatform,
  type McpPlatformId,
} from './core/mcp-platforms.js';

// Core MCP probe
export {
  probeMcpServer,
  probeMcpServers,
  resolveServerVars,
  MCP_PROTOCOL_VERSION,
  type ProbeOptions,
  type ProbeResult,
} from './core/mcp-probe.js';

// Core Skill checks
export {
  checkSkillDir,
  findDuplicateSkills,
  parseSkillFrontmatter,
  type SkillIssue,
} from './core/skill-check.js';

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
export {
  probeTargets,
  runFullDoctor,
  runFunctionalChecks,
  structuralItems,
  countLevels,
  type DoctorItem,
  type FullDoctorOptions,
  type FullDoctorResult,
} from './core/doctor-full.js';

// Core Adopt
export {
  runAdopt,
  scanAdoptable,
  applyProposal,
  type AdoptChoice,
  type AdoptItem,
  type AdoptOptions,
  type AdoptPrompter,
  type AdoptProposal,
  type AdoptReport,
} from './core/adopt.js';

// Core Git Sync
export {
  STANDARD_IGNORE_ENTRIES,
  updateManagedIgnoreBlock,
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
  setDeclaredSource,
  type AgentPackageManifest,
  type SourceSpec,
} from './core/manifest.js';

// Core Sources and Installer
export {
  parseSourceSpec,
  parseDeclaredSources,
  loadDeclaredSources,
  loadLock,
  loadLockChecked,
  saveLock,
  resolvePin,
  type DeclaredSource,
  type ParsedSource,
  type LockFile,
  type LockEntry,
  type SourceKind,
} from './core/sources.js';
export {
  hasDeclaredSources,
  isBareHub,
  actionLabel,
  itemLabel,
  planInstall,
  describePlan,
  runInstall,
  finalizeInstall,
  updatePins,
  type InstallAction,
  type InstallPlan,
  type InstallProblem,
  type InstallResult,
  type PinChange,
} from './core/installer.js';

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


