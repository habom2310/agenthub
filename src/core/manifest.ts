import fs from 'node:fs';
import path from 'node:path';
import { safeWriteFile } from '../utils/fs.js';

export interface AgentPackageManifest {
  $schema?: string;
  name: string;
  version?: string;
  description?: string;
  type?: 'profile' | 'addon';
  platforms?: string[];
  tags?: string[];
  license?: string;
  dependencies?: Record<string, string>;
  token_budget?: {
    estimated_boot_tokens?: number;
    target_limit?: number;
  };
}

export const DEFAULT_PLATFORMS = ['gemini', 'claude', 'codex', 'cursor', 'windsurf'];

function extractDescription(readmePath: string): string {
  try {
    if (!fs.existsSync(readmePath) || !fs.statSync(readmePath).isFile()) {
      return '';
    }
    const content = fs.readFileSync(readmePath, 'utf-8');
    // Strip YAML frontmatter if present
    const stripped = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
    const lines = stripped.split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith('#')) continue;
      return line;
    }
  } catch {
    return '';
  }
  return '';
}

function inferPlatforms(dir: string): string[] {
  const overridesDir = path.join(dir, 'rules', 'overrides');
  try {
    if (fs.existsSync(overridesDir) && fs.statSync(overridesDir).isDirectory()) {
      const files = fs
        .readdirSync(overridesDir)
        .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
        .sort();
      if (files.length > 0) {
        const platforms = new Set<string>();
        for (const file of files) {
          const base = path.basename(file, '.md').toLowerCase();
          platforms.add(base === 'agy' ? 'gemini' : base);
        }
        return Array.from(platforms);
      }
    }
  } catch {
    // fallback to default platforms
  }
  return [...DEFAULT_PLATFORMS];
}

/**
 * Reads agenthub.json in the specified directory.
 * Returns parsed manifest or null if absent or invalid.
 */
export function loadManifest(dir: string): AgentPackageManifest | null {
  const manifestPath = path.join(dir, 'agenthub.json');
  try {
    if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) {
      return null;
    }
    const content = fs.readFileSync(manifestPath, 'utf-8');
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as AgentPackageManifest;
  } catch {
    return null;
  }
}

/**
 * Convention-over-configuration inference when agenthub.json is absent.
 */
export function inferManifest(dir: string, fallbackName?: string): AgentPackageManifest {
  const name = fallbackName || path.basename(path.resolve(dir));
  const description = extractDescription(path.join(dir, 'README.md'));
  const type: 'profile' | 'addon' = fs.existsSync(path.join(dir, 'rules', 'common.md'))
    ? 'profile'
    : 'addon';
  const platforms = inferPlatforms(dir);

  return {
    name,
    description,
    type,
    platforms,
    tags: [],
  };
}

/**
 * Returns loaded manifest if agenthub.json exists, otherwise inferred manifest.
 */
export function getEffectiveManifest(dir: string, fallbackName?: string): AgentPackageManifest {
  const loaded = loadManifest(dir);
  if (loaded) {
    return loaded;
  }
  return inferManifest(dir, fallbackName);
}

/**
 * Writes agenthub.json using safeWriteFile formatted with 2 spaces indentation.
 */
export function writeManifest(dir: string, manifest: AgentPackageManifest): void {
  const manifestPath = path.join(dir, 'agenthub.json');
  const content = JSON.stringify(manifest, null, 2) + '\n';
  safeWriteFile(manifestPath, content);
}
