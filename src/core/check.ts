import fs from 'node:fs';
import path from 'node:path';
import { getHubDir } from './detector.js';
import { itemLabel, localBuildHash, modifiedLocally } from './installer.js';
import { ignoredNames } from './local.js';
import { isLocalBuild, isPinned, loadDeclaredSources, loadLock, pinOf, resolvePin, sameSource } from './sources.js';

export interface CheckFinding {
  item: string;
  status: 'current' | 'outdated' | 'modified' | 'error';
  message: string;
}

export interface CheckResult {
  findings: CheckFinding[];
  /** True when anything is outdated, modified locally or could not be checked */
  dirty: boolean;
}

const short = (v: string | undefined): string => (v ? v.slice(0, 12) : 'unpinned');

/**
 * Compares the lockfile with the latest pins of the declared sources (git ls-remote,
 * npm view, PyPI) and the vendored skill folders with their locked hash.
 * Installs and writes nothing, and runs no command the hub declares.
 */
export async function checkSources(hubDir?: string): Promise<CheckResult> {
  const hub = hubDir || getHubDir();
  const { sources } = loadDeclaredSources(hub);
  const lock = loadLock(hub);
  const ignoredSkills = ignoredNames(hub, 'skills');
  const findings: CheckFinding[] = [];

  for (const decl of sources) {
    if (decl.kind === 'skills' && ignoredSkills.has(decl.name)) continue;
    const item = itemLabel(decl.kind, decl.name);
    const prev = lock[decl.kind][decl.name];
    try {
      if (isLocalBuild(decl)) {
        if (!fs.existsSync(path.join(hub, 'mcp', 'servers', decl.name))) {
          findings.push({ item, status: 'error', message: `declared "local" but mcp/servers/${decl.name}/ does not exist` });
          continue;
        }
        const now = localBuildHash(hub, decl.name);
        findings.push(
          prev?.hash === now
            ? { item, status: 'current', message: 'local build sources match the lock' }
            : { item, status: 'outdated', message: 'local build sources differ from the lock (run: agenthub install)' }
        );
        continue;
      }
      if (!isPinned(decl)) continue;
      const next = await resolvePin(decl);
      const modified = Boolean(prev) && modifiedLocally(hub, decl, prev);
      if (!prev || !sameSource(prev.source, decl.spec) || pinOf(prev) === undefined) {
        findings.push({ item, status: 'outdated', message: `not locked, latest is ${short(pinOf(next))}` });
      } else if (pinOf(prev) !== pinOf(next)) {
        findings.push({ item, status: 'outdated', message: `${short(pinOf(prev))} -> ${short(pinOf(next))}` });
      } else if (!modified) {
        findings.push({ item, status: 'current', message: `up to date @ ${short(pinOf(next))}` });
      }
      if (modified) {
        findings.push({ item, status: 'modified', message: `modified locally (differs from the locked hash ${short(prev?.hash)})` });
      }
    } catch (err) {
      findings.push({ item, status: 'error', message: (err as Error).message });
    }
  }
  return { findings, dirty: findings.some((f) => f.status !== 'current') };
}
