import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_REGISTRY_URL,
  getDefaultRegistryUrl,
  searchRegistry,
  publishToRegistry,
  buildPackagePayload,
  type RegistryPackageSummary,
} from '../src/core/registry.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureDir, safeWriteFile } from '../src/utils/fs.js';

describe('Registry Core Module', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.AGENTHUB_REGISTRY_URL;
  const originalToken = process.env.AGENTHUB_TOKEN;
  const originalSecret = process.env.AGENTHUB_PUBLISH_SECRET;

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.AGENTHUB_REGISTRY_URL;
    delete process.env.AGENTHUB_TOKEN;
    delete process.env.AGENTHUB_PUBLISH_SECRET;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalEnv !== undefined) {
      process.env.AGENTHUB_REGISTRY_URL = originalEnv;
    } else {
      delete process.env.AGENTHUB_REGISTRY_URL;
    }
    if (originalToken !== undefined) {
      process.env.AGENTHUB_TOKEN = originalToken;
    } else {
      delete process.env.AGENTHUB_TOKEN;
    }
    if (originalSecret !== undefined) {
      process.env.AGENTHUB_PUBLISH_SECRET = originalSecret;
    } else {
      delete process.env.AGENTHUB_PUBLISH_SECRET;
    }
  });

  describe('getDefaultRegistryUrl', () => {
    it('returns default URL when environment variable is not set', () => {
      expect(getDefaultRegistryUrl()).toBe('https://agenthub.dev');
    });

    it('returns custom URL from AGENTHUB_REGISTRY_URL when set', () => {
      process.env.AGENTHUB_REGISTRY_URL = 'https://custom.registry.dev';
      expect(getDefaultRegistryUrl()).toBe('https://custom.registry.dev');
    });
  });

  describe('searchRegistry', () => {
    it('successfully queries registry and normalizes packages', async () => {
      const mockPackages = [
        {
          id: 'alice/nextjs-agent',
          owner: 'alice',
          repo: 'nextjs-agent',
          name: 'nextjs-agent',
          version: '1.2.0',
          description: 'Next.js agent setup',
          type: 'profile',
          platforms: ['gemini', 'claude'],
          tags: ['nextjs', 'react'],
          stars: 42,
          installCount: 150,
          tokenFootprint: 850,
        },
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ total: 1, packages: mockPackages }),
      } as Response);

      const res = await searchRegistry('nextjs');

      expect(res.success).toBe(true);
      expect(res.packages).toHaveLength(1);
      const pkg = res.packages[0];
      expect(pkg.id).toBe('alice/nextjs-agent');
      expect(pkg.name).toBe('nextjs-agent');
      expect(pkg.type).toBe('profile');
      expect(pkg.tokenFootprint).toEqual({
        rulesTokens: 850,
        skillsTokens: 0,
        totalTokens: 850,
      });

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      const [calledUrl] = (globalThis.fetch as any).mock.calls[0];
      expect(calledUrl).toContain('https://agenthub.dev/api/packages');
      expect(calledUrl).toContain('q=nextjs');
    });

    it('propagates all search filter options into query parameters', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ packages: [] }),
      } as Response);

      await searchRegistry('prompting', {
        platform: 'claude',
        type: 'addon',
        tag: 'skills',
        limit: 5,
        registryUrl: 'https://staging.agenthub.dev/',
      });

      const [calledUrl] = (globalThis.fetch as any).mock.calls[0];
      const url = new URL(calledUrl);

      expect(url.origin).toBe('https://staging.agenthub.dev');
      expect(url.pathname).toBe('/api/packages');
      expect(url.searchParams.get('q')).toBe('prompting');
      expect(url.searchParams.get('platform')).toBe('claude');
      expect(url.searchParams.get('type')).toBe('addon');
      expect(url.searchParams.get('tag')).toBe('skills');
      expect(url.searchParams.get('limit')).toBe('5');
    });

    it('handles HTTP error responses (500) gracefully', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => JSON.stringify({ error: 'Database connection failed' }),
      } as Response);

      const res = await searchRegistry('test');

      expect(res.success).toBe(false);
      expect(res.packages).toEqual([]);
      expect(res.error).toBe('Database connection failed');
    });

    it('handles network failure / connection timeout', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Fetch failed: connection timeout'));

      const res = await searchRegistry('test');

      expect(res.success).toBe(false);
      expect(res.packages).toEqual([]);
      expect(res.error).toContain('Fetch failed: connection timeout');
    });
  });

  describe('publishToRegistry', () => {
    it('successfully posts package payload and returns indexed result', async () => {
      const mockResultPackage: RegistryPackageSummary = {
        id: 'alice/nextjs-agent',
        owner: 'alice',
        repo: 'nextjs-agent',
        name: 'nextjs-agent',
        version: '1.0.0',
        type: 'profile',
        platforms: ['claude'],
        tags: [],
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({
          message: 'Package indexed successfully',
          package: mockResultPackage,
        }),
      } as Response);

      const payload = {
        owner: 'alice',
        repo: 'nextjs-agent',
        name: 'nextjs-agent',
      };

      const res = await publishToRegistry(payload, {
        registryUrl: 'https://test-registry.local',
      });

      expect(res.success).toBe(true);
      expect(res.package).toEqual(mockResultPackage);

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      const [calledUrl, calledInit] = (globalThis.fetch as any).mock.calls[0];
      expect(calledUrl).toBe('https://test-registry.local/api/index');
      expect(calledInit.method).toBe('POST');
      expect(calledInit.headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(calledInit.body)).toEqual(payload);
    });

    it('handles HTTP error responses (400) on publish', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => JSON.stringify({ error: 'Missing required fields: owner, repo, and name' }),
      } as Response);

      const res = await publishToRegistry({});

      expect(res.success).toBe(false);
      expect(res.error).toBe('Missing required fields: owner, repo, and name');
    });

    it('handles network failures on publish', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network is unreachable'));

      const res = await publishToRegistry({ name: 'test' });

      expect(res.success).toBe(false);
      expect(res.error).toContain('Network is unreachable');
    });

    it('attaches Authorization: Bearer <token> when token option is present', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({
          message: 'Package indexed successfully',
          package: { id: 'alice/test' },
        }),
      } as Response);

      await publishToRegistry({ name: 'test' }, { token: 'my-custom-token' });

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      const [, calledInit] = (globalThis.fetch as any).mock.calls[0];
      expect(calledInit.headers['Authorization']).toBe('Bearer my-custom-token');
    });

    it('attaches Authorization: Bearer <token> when AGENTHUB_TOKEN env var is present', async () => {
      process.env.AGENTHUB_TOKEN = 'env-secret-token';

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({
          message: 'Package indexed successfully',
          package: { id: 'alice/test' },
        }),
      } as Response);

      await publishToRegistry({ name: 'test' });

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      const [, calledInit] = (globalThis.fetch as any).mock.calls[0];
      expect(calledInit.headers['Authorization']).toBe('Bearer env-secret-token');
    });

    it('attaches Authorization: Bearer <token> when AGENTHUB_PUBLISH_SECRET env var is present', async () => {
      process.env.AGENTHUB_PUBLISH_SECRET = 'publish-secret-token';

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({
          message: 'Package indexed successfully',
          package: { id: 'alice/test' },
        }),
      } as Response);

      await publishToRegistry({ name: 'test' });

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      const [, calledInit] = (globalThis.fetch as any).mock.calls[0];
      expect(calledInit.headers['Authorization']).toBe('Bearer publish-secret-token');
    });

    it('options.token overrides process.env.AGENTHUB_TOKEN when both are present', async () => {
      process.env.AGENTHUB_TOKEN = 'env-token';

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({
          message: 'Package indexed successfully',
          package: { id: 'alice/test' },
        }),
      } as Response);

      await publishToRegistry({ name: 'test' }, { token: 'explicit-option-token' });

      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      const [, calledInit] = (globalThis.fetch as any).mock.calls[0];
      expect(calledInit.headers['Authorization']).toBe('Bearer explicit-option-token');
    });

    it('empty or whitespace-only token does not attach Authorization header', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({
          message: 'Package indexed successfully',
          package: { id: 'alice/test' },
        }),
      } as Response);

      // Whitespace option token
      await publishToRegistry({ name: 'test' }, { token: '   ' });
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      let [, calledInit] = (globalThis.fetch as any).mock.calls[0];
      expect(calledInit.headers['Authorization']).toBeUndefined();

      // Whitespace env token
      process.env.AGENTHUB_TOKEN = '   ';
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({
          message: 'Package indexed successfully',
          package: { id: 'alice/test' },
        }),
      } as Response);

      await publishToRegistry({ name: 'test' });
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      [, calledInit] = (globalThis.fetch as any).mock.calls[0];
      expect(calledInit.headers['Authorization']).toBeUndefined();
    });
  });

  describe('buildPackagePayload', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-payload-test-'));
    });

    afterEach(() => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    });

    it('constructs complete payload from hub directory', () => {
      // Setup manifest
      safeWriteFile(
        path.join(tmpDir, 'agenthub.json'),
        JSON.stringify({
          name: 'super-agent',
          version: '2.0.0',
          description: 'A great agent package',
          type: 'addon',
          platforms: ['claude', 'cursor'],
          tags: ['testing', 'developer-tools'],
          license: 'Apache-2.0',
        })
      );

      // Setup README
      safeWriteFile(path.join(tmpDir, 'README.md'), '# Super Agent\n\nDocs for super agent');

      // Setup skills
      const skillA = path.join(tmpDir, 'skills', 'skill-a');
      ensureDir(skillA);

      // Setup MCP
      safeWriteFile(
        path.join(tmpDir, 'mcp', 'servers.json'),
        JSON.stringify({
          mcpServers: {
            github: {
              command: 'npx',
              args: ['-y', '@modelcontextprotocol/server-github'],
              env: { GITHUB_TOKEN: 'xxx' },
            },
          },
        })
      );

      const payload = buildPackagePayload(tmpDir, {
        repoShorthand: 'alice/super-agent',
      });

      expect(payload.owner).toBe('alice');
      expect(payload.repo).toBe('super-agent');
      expect(payload.name).toBe('super-agent');
      expect(payload.version).toBe('2.0.0');
      expect(payload.description).toBe('A great agent package');
      expect(payload.type).toBe('addon');
      expect(payload.platforms).toEqual(['claude', 'cursor']);
      expect(payload.tags).toEqual(['testing', 'developer-tools']);
      expect(payload.license).toBe('Apache-2.0');
      expect(payload.skills).toEqual([
        {
          name: 'skill-a',
          description: 'Skill: skill-a',
          path: 'skills/skill-a',
        },
      ]);
      expect(payload.mcpServers).toEqual([
        {
          name: 'github',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: ['GITHUB_TOKEN'],
          risk: 'low',
          status: 'verified',
        },
      ]);
      expect(payload.readme).toContain('# Super Agent');
      expect(payload.rulesAst).toEqual([]);
      expect(payload.securityRisk).toBe('low');
      expect(payload.isClean).toBe(true);
    });

    it('scans rules directory and constructs rulesAst with proper titles, paths, tokens', () => {
      safeWriteFile(
        path.join(tmpDir, 'agenthub.json'),
        JSON.stringify({
          name: 'rules-pkg',
          version: '1.0.0',
        })
      );

      // Root rule with # Title heading
      safeWriteFile(
        path.join(tmpDir, 'rules', 'common.md'),
        '# Core Rules\n\nAlways follow instructions carefully and test thoroughly.'
      );

      // Addon rule with frontmatter title
      safeWriteFile(
        path.join(tmpDir, 'rules', 'addons', 'sample.md'),
        '---\ntitle: Sample Addon Rule\n---\n\nAddon specific instructions.'
      );

      // Addon rule with frontmatter name
      safeWriteFile(
        path.join(tmpDir, 'rules', 'addons', 'named.md'),
        '---\nname: Named Rule\n---\n\nNamed rule content.'
      );

      // Rule with no title or frontmatter (falls back to basename)
      safeWriteFile(
        path.join(tmpDir, 'rules', 'overrides', 'plain.md'),
        'Plain text rule content without headings or frontmatter.'
      );

      const payload = buildPackagePayload(tmpDir, {
        repoShorthand: 'alice/rules-pkg',
      });

      expect(Array.isArray(payload.rulesAst)).toBe(true);
      const rules = payload.rulesAst as Array<{
        title: string;
        file: string;
        tokens: number;
        content: string;
      }>;
      expect(rules).toHaveLength(4);

      // rules/addons/named.md
      const namedRule = rules.find((r) => r.file === 'rules/addons/named.md');
      expect(namedRule).toBeDefined();
      expect(namedRule?.title).toBe('Named Rule');
      expect(namedRule?.tokens).toBeGreaterThan(0);

      // rules/addons/sample.md
      const sampleRule = rules.find((r) => r.file === 'rules/addons/sample.md');
      expect(sampleRule).toBeDefined();
      expect(sampleRule?.title).toBe('Sample Addon Rule');
      expect(sampleRule?.tokens).toBeGreaterThan(0);

      // rules/common.md
      const commonRule = rules.find((r) => r.file === 'rules/common.md');
      expect(commonRule).toBeDefined();
      expect(commonRule?.title).toBe('Core Rules');
      expect(commonRule?.content).toContain('# Core Rules');

      // rules/overrides/plain.md
      const plainRule = rules.find((r) => r.file === 'rules/overrides/plain.md');
      expect(plainRule).toBeDefined();
      expect(plainRule?.title).toBe('plain.md');

      expect(payload.securityRisk).toBe('low');
      expect(payload.isClean).toBe(true);
    });
  });
});
