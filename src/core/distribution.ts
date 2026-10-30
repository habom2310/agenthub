import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess, { spawnSync } from 'node:child_process';
import { ensureDir, isJunctionOrSymlink, safeWriteFile } from '../utils/fs.js';
import { getHomeDir, getHubDir } from './detector.js';
import { finalizeInstall, vendorCheckedOutSkill } from './installer.js';
import { linkSkillsForAllAssistants } from './linker.js';
import { loadManifest, setDeclaredSource } from './manifest.js';
import { parseSourceSpec } from './sources.js';
import { syncMcpServers } from './mcp-sync.js';
import { projectAll } from './projector.js';
import {
  analyzePackage,
  findMcpConfigFile,
  parseMcpServers,
  type PackageAnalysisReport,
} from './security.js';

export interface AddPackageOptions {
  rulesOnly?: boolean;
  skills?: string[];
  homeDir?: string;
  hubDir?: string;
}

export interface AddPackageResult {
  success: boolean;
  identifier: string;
  installedRules: boolean;
  installedSkills: string[];
  mergedMcpServers: string[];
  warnings: string[];
  report: PackageAnalysisReport;
  message: string;
}

export function sanitizeIdentifier(raw: string): string {
  return (
    raw
      .trim()
      .replace(/[^\w.-]/g, '-')
      .replace(/^-+|-+$/g, '') || 'package'
  );
}

/**
 * Resolves a package target (local directory or remote git repo) to a local filesystem directory.
 * Returns the resolved directory path, package identifier, and a cleanup callback.
 */
/** Removes user:password@ from an http(s) URL so it can be recorded safely. */
function stripUserinfo(target: string): { url: string; removed: boolean } {
  try {
    const u = new URL(target);
    if (!u.username && !u.password) return { url: target, removed: false };
    u.username = '';
    u.password = '';
    return { url: u.toString(), removed: true };
  } catch {
    return { url: target, removed: false }; // scp-style git@host:path has no password
  }
}

export interface RemoteInfo {
  /** "github:owner/repo" or "git:<url>", without credentials */
  source: string;
  commit: string;
  warnings: string[];
}

export function resolvePackageTarget(target: string): {
  dir: string;
  identifier: string;
  cleanup: () => void;
  remote?: RemoteInfo;
} {
  // If target is an existing local directory
  if (fs.existsSync(target)) {
    try {
      if (fs.statSync(target).isDirectory()) {
        const resolved = path.resolve(target);
        const id = sanitizeIdentifier(path.basename(resolved));
        return {
          dir: resolved,
          identifier: id,
          cleanup: () => {},
        };
      }
    } catch {
      // Continue to git resolution if stat fails
    }
  }

  let url: string;
  let identifier: string;
  let source: string;
  const warnings: string[] = [];
  const stripped = stripUserinfo(target);

  const ownerRepoMatch = target.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/);
  if (ownerRepoMatch) {
    const owner = ownerRepoMatch[1];
    const repo = ownerRepoMatch[2];
    url = `https://github.com/${owner}/${repo}.git`;
    identifier = sanitizeIdentifier(`${owner}-${repo}`);
    source = `github:${owner}/${repo}`;
  } else if (
    target.startsWith('https://') ||
    target.startsWith('http://') ||
    target.startsWith('git@')
  ) {
    if (target.includes('#')) throw new Error(`Target URL must not contain "#": ${target.replace(/\/\/[^@/]*@/, '//***@')}`);
    url = target;
    const cleanUrl = target.replace(/\/+$/, '').replace(/\.git$/, '');
    const lastSegment = cleanUrl.split(/[/:]/).pop() || 'package';
    identifier = sanitizeIdentifier(lastSegment);
    const gh = target.match(/^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
    source = gh ? `github:${gh[1]}/${gh[2]}` : `git:${stripped.url}`;
    if (stripped.removed && !gh) {
      warnings.push('Credentials in the URL were not recorded in agenthub.json; git will need its own credentials on other machines.');
    }
  } else {
    throw new Error(
      `Target "${target}" is not an existing local directory, GitHub shorthand (owner/repo), or git URL.`
    );
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-fetch-'));
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  const cloneRes = childProcess.spawnSync('git', ['clone', '--depth', '1', url, tempDir], {
    encoding: 'utf-8',
    windowsHide: true,
  });

  if (cloneRes.error) {
    cleanup();
    throw new Error(`Git clone failed for ${url}: ${cloneRes.error.message}`);
  }

  if (cloneRes.status !== 0) {
    cleanup();
    const errMsg =
      cloneRes.stderr?.trim() || cloneRes.stdout?.trim() || `Exit code ${cloneRes.status}`;
    throw new Error(`Git clone failed for ${url}: ${errMsg}`);
  }

  const headRes = childProcess.spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: tempDir,
    encoding: 'utf-8',
    windowsHide: true,
  });
  const commit = headRes.status === 0 ? headRes.stdout.trim() : '';
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    cleanup();
    throw new Error(`Could not determine the commit of ${url}`);
  }

  return {
    dir: tempDir,
    identifier,
    cleanup,
    remote: { source, commit, warnings },
  };
}

