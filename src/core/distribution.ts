import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess, { spawnSync } from 'node:child_process';
import { ensureDir, isJunctionOrSymlink, safeWriteFile } from '../utils/fs.js';
import { getHomeDir, getHubDir } from './detector.js';
import { checkSubpath, copyable, finalizeInstall, vendorCheckedOutSkill } from './installer.js';
import { linkSkillsForAllAssistants } from './linker.js';
import { loadManifest, setDeclaredSource } from './manifest.js';
import { findSkills, selectSkills, type DiscoveredSkill } from './skill-discovery.js';
import { TREE_REF_HINT, isUrlTarget, parseRemoteTarget, validRef } from './source-url.js';
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
  /** Branch, tag or commit of a remote target */
  ref?: string;
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

/** Removes credentials from URLs in an error message. */
const redactUrls = (text: string): string => text.replace(/(\w+:\/\/)[^@/\s]*@/g, '$1***@');

export interface RemoteInfo {
  /** "github:owner/repo" or "git:<url>", without credentials */
  source: string;
  commit: string;
  warnings: string[];
  /** Branch, tag or commit the target asked for */
  ref?: string;
  /** Folder inside the repo the target pointed at (the returned dir is that folder) */
  subpath?: string;
  /** owner/repo@skill: install only this skill */
  skill?: string;
}

function git(args: string[], cwd?: string): ReturnType<typeof childProcess.spawnSync> {
  return childProcess.spawnSync('git', args, { cwd, encoding: 'utf-8', windowsHide: true });
}

/**
 * Resolves a package target (local directory or remote git repo) to a local filesystem directory.
 * Returns the resolved directory path, package identifier, and a cleanup callback.
 * Remote targets: owner/repo[#ref][@skill], GitHub/GitLab/Azure Repos URLs (with ref and
 * path), or any https/ssh/git URL. For a URL that points into the repo, dir is that folder.
 */
export function resolvePackageTarget(target: string, options: { ref?: string } = {}): {
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

  const spec = parseRemoteTarget(target);
  if (!spec) {
    throw new Error(
      `Target "${target}" is not an existing local directory, GitHub shorthand (owner/repo), or git URL.`
    );
  }
  if (options.ref !== undefined) {
    if (!validRef(options.ref)) throw new Error(`Invalid --ref "${options.ref}"`);
    if (spec.ref !== undefined && spec.ref !== options.ref) throw new Error(`--ref ${options.ref} conflicts with the ref in the URL (${spec.ref})`);
    spec.ref = options.ref;
  }
  const treeHint = (message: string): string => (spec.fromTree ? `${message} (${TREE_REF_HINT})` : message);
  const url = spec.cloneUrl;
  const shorthand = spec.source.match(/^github:([\w.-]+)\/([\w.-]+)$/);
  const identifier = isUrlTarget(target)
    ? sanitizeIdentifier(url.replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).pop() || 'package')
    : sanitizeIdentifier(`${shorthand?.[1]}-${shorthand?.[2]}`);

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
  const fail = (message: string): never => {
    cleanup();
    throw new Error(redactUrls(message));
  };

  const byCommit = spec.ref !== undefined && /^[0-9a-f]{40}$/i.test(spec.ref);
  const cloneRes = git(['clone', ...(byCommit ? [] : ['--depth', '1']), ...(spec.ref && !byCommit ? ['--branch', spec.ref] : []), url, tempDir]);

  if (cloneRes.error) fail(`Git clone failed for ${url}: ${cloneRes.error.message}`);
  if (cloneRes.status !== 0) {
    const errMsg = String(cloneRes.stderr || '').trim() || String(cloneRes.stdout || '').trim() || `Exit code ${cloneRes.status}`;
    fail(treeHint(`Git clone failed for ${url}: ${errMsg}`));
  }
  if (byCommit) {
    const co = git(['checkout', '-q', '--detach', spec.ref as string], tempDir);
    if (co.error || co.status !== 0) fail(`Git checkout of ${spec.ref} failed for ${url}: ${String(co.stderr || '').trim()}`);
  }

  const headRes = git(['rev-parse', 'HEAD'], tempDir);
  const commit = headRes.status === 0 ? String(headRes.stdout).trim() : '';
  if (!/^[0-9a-f]{40}$/.test(commit)) fail(`Could not determine the commit of ${url}`);

  try {
    checkSubpath(tempDir, spec.subpath, url);
  } catch (err) {
    cleanup();
    throw new Error(treeHint((err as Error).message));
  }

  const remote: RemoteInfo = { source: spec.source, commit, warnings: spec.warnings };
  if (spec.ref !== undefined) remote.ref = spec.ref;
  if (spec.subpath !== undefined) remote.subpath = spec.subpath;
  if (spec.skill !== undefined) remote.skill = spec.skill;
  return {
    dir: spec.subpath ? path.join(tempDir, spec.subpath) : tempDir,
    identifier,
    cleanup,
    remote,
  };
}

/** The skills a target offers (what `agenthub add <target> --list` prints); installs nothing. */
export function listPackageSkills(target: string, ref?: string): { identifier: string; skills: DiscoveredSkill[]; warnings: string[] } {
  const { dir, identifier, cleanup, remote } = resolvePackageTarget(target, { ref });
  try {
    const found = findSkills(dir, { scanRoot: Boolean(remote?.subpath), rootName: remote && !remote.subpath ? identifier : undefined });
    // paths as they are in the repo, not relative to the folder a URL pointed at
    const inRepo = (rel: string): string => [remote?.subpath, rel].filter(Boolean).join('/');
    return {
      identifier,
      skills: found.skills.map((s) => ({ ...s, rel: inRepo(s.rel) })),
      warnings: [...found.warnings, ...(remote?.warnings ?? [])],
    };
  } finally {
    cleanup();
  }
}

/**
 * Inspects a target package without modifying the hub configuration.
 */
export function packageInfo(target: string, ref?: string): PackageAnalysisReport {
  const { dir, identifier, cleanup } = resolvePackageTarget(target, { ref });
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
  const { dir, identifier, cleanup, remote } = resolvePackageTarget(target, { ref: options?.ref });
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
      const wanted = [...(options?.skills ?? []), ...(remote?.skill ? [remote.skill] : [])];
      const found = findSkills(dir, { scanRoot: Boolean(remote?.subpath), rootName: remote && !remote.subpath ? identifier : undefined });
      warnings.push(...found.warnings);
      const entries = selectSkills(found.skills, wanted);
      if (entries.length > 0) {
        const hubSkillsDir = path.join(hub, 'skills');
        ensureDir(hubSkillsDir);
        // Check every skill before changing anything: names must be valid, a vendored skill is
        // linked into skills/ so it must not shadow a real folder, and a declared skill is not
        // silently replaced by a different kind of source.
        const declared = loadManifest(hub)?.skills ?? {};
        for (const { name: entry } of entries) {
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

        for (const { name: entry, dir: srcSkill, rel } of entries) {
          if (remote) {
            const sub = [remote.subpath, rel].filter(Boolean).join('/');
            const source = remote.source + (sub ? `#${sub}` : '');
            vendorCheckedOutSkill(hub, entry, remote.ref ? { source, ref: remote.ref } : source, remote.commit, srcSkill);
          } else {
            const destSkill = path.join(hubSkillsDir, entry);
            // Re-adding over a vendored skill replaces its link, not the vendored files
            if (isJunctionOrSymlink(destSkill)) fs.unlinkSync(destSkill);
            fs.cpSync(srcSkill, destSkill, { recursive: true, filter: copyable });
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
