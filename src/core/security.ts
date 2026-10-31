import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_MANIFEST_MCP, getEffectiveManifest, type AgentPackageManifest } from './manifest.js';
import { STANDARD_IGNORE_ENTRIES } from './git-sync.js';
import { ignoredNames } from './local.js';
import { parseDeclaredSources, type SourceKind } from './sources.js';
import { estimateTokens } from './token-budget.js';
import { parseFrontmatter } from './projector.js';

export interface McpServerAnalysis {
  name: string;
  command: string;
  args: string[];
  envVars: string[];
  isSuspicious: boolean;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  warnings: string[];
}

export interface ScriptAnalysis {
  path: string; // relative to packageDir
  warnings: string[];
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface SecretFinding {
  path: string; // relative to packageDir
  line: number;
  type: string;
}

export interface SourceAnalysis {
  kind: SourceKind;
  name: string;
  /** Declared source string, e.g. "github:owner/repo#skills/x" or "custom" */
  source: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  /** Shell commands the install would run (custom check and install, build) */
  commands: string[];
}

export interface PackageAnalysisReport {
  manifest: AgentPackageManifest;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  isClean: boolean;
  mcpServers: McpServerAnalysis[];
  sources: SourceAnalysis[];
  scripts: ScriptAnalysis[];
  secrets: SecretFinding[]; // hardcoded secrets in non-script text files
  envVarsRequired: string[];
  tokenFootprint: {
    rulesTokens: number;
    skillsTokens: number;
    totalTokens: number;
  };
  warnings: string[];
}

const SHELL_INTERPRETERS = new Set([
  'bash',
  'sh',
  'zsh',
  'cmd',
  'cmd.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
  'csh',
  'tcsh',
  'fish',
]);

const REMOTE_DOWNLOAD_COMMANDS = new Set([
  'curl',
  'wget',
  'invoke-webrequest',
  'iwr',
]);

const SUSPICIOUS_BINARIES = new Set([
  'nc',
  'netcat',
  'ncat',
  'socat',
  'telnet',
]);

const SCRIPT_RUNNERS = new Set([
  'node',
  'python',
  'python3',
  'py',
  'ruby',
  'perl',
  'php',
  'deno',
  'bun',
]);

const SAFE_PACKAGE_RUNNERS = new Set([
  'npx',
  'uvx',
  'docker',
  'podman',
]);

const SCRIPT_EXTENSIONS = new Set([
  '.sh',
  '.bash',
  '.ps1',
  '.bat',
  '.cmd',
  '.py',
  '.js',
  '.ts',
  '.mjs',
  '.cjs',
]);

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.codegraph',
  'dist',
  'build',
  '.next',
]);

const SECRET_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'GitHub Token', pattern: /ghp_[A-Za-z0-9_]{36}/ },
  { name: 'OpenAI/Anthropic API Key', pattern: /sk-[A-Za-z0-9]{32,}/ },
  { name: 'AWS Access Key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Private Key', pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { name: 'Bearer Token', pattern: /Bearer\s+[A-Za-z0-9_\-\.]{20,}/i },
];

// Files the hub .gitignore keeps out of the pushed repo (backups/, .env, ...)
const GITIGNORED: { dir: boolean; regex: RegExp }[] = STANDARD_IGNORE_ENTRIES.map((entry) => {
  const dir = entry.endsWith('/');
  const glob = dir ? entry.slice(0, -1) : entry;
  const source = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return { dir, regex: new RegExp(`^${source}$`) };
});

const MAX_TEXT_FILE_BYTES = 1024 * 1024;

// Hub content scanned for secrets; other repo files (docs, tests, src) are left alone
// so third-party packages with example tokens are not flagged
const SECRET_SCAN_DIRS = ['rules', 'agents', 'skills', 'mcp'];
const SECRET_SCAN_FILES = ['agenthub.json', 'README.md', 'rules.md', 'servers.json', 'mcp.json'];

export function findMcpConfigFile(packageDir: string): string | null {
  const candidates = [
    path.join(packageDir, 'mcp', 'servers.json'),
    path.join(packageDir, 'servers.json'),
    path.join(packageDir, 'mcp.json'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        if (fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // continue
      }
    }
  }
  return null;
}

