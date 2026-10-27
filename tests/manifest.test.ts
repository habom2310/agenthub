import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PLATFORMS,
  getEffectiveManifest,
  inferManifest,
  loadManifest,
  writeManifest,
  type AgentPackageManifest,
} from '../src/core/manifest.js';
import { ensureDir, safeWriteFile } from '../src/utils/fs.js';

describe('manifest', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-manifest-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe('loadManifest', () => {
    it('returns null when agenthub.json does not exist', () => {
      const manifest = loadManifest(tmpDir);
      expect(manifest).toBeNull();
    });

    it('returns null when agenthub.json is a directory', () => {
      fs.mkdirSync(path.join(tmpDir, 'agenthub.json'));
      expect(loadManifest(tmpDir)).toBeNull();
    });

    it('returns null when agenthub.json is invalid JSON', () => {
      safeWriteFile(path.join(tmpDir, 'agenthub.json'), '{ invalid json');
      expect(loadManifest(tmpDir)).toBeNull();
    });

    it('returns null when agenthub.json parses to a non-object', () => {
      safeWriteFile(path.join(tmpDir, 'agenthub.json'), '["item1", "item2"]');
      expect(loadManifest(tmpDir)).toBeNull();

      safeWriteFile(path.join(tmpDir, 'agenthub.json'), '"string value"');
      expect(loadManifest(tmpDir)).toBeNull();
    });

    it('returns parsed manifest when agenthub.json is valid', () => {
      const valid: AgentPackageManifest = {
        name: 'test-package',
        version: '1.2.0',
        description: 'A test agent setup',
        type: 'profile',
        platforms: ['gemini', 'claude'],
        tags: ['web', 'react'],
        license: 'MIT',
        dependencies: {
          'other/setup': '^1.0.0',
        },
        token_budget: {
          estimated_boot_tokens: 1200,
          target_limit: 2000,
        },
      };

      safeWriteFile(path.join(tmpDir, 'agenthub.json'), JSON.stringify(valid, null, 2));

      const loaded = loadManifest(tmpDir);
      expect(loaded).toEqual(valid);
    });
  });

  describe('inferManifest', () => {
    it('infers name from folder basename when fallbackName is omitted', () => {
      const inferred = inferManifest(tmpDir);
      expect(inferred.name).toBe(path.basename(tmpDir));
    });

    it('uses fallbackName when provided', () => {
      const inferred = inferManifest(tmpDir, 'my-custom-addon');
      expect(inferred.name).toBe('my-custom-addon');
    });

    it('infers type as profile when rules/common.md exists', () => {
      safeWriteFile(path.join(tmpDir, 'rules', 'common.md'), '# Common Rules');
      const inferred = inferManifest(tmpDir);
      expect(inferred.type).toBe('profile');
    });

    it('infers type as addon when rules/common.md is absent', () => {
      const inferred = inferManifest(tmpDir);
      expect(inferred.type).toBe('addon');
    });

    it('extracts description from first non-header non-empty line of README.md', () => {
      const readme = `# Title Header
## Subtitle
This is the real description of the agent.

More details here.`;
      safeWriteFile(path.join(tmpDir, 'README.md'), readme);

      const inferred = inferManifest(tmpDir);
      expect(inferred.description).toBe('This is the real description of the agent.');
    });

    it('ignores YAML frontmatter when extracting description from README.md', () => {
      const readme = `---
title: Doc Title
version: 1.0.0
---
# Main Header

A modular security scanner addon for AI agents.
`;
      safeWriteFile(path.join(tmpDir, 'README.md'), readme);

      const inferred = inferManifest(tmpDir);
      expect(inferred.description).toBe('A modular security scanner addon for AI agents.');
    });

    it('returns empty string description when README.md is absent or only has headers', () => {
      const inferred1 = inferManifest(tmpDir);
      expect(inferred1.description).toBe('');

      safeWriteFile(path.join(tmpDir, 'README.md'), '# Header Only\n\n## Subheader\n');
      const inferred2 = inferManifest(tmpDir);
      expect(inferred2.description).toBe('');
    });

    it('defaults platforms when rules/overrides/ is absent', () => {
      const inferred = inferManifest(tmpDir);
      expect(inferred.platforms).toEqual(DEFAULT_PLATFORMS);
    });

    it('defaults platforms when rules/overrides/ exists but is empty', () => {
      ensureDir(path.join(tmpDir, 'rules', 'overrides'));
      const inferred = inferManifest(tmpDir);
      expect(inferred.platforms).toEqual(DEFAULT_PLATFORMS);
    });

    it('detects platforms from rules/overrides/ files and maps agy to gemini', () => {
      safeWriteFile(path.join(tmpDir, 'rules', 'overrides', 'agy.md'), '# AGY override');
      safeWriteFile(path.join(tmpDir, 'rules', 'overrides', 'claude.md'), '# Claude override');
      safeWriteFile(path.join(tmpDir, 'rules', 'overrides', 'cursor.md'), '# Cursor override');

      const inferred = inferManifest(tmpDir);
      expect(inferred.platforms).toEqual(['gemini', 'claude', 'cursor']);
    });

    it('initializes tags to empty array', () => {
      const inferred = inferManifest(tmpDir);
      expect(inferred.tags).toEqual([]);
    });
  });

  describe('getEffectiveManifest', () => {
    it('returns loaded manifest if agenthub.json exists', () => {
      const explicit: AgentPackageManifest = {
        name: 'explicit-package',
        type: 'profile',
        description: 'From manifest',
      };
      safeWriteFile(path.join(tmpDir, 'agenthub.json'), JSON.stringify(explicit));

      const res = getEffectiveManifest(tmpDir, 'fallback-name');
      expect(res.name).toBe('explicit-package');
      expect(res.description).toBe('From manifest');
    });

    it('returns inferred manifest if agenthub.json is missing', () => {
      safeWriteFile(path.join(tmpDir, 'README.md'), '# Title\n\nInferred description');
      const res = getEffectiveManifest(tmpDir, 'fallback-name');
      expect(res.name).toBe('fallback-name');
      expect(res.description).toBe('Inferred description');
      expect(res.type).toBe('addon');
    });
  });

  describe('writeManifest', () => {
    it('writes formatted agenthub.json with 2-space indentation', () => {
      const manifest: AgentPackageManifest = {
        $schema: 'https://agenthub.dev/schema/v1.json',
        name: 'fullstack-starter',
        version: '1.0.0',
        type: 'profile',
        platforms: ['gemini', 'claude', 'cursor'],
        tags: ['starter', 'fullstack'],
      };

      writeManifest(tmpDir, manifest);

      const filePath = path.join(tmpDir, 'agenthub.json');
      expect(fs.existsSync(filePath)).toBe(true);

      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toBe(JSON.stringify(manifest, null, 2) + '\n');

      const reloaded = loadManifest(tmpDir);
      expect(reloaded).toEqual(manifest);
    });
  });
});
