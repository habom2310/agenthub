import fs from 'node:fs';
import path from 'node:path';
import { getEffectiveManifest, loadManifest } from './manifest.js';
import { analyzePackage, findMcpConfigFile, parseMcpServers } from './security.js';
import { extractRepoShorthand } from './share.js';
import { auditTokenBudget, estimateTokens } from './token-budget.js';
import { parseFrontmatter } from './projector.js';

export const DEFAULT_REGISTRY_URL = 'https://agenthub-web.habom2310.workers.dev';

export function getDefaultRegistryUrl(): string {
  return process.env.AGENTHUB_REGISTRY_URL || DEFAULT_REGISTRY_URL;
}

export interface RegistryPackageSummary {
  id: string; // owner/repo
  owner: string;
  repo: string;
  name: string;
  version?: string;
  description?: string;
  type: 'profile' | 'addon';
  platforms: string[];
  tags: string[];
  stars?: number;
  installCount?: number;
  tokenFootprint?: {
    rulesTokens: number;
    skillsTokens: number;
    totalTokens: number;
  };
}

export interface SearchRegistryOptions {
  registryUrl?: string;
  platform?: string;
  type?: string;
  tag?: string;
  limit?: number;
}

export interface SearchRegistryResult {
  success: boolean;
  packages: RegistryPackageSummary[];
  error?: string;
}

export interface PublishToRegistryOptions {
  registryUrl?: string;
  token?: string;
}

export interface PublishToRegistryResult {
  success: boolean;
  status?: number;
  package?: RegistryPackageSummary;
  error?: string;
}

export function getCleanBaseUrl(overrideUrl?: string): string {
  const url = overrideUrl || process.env.AGENTHUB_REGISTRY_URL || DEFAULT_REGISTRY_URL;
  return url.replace(/\/+$/, '');
}

/**
 * Tokens may only be sent over https, or http to a loopback host.
 * Returns an error message, or undefined when the URL is acceptable.
 */
export function checkTokenRegistryUrl(registryUrl?: string): string | undefined {
  const base = getCleanBaseUrl(registryUrl);
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return `Invalid registry URL: ${base}`;
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) return undefined;
  return `Refusing to send a token to ${base}: the registry URL must use https (http is only allowed for localhost).`;
}

/**
 * Searches the AgentHub registry for packages matching given criteria.
 */
export async function searchRegistry(
  query: string,
  options?: SearchRegistryOptions
): Promise<SearchRegistryResult> {
  try {
    const baseUrl = getCleanBaseUrl(options?.registryUrl);
    const url = new URL(`${baseUrl}/api/packages`);

    if (query && query.trim()) {
      url.searchParams.set('q', query.trim());
    }
    if (options?.platform && options.platform.trim()) {
      url.searchParams.set('platform', options.platform.trim());
    }
    if (options?.type && options.type.trim()) {
      url.searchParams.set('type', options.type.trim());
    }
    if (options?.tag && options.tag.trim()) {
      url.searchParams.set('tag', options.tag.trim());
    }
    if (options?.limit !== undefined && options.limit > 0) {
      url.searchParams.set('limit', String(options.limit));
    }

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let errMsg = `Registry search failed: ${res.status} ${res.statusText}`;
      try {
        const parsed = JSON.parse(text);
        if (parsed.error) errMsg = parsed.error;
      } catch {}
      return {
        success: false,
        packages: [],
        error: errMsg,
      };
    }

    const data = await res.json();
    const rawPackages = Array.isArray(data)
      ? data
      : Array.isArray(data?.packages)
        ? data.packages
        : [];

    const packages: RegistryPackageSummary[] = rawPackages.map((pkg: any) => {
      let tokenFootprint: RegistryPackageSummary['tokenFootprint'] = undefined;
      if (typeof pkg.tokenFootprint === 'number') {
        tokenFootprint = {
          rulesTokens: pkg.tokenFootprint,
          skillsTokens: 0,
          totalTokens: pkg.tokenFootprint,
        };
      } else if (pkg.tokenFootprint && typeof pkg.tokenFootprint === 'object') {
        tokenFootprint = {
          rulesTokens: pkg.tokenFootprint.rulesTokens ?? 0,
          skillsTokens: pkg.tokenFootprint.skillsTokens ?? 0,
          totalTokens:
            pkg.tokenFootprint.totalTokens ??
            (pkg.tokenFootprint.rulesTokens ?? 0) + (pkg.tokenFootprint.skillsTokens ?? 0),
        };
      }

      const id = pkg.id || `${pkg.owner || ''}/${pkg.repo || ''}`;
      const [derivedOwner, derivedRepo] = id.includes('/')
        ? id.split('/')
        : [pkg.owner || '', pkg.repo || id];

      return {
        id,
        owner: pkg.owner || derivedOwner,
        repo: pkg.repo || derivedRepo,
        name: pkg.name || derivedRepo || id,
        version: pkg.version,
        description: pkg.description,
        type: pkg.type === 'addon' ? 'addon' : 'profile',
        platforms: Array.isArray(pkg.platforms) ? pkg.platforms : [],
        tags: Array.isArray(pkg.tags) ? pkg.tags : [],
        stars: pkg.stars ?? 0,
        installCount: pkg.installCount ?? 0,
        tokenFootprint,
      };
    });

    const finalPackages =
      options?.limit !== undefined && options.limit > 0
        ? packages.slice(0, options.limit)
        : packages;

    return {
      success: true,
      packages: finalPackages,
    };
  } catch (err: any) {
    return {
      success: false,
      packages: [],
      error: err?.message || String(err),
    };
  }
}

