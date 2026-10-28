import { getHubDir } from './detector.js';
import { ensureGitignore, gitPush, gitStatus } from './git-sync.js';
import { analyzePackage } from './security.js';
import { auditTokenBudget } from './token-budget.js';

export interface ShareOptions {
  hubDir?: string;
  remote?: string;
  branch?: string;
  commitMessage?: string;
  force?: boolean;
}

export interface ShareResult {
  success: boolean;
  shareCommand: string;
  profileCommand: string;
  remoteUrl?: string;
  repoShorthand?: string;
  warnings: string[];
  message: string;
}

/**
 * Extracts a repository shorthand (owner/repo) from standard git remote URLs.
 */
export function extractRepoShorthand(remoteUrl: string): string | undefined {
  if (!remoteUrl) return undefined;
  const match = remoteUrl.match(
    /(?:github\.com|gitlab\.com|bitbucket\.org)[:/]([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/i
  );
  if (match) {
    return `${match[1]}/${match[2]}`;
  }
  return undefined;
}

/**
 * Validates, audits, and publishes the hub setup to a remote git repository for sharing.
 */
export function shareSetup(options?: ShareOptions): ShareResult {
  const hub = options?.hubDir || getHubDir();
  const warnings: string[] = [];

  // 1. Security Scan
  const analysis = analyzePackage(hub);
  if (analysis.warnings.length > 0) {
    warnings.push(...analysis.warnings);
  }

  const hasSecrets = analysis.warnings.some((w) => /secret|credential/i.test(w));
  const isHighRisk = analysis.riskLevel === 'HIGH' || hasSecrets;

  if (isHighRisk && !options?.force) {
    return {
      success: false,
      shareCommand: '',
      profileCommand: '',
      warnings,
      message: 'Security check failed. Remove sensitive data before sharing or use --force.',
    };
  }

  // 2. Token Budget Audit
  const audit = auditTokenBudget(hub);
  if (audit.status === 'EXCEEDED') {
    warnings.push(`Token budget exceeded: ${audit.total_boot_tokens} tokens (budget: ${audit.budget})`);
  }

  // 3. Git Status & Gitignore
  ensureGitignore(hub);
  const status = gitStatus(hub);
  const remoteName = options?.remote || 'origin';
  const remoteUrl = status.remotes ? status.remotes[remoteName] : undefined;

  if (!status.is_repo || !remoteUrl) {
    return {
      success: false,
      shareCommand: '',
      profileCommand: '',
      warnings,
      message: 'Git remote not configured. Please initialize git and set a remote: git remote add origin <url>',
    };
  }

  // 4. Git Push
  const pushRes = gitPush({
    hubDir: hub,
    remote: remoteName,
    branch: options?.branch,
    commitMessage: options?.commitMessage || 'Sync setup via AgentHub',
  });

  if (!pushRes.ok) {
    return {
      success: false,
      shareCommand: '',
      profileCommand: '',
      remoteUrl,
      warnings,
      message: pushRes.message,
    };
  }

  // Extract repo shorthand & format ready-to-share commands
  const repoShorthand = extractRepoShorthand(remoteUrl);
  const targetSpecifier = repoShorthand || remoteUrl;

  const shareCommand = `agenthub add ${targetSpecifier}`;
  const profileCommand = `agenthub profile use ${targetSpecifier}`;

  return {
    success: true,
    shareCommand,
    profileCommand,
    remoteUrl,
    repoShorthand,
    warnings,
    message: `Setup successfully pushed to ${remoteName}. Ready to share!`,
  };
}
