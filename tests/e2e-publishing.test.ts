import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildPackagePayload,
  publishToRegistry,
  type RegistryPackageSummary,
} from '../src/core/registry.js';
import { ensureDir, safeWriteFile } from '../src/utils/fs.js';

describe('E2E Publishing Pipeline', () => {
  let sandboxDir: string;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-e2e-publishing-'));

    // 1. agenthub.json
    safeWriteFile(
      path.join(sandboxDir, 'agenthub.json'),
      JSON.stringify(
        {
          name: 'test-agent',
          version: '1.0.0',
          description: 'E2E publishing test agent',
          type: 'profile',
          platforms: ['gemini', 'claude', 'cursor'],
          tags: ['test', 'e2e'],
          license: 'MIT',
        },
        null,
        2
      )
    );

    // 2. README.md
    safeWriteFile(
      path.join(sandboxDir, 'README.md'),
      '# Test Agent\n\nProfile for end-to-end publishing test.'
    );

    // 3. rules/common.md
    safeWriteFile(
      path.join(sandboxDir, 'rules', 'common.md'),
      '# Core Test Rules\n\n1. Always test thoroughly.\n2. Keep changes minimal.'
    );

    // 4. rules/addons/sample.md
    safeWriteFile(
      path.join(sandboxDir, 'rules', 'addons', 'sample.md'),
      '---\ntitle: Sample Addon Rule\n---\n\nSpecific guidelines for addon handling.'
    );

    // 5. dotfile to ensure dotfiles are skipped
    safeWriteFile(
      path.join(sandboxDir, 'rules', '.hidden-rule.md'),
      '# Hidden Rule\n\nThis should be ignored by walkRules.'
    );

    // 6. skills/test-skill/SKILL.md
    const skillDir = path.join(sandboxDir, 'skills', 'test-skill');
    ensureDir(skillDir);
    safeWriteFile(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: test-skill\ndescription: Test skill for publishing\n---\n\nTest skill instructions.'
    );
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    try {
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    } catch {}
  });

  it('builds package payload with rulesAst, security assessment, tokenFootprint, and skills', () => {
    const payload = buildPackagePayload(sandboxDir, {
      repoShorthand: 'tester/test-agent',
    });

    expect(payload.owner).toBe('tester');
    expect(payload.repo).toBe('test-agent');
    expect(payload.name).toBe('test-agent');
    expect(payload.version).toBe('1.0.0');
    expect(payload.description).toBe('E2E publishing test agent');
    expect(payload.type).toBe('profile');
    expect(payload.platforms).toEqual(['gemini', 'claude', 'cursor']);
    expect(payload.tags).toEqual(['test', 'e2e']);
    expect(payload.license).toBe('MIT');
    expect(payload.readme).toContain('# Test Agent');

    // Verify rulesAst
    expect(Array.isArray(payload.rulesAst)).toBe(true);
    const rules = payload.rulesAst as Array<{
      title: string;
      file: string;
      tokens: number;
      content: string;
    }>;
    expect(rules).toHaveLength(2);

    // Verify dotfiles are ignored
    const hidden = rules.find((r) => r.file.includes('.hidden-rule.md'));
    expect(hidden).toBeUndefined();

    // Verify common rule
    const commonRule = rules.find((r) => r.file === 'rules/common.md');
    expect(commonRule).toBeDefined();
    expect(commonRule?.title).toBe('Core Test Rules');
    expect(commonRule?.content).toContain('Always test thoroughly.');
    expect(commonRule?.tokens).toBeGreaterThan(0);

    // Verify addon rule
    const addonRule = rules.find((r) => r.file === 'rules/addons/sample.md');
    expect(addonRule).toBeDefined();
    expect(addonRule?.title).toBe('Sample Addon Rule');
    expect(addonRule?.content).toContain('Specific guidelines for addon handling.');
    expect(addonRule?.tokens).toBeGreaterThan(0);

    // Verify skills
    expect(Array.isArray(payload.skills)).toBe(true);
    const skills = payload.skills as Array<{
      name: string;
      description: string;
      path: string;
    }>;
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('test-skill');
    expect(skills[0].path).toBe('skills/test-skill');

    // Verify security risk and cleanliness
    expect(payload.securityRisk).toBe('low');
    expect(payload.isClean).toBe(true);

    // Verify token footprint accounts for rulesTokens
    const rulesTokens = rules.reduce((acc, r) => acc + r.tokens, 0);
    expect(typeof payload.tokenFootprint).toBe('number');
    expect(payload.tokenFootprint as number).toBeGreaterThanOrEqual(rulesTokens);
    expect(payload.tokenFootprint as number).toBeGreaterThan(0);
  });

  it('publishes package payload to registry endpoint and confirms request format and indexing', async () => {
    const payload = buildPackagePayload(sandboxDir, {
      repoShorthand: 'tester/test-agent',
    });

    const mockIndexedPackage: RegistryPackageSummary = {
      id: 'tester/test-agent',
      owner: 'tester',
      repo: 'test-agent',
      name: 'test-agent',
      version: '1.0.0',
      description: 'E2E publishing test agent',
      type: 'profile',
      platforms: ['gemini', 'claude', 'cursor'],
      tags: ['test', 'e2e'],
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        message: 'Package indexed successfully',
        package: mockIndexedPackage,
      }),
    } as Response);

    const result = await publishToRegistry(payload, {
      registryUrl: 'https://registry.example.com',
    });

    expect(result.success).toBe(true);
    expect(result.package).toEqual(mockIndexedPackage);

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = (globalThis.fetch as any).mock.calls[0];
    expect(calledUrl).toBe('https://registry.example.com/api/index');
    expect(calledInit.method).toBe('POST');
    expect(calledInit.headers['Content-Type']).toBe('application/json');
    expect(calledInit.headers.Accept).toBe('application/json');

    const sentBody = JSON.parse(calledInit.body);
    expect(sentBody.owner).toBe('tester');
    expect(sentBody.repo).toBe('test-agent');
    expect(sentBody.name).toBe('test-agent');
    expect(sentBody.rulesAst).toHaveLength(2);
    expect(sentBody.skills).toHaveLength(1);
    expect(sentBody.securityRisk).toBe('low');
    expect(sentBody.isClean).toBe(true);
    expect(sentBody.tokenFootprint).toBeGreaterThan(0);
  });
});