export function parseMcpServers(filePath: string): { servers: Record<string, any>; warnings: string[] } {
  const warnings: string[] = [];
  let parsed: any;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    parsed = JSON.parse(raw);
  } catch {
    warnings.push(`Failed to parse MCP configuration in ${path.basename(filePath)}: Invalid JSON`);
    return { servers: {}, warnings };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { servers: {}, warnings };
  }

  if (parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)) {
    return { servers: parsed.mcpServers, warnings };
  }

  const servers: Record<string, any> = {};
  for (const [key, val] of Object.entries(parsed)) {
    if (key.startsWith('$')) continue;
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      servers[key] = val;
    }
  }
  return { servers, warnings };
}

function extractEnvVarsFromString(text: string, set: Set<string>): void {
  for (const match of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    if (match[1]) set.add(match[1]);
  }
  for (const match of text.matchAll(/(?:^|[^A-Za-z0-9_])\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (match[1]) set.add(match[1]);
  }
  for (const match of text.matchAll(/%([A-Za-z_][A-Za-z0-9_]*)%/g)) {
    if (match[1]) set.add(match[1]);
  }
}

function extractServerEnvVars(config: any): string[] {
  const envSet = new Set<string>();

  if (config.env && typeof config.env === 'object' && !Array.isArray(config.env)) {
    for (const [key, val] of Object.entries(config.env)) {
      envSet.add(key);
      if (typeof val === 'string') {
        extractEnvVarsFromString(val, envSet);
      }
    }
  }

  if (typeof config.command === 'string') {
    extractEnvVarsFromString(config.command, envSet);
  }

  if (Array.isArray(config.args)) {
    for (const arg of config.args) {
      if (typeof arg === 'string') {
        extractEnvVarsFromString(arg, envSet);
      }
    }
  }

  return Array.from(envSet).sort();
}

function analyzeMcpServer(name: string, config: any): McpServerAnalysis {
  const command = typeof config?.command === 'string' ? config.command : '';
  const args: string[] = Array.isArray(config?.args)
    ? config.args.map((a: unknown) => String(a))
    : [];
  const envVars = extractServerEnvVars(config || {});

  const cmdBase = path.basename(command).toLowerCase().replace(/\.exe$/, '');
  let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' = 'LOW';
  let isSuspicious = false;
  const warnings: string[] = [];

  // Shell interpreters
  if (SHELL_INTERPRETERS.has(cmdBase)) {
    isSuspicious = true;
    riskLevel = 'HIGH';
    warnings.push(`Suspicious shell command: ${command}`);
    if (args.some((a) => a === '-c' || a === '/c' || a === '-Command')) {
      warnings.push(`Shell interpreter executes inline code with flag`);
    }
  }

  // Remote downloaders
  if (REMOTE_DOWNLOAD_COMMANDS.has(cmdBase)) {
    isSuspicious = true;
    riskLevel = 'HIGH';
    warnings.push(`Remote download command detected: ${command}`);
  }

  // Suspicious network utilities
  if (SUSPICIOUS_BINARIES.has(cmdBase)) {
    isSuspicious = true;
    riskLevel = 'HIGH';
    warnings.push(`Suspicious network utility: ${command}`);
  }

  // Check command and all args for pipes, redirects, remote downloads, or destructive commands
  const allParts = [command, ...args];
  for (const part of allParts) {
    if (/[|><]/.test(part)) {
      isSuspicious = true;
      riskLevel = 'HIGH';
      warnings.push(`Command contains pipes or redirects: "${part}"`);
    }
    if (/\b(?:curl|wget|Invoke-WebRequest|iwr)\b/i.test(part)) {
      isSuspicious = true;
      riskLevel = 'HIGH';
      warnings.push(`Remote download detected in arguments: "${part}"`);
    }
    if (
      /rm\s+-(?:r[a-z]*f|f[a-z]*r)\s+[\/\~]/i.test(part) ||
      /Remove-Item\s+.*-(?:Recurse|Force)/i.test(part) ||
      /\bformat\s+[a-zA-Z]:/i.test(part) ||
      /\bformat\s+\//i.test(part)
    ) {
      isSuspicious = true;
      riskLevel = 'HIGH';
      warnings.push(`Destructive command detected: "${part}"`);
    }
  }

  // If not HIGH, assess script runners vs package runners
  if (riskLevel !== 'HIGH') {
    if (SCRIPT_RUNNERS.has(cmdBase)) {
      riskLevel = 'MEDIUM';
    } else if (SAFE_PACKAGE_RUNNERS.has(cmdBase)) {
      riskLevel = 'LOW';
    } else if (!command) {
      riskLevel = 'LOW';
      warnings.push('MCP server has no command specified');
    } else {
      riskLevel = 'MEDIUM';
    }
  }

  return {
    name,
    command,
    args,
    envVars,
    isSuspicious,
    riskLevel,
    warnings,
  };
}

function collectScriptFiles(packageDir: string): string[] {
  const scriptPaths: string[] = [];

  function walk(currentDir: string): void {
    if (!fs.existsSync(currentDir)) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const fullPath = path.join(currentDir, entry.name);
      if (isVendorRoot(packageDir, fullPath)) continue;
      const relPath = path.relative(packageDir, fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SCRIPT_EXTENSIONS.has(ext)) {
          const parts = relPath.split('/');
          const inSkills = parts[0] === 'skills';
          const inScripts = parts.includes('scripts');
          if (inSkills || inScripts) {
            scriptPaths.push(fullPath);
          }
        }
      }
    }
  }

  walk(packageDir);
  return scriptPaths;
}

