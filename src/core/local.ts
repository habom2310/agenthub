import fs from 'node:fs';
import path from 'node:path';
import { safeWriteFile } from '../utils/fs.js';

export type IgnoreKind = 'mcp' | 'skills';

/** Machine-local ignore list in hub/local.json (gitignored): names only, exact match. */
export function localPath(hub: string): string {
  return path.join(hub, 'local.json');
}

export function readIgnored(hub: string): Record<IgnoreKind, string[]> {
  const out: Record<IgnoreKind, string[]> = { mcp: [], skills: [] };
  try {
    const ignore = JSON.parse(fs.readFileSync(localPath(hub), 'utf-8'))?.ignore;
    for (const kind of ['mcp', 'skills'] as const) {
      if (Array.isArray(ignore?.[kind])) out[kind] = ignore[kind].filter((n: unknown): n is string => typeof n === 'string');
    }
  } catch {
    // missing or unparseable: nothing ignored
  }
  return out;
}

export function ignoredNames(hub: string, kind: IgnoreKind): Set<string> {
  return new Set(readIgnored(hub)[kind]);
}

/** Adds or removes names; keeps other keys of local.json. */
export function updateIgnored(hub: string, kind: IgnoreKind, names: string[], remove = false): void {
  let data: Record<string, any> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(localPath(hub), 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
  } catch {
    // start fresh
  }
  const current = readIgnored(hub);
  const next = remove ? current[kind].filter((n) => !names.includes(n)) : [...new Set([...current[kind], ...names])];
  data.ignore = { ...current, [kind]: next };
  safeWriteFile(localPath(hub), JSON.stringify(data, null, 2) + '\n');
}