/**
 * Inspects a target package without modifying the hub configuration.
 */
export function packageInfo(target: string): PackageAnalysisReport {
  const { dir, identifier, cleanup } = resolvePackageTarget(target);
  try {
    return analyzePackage(dir, identifier);
  } finally {
    cleanup();
  }
}

/**
 * Installs a package into the hub, including addon rules, skills, and MCP servers.
 */
export function packageAdd(target: string, options?: AddPackageOptions): AddPackageResult {
  const { dir, identifier, cleanup, remote } = resolvePackageTarget(target);
  try {
    const report = analyzePackage(dir, identifier);
    const hub = options?.hubDir || getHubDir();
    const home = options?.homeDir || getHomeDir();

    let installedRules = false;
    const installedSkills: string[] = [];
    const mergedMcpServers: string[] = [];
    const warnings: string[] = [...(remote?.warnings ?? [])];

    // 1. Rule Installation
    let ruleContent: string | null = null;
    const rulesDir = path.join(dir, 'rules');
    const commonMd = path.join(rulesDir, 'common.md');
    const rootRulesMd = path.join(dir, 'rules.md');

    if (fs.existsSync(commonMd) && fs.statSync(commonMd).isFile()) {
      ruleContent = fs.readFileSync(commonMd, 'utf-8');
    } else if (fs.existsSync(rulesDir) && fs.statSync(rulesDir).isDirectory()) {
      const files = fs
        .readdirSync(rulesDir)
        .filter((f) => f.endsWith('.md'))
        .filter((f) => {
          const full = path.join(rulesDir, f);
          return fs.statSync(full).isFile();
        })
        .sort();
      if (files.length > 0) {
        const parts = files.map((f) => fs.readFileSync(path.join(rulesDir, f), 'utf-8').trim());
        ruleContent = parts.join('\n\n');
      }
    } else if (fs.existsSync(rootRulesMd) && fs.statSync(rootRulesMd).isFile()) {
      ruleContent = fs.readFileSync(rootRulesMd, 'utf-8');
    }

    if (ruleContent !== null) {
      const addonDest = path.join(hub, 'rules', 'addons', `${identifier}.md`);
      safeWriteFile(addonDest, ruleContent.trim() + '\n');
      installedRules = true;
    }

    // 2. Skills Installation (unless rulesOnly)
    if (!options?.rulesOnly) {
      const skillsDir = path.join(dir, 'skills');
      if (fs.existsSync(skillsDir) && fs.statSync(skillsDir).isDirectory()) {
        const hubSkillsDir = path.join(hub, 'skills');
        ensureDir(hubSkillsDir);
        const entries = fs
          .readdirSync(skillsDir)
          .sort()
          .filter((entry) => fs.statSync(path.join(skillsDir, entry)).isDirectory())
          .filter((entry) => !options?.skills?.length || options.skills.includes(entry));

        // Check every skill before changing anything: names must be valid, a vendored skill is
        // linked into skills/ so it must not shadow a real folder, and a declared skill is not
        // silently replaced by a different kind of source.
        const declared = loadManifest(hub)?.skills ?? {};
        for (const entry of entries) {
          parseSourceSpec('skills', entry, 'local');
          const existing = path.join(hubSkillsDir, entry);
          if (remote && fs.existsSync(existing) && !isJunctionOrSymlink(existing)) {
            throw new Error(
              `Skill "${entry}" already exists in the hub as a local folder. Remove skills/${entry} first.`
            );
          }
          const prev = declared[entry];
          const prevSource = typeof prev === 'string' || prev === undefined ? prev : prev.source ?? 'custom';
          if (!remote && prevSource !== undefined && prevSource !== 'local') {
            throw new Error(
              `Skill "${entry}" is already declared as "${prevSource}" in agenthub.json. Remove that declaration first.`
            );
          }
        }

        for (const entry of entries) {
          const srcSkill = path.join(skillsDir, entry);
          if (remote) {
            const spec = `${remote.source}#skills/${entry}`;
            vendorCheckedOutSkill(hub, entry, spec, remote.commit, srcSkill);
          } else {
            const destSkill = path.join(hubSkillsDir, entry);
            // Re-adding over a vendored skill replaces its link, not the vendored files
            if (isJunctionOrSymlink(destSkill)) fs.unlinkSync(destSkill);
            fs.cpSync(srcSkill, destSkill, { recursive: true });
            setDeclaredSource(hub, 'skills', entry, 'local');
          }
          installedSkills.push(entry);
        }
        if (remote && installedSkills.length > 0) finalizeInstall(hub);
      }
    }

    // 3. MCP Servers Merge (unless rulesOnly)
    if (!options?.rulesOnly) {
      const mcpConfigFile = findMcpConfigFile(dir);
      if (mcpConfigFile) {
        const { servers } = parseMcpServers(mcpConfigFile);
        const serverEntries = Object.entries(servers);
        if (serverEntries.length > 0) {
          const hubMcpFile = path.join(hub, 'mcp', 'servers.json');
          let hubMcpData: { mcpServers: Record<string, any>; [key: string]: any } = {
            mcpServers: {},
          };
          if (fs.existsSync(hubMcpFile)) {
            try {
              const raw = fs.readFileSync(hubMcpFile, 'utf-8');
              const parsed = JSON.parse(raw);
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                hubMcpData = parsed;
                if (
                  !hubMcpData.mcpServers ||
                  typeof hubMcpData.mcpServers !== 'object' ||
                  Array.isArray(hubMcpData.mcpServers)
                ) {
                  hubMcpData.mcpServers = {};
                }
              }
            } catch {
              hubMcpData = { mcpServers: {} };
            }
          }
          for (const [sName, sCfg] of serverEntries) {
            hubMcpData.mcpServers[sName] = sCfg;
            mergedMcpServers.push(sName);
          }
          safeWriteFile(hubMcpFile, JSON.stringify(hubMcpData, null, 2) + '\n');
        }
      }
    }

    // 4. Reproject & Link
    projectAll({ homeDir: home, hubDir: hub });
    linkSkillsForAllAssistants({ homeDir: home, hubDir: hub });
    if (mergedMcpServers.length > 0) {
      syncMcpServers({ homeDir: home, hubDir: hub });
    }

    const message = `Package "${identifier}" installed successfully. Rules: ${
      installedRules ? 'yes' : 'none'
    }, Skills: ${installedSkills.length}, MCP servers: ${mergedMcpServers.length}.`;

    return {
      success: true,
      identifier,
      installedRules,
      installedSkills,
      mergedMcpServers,
      warnings,
      report,
      message,
    };
  } finally {
    cleanup();
  }
}