function analyzeScript(packageDir: string, filePath: string): ScriptAnalysis {
  const relPath = path.relative(packageDir, filePath).replace(/\\/g, '/');
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return {
      path: relPath,
      warnings: [`Unable to read script file: ${relPath}`],
      riskLevel: 'MEDIUM',
    };
  }

  const warnings: string[] = [];
  let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' = 'LOW';

  // 1. Remote piped execution
  const remotePipeRegexes = [
    /curl\s+[^|\r\n]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/i,
    /wget\s+[^|\r\n]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/i,
    /\bInvoke-Expression\b/i,
    /\biex\b/i,
    /\birm\s+[^|\r\n]*\|\s*iex\b/i,
  ];

  for (const regex of remotePipeRegexes) {
    if (regex.test(content)) {
      warnings.push(`Remote piped execution detected (curl|sh, wget|bash, iex, or Invoke-Expression) in ${relPath}`);
      riskLevel = 'HIGH';
      break;
    }
  }

  // 2. Hardcoded secrets / credentials
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      warnings.push(`Hardcoded secret/credential detected (${name}) in ${relPath}`);
      riskLevel = 'HIGH';
    }
  }

  // 3. Destructive commands
  const destructiveRegexes: { desc: string; pattern: RegExp }[] = [
    { desc: 'rm -rf /', pattern: /rm\s+-(?:r[a-z]*f|f[a-z]*r)\s+[\/\~]/i },
    { desc: 'Remove-Item -Recurse -Force /', pattern: /Remove-Item\s+.*-Recurse.*-Force/i },
    { desc: 'Remove-Item -Force -Recurse /', pattern: /Remove-Item\s+.*-Force.*-Recurse/i },
    { desc: 'format command', pattern: /\bformat\s+[a-zA-Z]:/i },
    { desc: 'format command', pattern: /\bformat\s+\//i },
  ];

  for (const { desc, pattern } of destructiveRegexes) {
    if (pattern.test(content)) {
      warnings.push(`Destructive command detected (${desc}) in ${relPath}`);
      riskLevel = 'HIGH';
      break;
    }
  }

  return {
    path: relPath,
    warnings,
    riskLevel,
  };
}

// vendor/ holds third-party installs; they are declared, not shipped, so never scanned
function isVendorRoot(packageDir: string, fullPath: string): boolean {
  return path.relative(packageDir, fullPath) === 'vendor';
}