/**
 * Publishes/indexes a package payload in the AgentHub registry.
 */
export async function publishToRegistry(
  payload: Record<string, unknown>,
  options?: PublishToRegistryOptions
): Promise<PublishToRegistryResult> {
  const urlError = checkTokenRegistryUrl(options?.registryUrl);
  if (urlError) return { success: false, error: urlError };
  try {
    const baseUrl = getCleanBaseUrl(options?.registryUrl);
    const url = `${baseUrl}/api/index`;

    const rawToken = options?.token || process.env.AGENTHUB_TOKEN;
    const token = rawToken?.trim();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let errMsg = `Registry publishing failed: ${res.status} ${res.statusText}`;
      try {
        const parsed = JSON.parse(text);
        if (parsed.error) errMsg = parsed.error;
      } catch {}
      return {
        success: false,
        status: res.status,
        error: errMsg,
      };
    }

    const data = await res.json();
    return {
      success: true,
      package: data?.package,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || String(err),
    };
  }
}

export interface RegistryUser {
  login: string;
  id?: number;
  name?: string | null;
  avatarUrl?: string;
}

export interface RegistryCallResult<T> {
  success: boolean;
  status?: number;
  data?: T;
  error?: string;
}

/**
 * Calls a registry endpoint and normalizes failures into readable `error` strings.
 */
async function registryCall<T>(
  registryUrl: string | undefined,
  apiPath: string,
  method: string,
  token?: string
): Promise<RegistryCallResult<T>> {
  const urlError = checkTokenRegistryUrl(registryUrl);
  if (urlError) return { success: false, error: urlError };
  const baseUrl = getCleanBaseUrl(registryUrl);
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token?.trim()) headers['Authorization'] = `Bearer ${token.trim()}`;
    const res = await fetch(`${baseUrl}${apiPath}`, {
      method,
      headers,
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text().catch(() => '');
    let data: any;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {}
    if (!res.ok) {
      return {
        success: false,
        status: res.status,
        error: data?.error || `Registry request failed: ${res.status} ${res.statusText}`,
      };
    }
    return { success: true, status: res.status, data };
  } catch (err: any) {
    const reason = err?.cause?.code || err?.cause?.message || err?.message || String(err);
    return { success: false, error: `Could not reach registry at ${baseUrl} (${reason})` };
  }
}

async function registryCallRequiring<T>(
  registryUrl: string | undefined,
  apiPath: string,
  token: string | undefined,
  field: keyof T & string,
  invalidMessage: string
): Promise<RegistryCallResult<T>> {
  const res = await registryCall<T>(registryUrl, apiPath, 'GET', token);
  if (res.success && !res.data?.[field]) {
    return { success: false, status: res.status, error: invalidMessage };
  }
  return res;
}

/**
 * Fetches the GitHub OAuth client id the registry uses for device login.
 */
export function fetchAuthConfig(registryUrl?: string): Promise<RegistryCallResult<{ githubClientId: string }>> {
  return registryCallRequiring(
    registryUrl,
    '/api/auth/config',
    undefined,
    'githubClientId',
    'Registry returned no GitHub client id'
  );
}

/**
 * Returns the GitHub identity the registry associates with a token.
 */
export function whoami(token: string, registryUrl?: string): Promise<RegistryCallResult<RegistryUser>> {
  return registryCallRequiring(
    registryUrl,
    '/api/auth/whoami',
    token,
    'login',
    'Registry returned an invalid identity'
  );
}

/**
 * Removes a package from the registry (requires push access to the repo).
 */