function analyzeSources(manifest: AgentPackageManifest): { sources: SourceAnalysis[]; warnings: string[] } {
  const { sources: declared, errors } = parseDeclaredSources(manifest);
  const warnings = errors.map((e) => `Invalid source declaration: ${e}`);
  const sources = declared.map((d): SourceAnalysis => {
    const p = d.parsed;
    const commands: string[] = [];
    let riskLevel: SourceAnalysis['riskLevel'] = 'LOW';
    const starter = d.kind === 'mcp' ? (DEFAULT_MANIFEST_MCP as Record<string, { install?: string; check: string }>)[d.name] : undefined;
    if (p.type === 'custom' && starter && starter.install === p.install && starter.check === p.check) {
      // the starter declaration every new hub ships with, not something the user added
      commands.push(p.check, ...(p.install ? [p.install] : []));
    } else if (p.type === 'custom') {
      commands.push(p.check, ...(p.install ? [p.install] : []));
      riskLevel = 'HIGH';
      warnings.push(`${d.kind}.${d.name} runs custom commands (check: ${p.check}${p.install ? `; install: ${p.install}` : ''})`);
    } else if ((p.type === 'github' || p.type === 'git' || p.type === 'local') && p.build) {
      commands.push(p.build);
      riskLevel = 'MEDIUM';
      warnings.push(`${d.kind}.${d.name} runs a build command: ${p.build}`);
    }
    return { kind: d.kind, name: d.name, source: d.spec, riskLevel, commands };
  });
  return { sources, warnings };
}

function isGitignored(name: string, isDir: boolean): boolean {
  return GITIGNORED.some((g) => g.dir === isDir && g.regex.test(name));
}

function collectTextFiles(packageDir: string, exclude: Set<string>): string[] {
  const files: string[] = [];

  function walk(currentDir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const fullPath = path.join(currentDir, entry.name);
      if (isVendorRoot(packageDir, fullPath)) continue;
      if (entry.isDirectory()) {
        if (!isGitignored(entry.name, true)) walk(fullPath);
      } else if (entry.isFile() && !isGitignored(entry.name, false) && !exclude.has(fullPath)) {
        files.push(fullPath);
      }
    }
  }

  for (const dir of SECRET_SCAN_DIRS) walk(path.join(packageDir, dir));
  for (const name of SECRET_SCAN_FILES) {
    const fullPath = path.join(packageDir, name);
    try {
      if (fs.statSync(fullPath).isFile() && !exclude.has(fullPath)) files.push(fullPath);
    } catch {
      // missing
    }
  }
  return files;
}

// Reports file, line and pattern name only, never the matched secret
function scanFileForSecrets(packageDir: string, filePath: string): SecretFinding[] {
  let content: string;
  try {
    if (fs.statSync(filePath).size > MAX_TEXT_FILE_BYTES) return [];
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  if (content.includes('\0')) return []; // binary

  const relPath = path.relative(packageDir, filePath).replace(/\\/g, '/');
  const findings: SecretFinding[] = [];
  content.split(/\r?\n/).forEach((text, i) => {
    for (const { name, pattern } of SECRET_PATTERNS) {
      if (pattern.test(text)) {
        findings.push({ path: relPath, line: i + 1, type: name });
      }
    }
  });
  return findings;
}

function calculateTokenFootprint(packageDir: string): {
  rulesTokens: number;
  skillsTokens: number;
  totalTokens: number;
} {
  let rulesChars = 0;

  // Root rules.md if any
  const rootRulesMd = path.join(packageDir, 'rules.md');
  if (fs.existsSync(rootRulesMd)) {
    try {
      if (fs.statSync(rootRulesMd).isFile()) {
        const content = fs.readFileSync(rootRulesMd, 'utf-8');
        rulesChars += content.trim().length;
      }
    } catch {
      // ignore
    }
  }

  // All markdown files in rules/
  const rulesDir = path.join(packageDir, 'rules');
  if (fs.existsSync(rulesDir)) {
    try {
      if (fs.statSync(rulesDir).isDirectory()) {
        const scanRules = (dir: string): void => {
          let entries: fs.Dirent[];
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              scanRules(fullPath);
            } else if (entry.isFile() && entry.name.endsWith('.md')) {
              try {
                const content = fs.readFileSync(fullPath, 'utf-8');
                rulesChars += content.trim().length;
              } catch {
                // ignore
              }
            }
          }
        };
        scanRules(rulesDir);
      }
    } catch {
      // ignore
    }
  }

  const rulesTokens = estimateTokens(rulesChars);

  // Skill definitions in skills/*/SKILL.md
  let skillsChars = 0;
  const skillsDir = path.join(packageDir, 'skills');
  if (fs.existsSync(skillsDir)) {
    try {
      if (fs.statSync(skillsDir).isDirectory()) {
        let entries: string[];
        try {
          entries = fs.readdirSync(skillsDir);
        } catch {
          entries = [];
        }
        for (const entry of entries) {
          const skillFolder = path.join(skillsDir, entry);
          try {
            if (!fs.statSync(skillFolder).isDirectory()) continue;
          } catch {
            continue;
          }
          const skillMd = path.join(skillFolder, 'SKILL.md');
          if (fs.existsSync(skillMd)) {
            try {
              const content = fs.readFileSync(skillMd, 'utf-8');
              const { meta } = parseFrontmatter(content);
              const name = meta.name ? String(meta.name) : entry;
              const description = meta.description ? String(meta.description) : '';
              const registryText = `${name}: ${description}`.trim();
              skillsChars += registryText.length;
            } catch {
              // ignore
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  const skillsTokens = estimateTokens(skillsChars);
  const totalTokens = rulesTokens + skillsTokens;

  return {
    rulesTokens,
    skillsTokens,
    totalTokens,
  };
}

/**
 * Analyzes an AgentHub package for security, dependencies, and token footprint.
 */
export function analyzePackage(packageDir: string, fallbackName?: string): PackageAnalysisReport {
  const manifest = getEffectiveManifest(packageDir, fallbackName);
  const topLevelWarnings: string[] = [];

  // MCP Servers Analysis
  const mcpConfigFile = findMcpConfigFile(packageDir);
  const mcpServers: McpServerAnalysis[] = [];
  if (mcpConfigFile) {
    const { servers, warnings: parseWarnings } = parseMcpServers(mcpConfigFile);
    topLevelWarnings.push(...parseWarnings);
    const ignored = ignoredNames(packageDir, 'mcp');
    for (const [name, config] of Object.entries(servers)) {
      if (ignored.has(name)) continue;
      mcpServers.push(analyzeMcpServer(name, config));
    }
  }

  // Declared sources (skills/mcp in agenthub.json)
  const sourceAnalysis = analyzeSources(manifest);
  topLevelWarnings.push(...sourceAnalysis.warnings);
  const sources = sourceAnalysis.sources;

  // Scripts Analysis
  const scriptFiles = collectScriptFiles(packageDir);
  const scripts: ScriptAnalysis[] = scriptFiles.map((sf) => analyzeScript(packageDir, sf));

  // Secrets in the other hub files that get pushed (rules, agents, skills, MCP config, manifest, README)
  const secrets: SecretFinding[] = collectTextFiles(packageDir, new Set(scriptFiles)).flatMap((f) =>
    scanFileForSecrets(packageDir, f)
  );

  // Required Env Vars
  const envVarsSet = new Set<string>();
  for (const s of mcpServers) {
    for (const v of s.envVars) {
      envVarsSet.add(v);
    }
  }
  const envVarsRequired = Array.from(envVarsSet).sort();

  // Token Footprint
  const tokenFootprint = calculateTokenFootprint(packageDir);

  // Combined deduplicated warnings
  const warningsSet = new Set<string>();
  for (const w of topLevelWarnings) {
    warningsSet.add(w);
  }
  for (const s of mcpServers) {
    for (const w of s.warnings) {
      warningsSet.add(w);
    }
  }
  for (const sc of scripts) {
    for (const w of sc.warnings) {
      warningsSet.add(w);
    }
  }
  for (const f of secrets) {
    warningsSet.add(`Hardcoded secret/credential detected (${f.type}) in ${f.path}:${f.line}`);
  }
  const warnings = Array.from(warningsSet);

  // Overall risk assessment
  let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' = 'LOW';
  if (
    mcpServers.some((s) => s.riskLevel === 'HIGH') ||
    sources.some((s) => s.riskLevel === 'HIGH') ||
    scripts.some((sc) => sc.riskLevel === 'HIGH') ||
    secrets.length > 0
  ) {
    riskLevel = 'HIGH';
  } else if (
    mcpServers.some((s) => s.riskLevel === 'MEDIUM') ||
    sources.some((s) => s.riskLevel === 'MEDIUM') ||
    scripts.some((sc) => sc.riskLevel === 'MEDIUM')
  ) {
    riskLevel = 'MEDIUM';
  }

  // isClean: true if risk is 'LOW' and no warnings/secrets found; false otherwise.
  const isClean = riskLevel === 'LOW' && warnings.length === 0;

  return {
    manifest,
    riskLevel,
    isClean,
    mcpServers,
    sources,
    scripts,
    secrets,
    envVarsRequired,
    tokenFootprint,
    warnings,
  };
}