export async function unpublishFromRegistry(
  packageId: string,
  token: string,
  registryUrl?: string
): Promise<RegistryCallResult<{ message?: string }>> {
  const [owner, repo, ...rest] = packageId.split('/');
  if (!owner || !repo || rest.length > 0) {
    return { success: false, error: `Invalid package "${packageId}". Expected owner/repo.` };
  }
  return registryCall(
    registryUrl,
    `/api/packages/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    'DELETE',
    token
  );
}

const MCP_STATUS = { LOW: 'verified', MEDIUM: 'needs-review', HIGH: 'warning' } as const;

/**
 * Builds package summary payload from a local hub directory for publishing.
 */
export function buildPackagePayload(
  hubDir: string,
  extra?: { repoShorthand?: string; remoteUrl?: string }
): Record<string, unknown> {
  let owner = '';
  let repo = '';
  if (extra?.repoShorthand) {
    const parts = extra.repoShorthand.split('/');
    owner = parts[0] || '';
    repo = parts[1] || '';
  } else if (extra?.remoteUrl) {
    const shorthand = extractRepoShorthand(extra.remoteUrl);
    if (shorthand) {
      const parts = shorthand.split('/');
      owner = parts[0] || '';
      repo = parts[1] || '';
    }
  }

  if (!owner) owner = 'community';
  if (!repo) repo = loadManifest(hubDir)?.name || path.basename(path.resolve(hubDir));
  // Without an explicit name, the package is named after its repo, not the hub folder (".agenthub")
  const manifest = getEffectiveManifest(hubDir, repo);

  const readmePath = path.join(hubDir, 'README.md');
  const readme = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, 'utf-8') : '';

  // Collect skills
  const skillsDir = path.join(hubDir, 'skills');
  const skills: Array<{ name: string; description: string; path: string }> = [];
  if (fs.existsSync(skillsDir) && fs.statSync(skillsDir).isDirectory()) {
    try {
      const entries = fs.readdirSync(skillsDir);
      for (const entry of entries) {
        const skillPath = path.join(skillsDir, entry);
        if (fs.statSync(skillPath).isDirectory()) {
          skills.push({
            name: entry,
            description: `Skill: ${entry}`,
            path: `skills/${entry}`,
          });
        }
      }
    } catch {}
  }

  // Scan rules/ to construct rulesAst
  const rulesAst: Array<{ title: string; file: string; tokens: number; content: string }> = [];
  const rulesDir = path.join(hubDir, 'rules');
  if (fs.existsSync(rulesDir) && fs.statSync(rulesDir).isDirectory()) {
    const walkRules = (dir: string): void => {
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkRules(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          try {
            const content = fs.readFileSync(fullPath, 'utf-8');
            const relFile = path.relative(hubDir, fullPath).replace(/\\/g, '/');
            const { meta, body } = parseFrontmatter(content);

            let title = '';
            if (meta.title && typeof meta.title === 'string' && meta.title.trim()) {
              title = meta.title.trim();
            } else if (meta.name && typeof meta.name === 'string' && meta.name.trim()) {
              title = meta.name.trim();
            } else {
              const headingMatch = body.match(/^#\s+(.+)$/m);
              if (headingMatch && headingMatch[1].trim()) {
                title = headingMatch[1].trim();
              } else {
                title = path.basename(fullPath);
              }
            }

            const tokens = estimateTokens(content);
            rulesAst.push({
              title,
              file: relFile,
              tokens,
              content,
            });
          } catch {}
        }
      }
    };
    walkRules(rulesDir);
    rulesAst.sort((a, b) => a.file.localeCompare(b.file));
  }

  // Security analysis
  const analysis = analyzePackage(hubDir, manifest.name);

  // MCP servers carry the scan's per-server risk
  // env sends only the config's key names; the scan also pulls $VAR-like fragments out of values
  const mcpConfigFile = findMcpConfigFile(hubDir);
  const mcpConfig = mcpConfigFile ? parseMcpServers(mcpConfigFile).servers : {};
  const mcpServers = analysis.mcpServers.map((s) => ({
    name: s.name,
    command: s.command,
    args: s.args,
    env: Object.keys(mcpConfig[s.name]?.env ?? {}),
    risk: s.riskLevel.toLowerCase(),
    status: MCP_STATUS[s.riskLevel],
  }));

  // Calculate token footprint
  const budget = auditTokenBudget(hubDir);
  const rulesTokens = rulesAst.reduce((acc, r) => acc + r.tokens, 0);

  return {
    owner,
    repo,
    name: manifest.name || repo,
    version: manifest.version || '1.0.0',
    description: manifest.description || '',
    type: manifest.type || 'profile',
    platforms:
      manifest.platforms && manifest.platforms.length > 0
        ? manifest.platforms
        : ['gemini', 'claude', 'codex', 'cursor', 'windsurf'],
    tags: manifest.tags || [],
    license: manifest.license || 'MIT',
    skills,
    mcpServers,
    readme,
    tokenFootprint: Math.max(budget.total_boot_tokens || 0, rulesTokens),
    rulesAst,
    securityRisk: analysis.riskLevel.toLowerCase(),
    isClean: analysis.isClean,
  };
}
