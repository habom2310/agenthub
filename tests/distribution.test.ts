import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  packageAdd,
  packageInfo,
  resolvePackageTarget,
  sanitizeIdentifier,
} from '../src/core/distribution.js';
import { setCustomHome } from '../src/core/detector.js';
import { initHub } from '../src/core/scaffold.js';
import { ensureDir, safeWriteFile } from '../src/utils/fs.js';

describe('distribution engine (packageInfo, packageAdd, resolvePackageTarget)', () => {
  let tmpDir: string;
  let homeDir: string;
  let hubDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-dist-test-'));
    homeDir = path.join(tmpDir, 'home');
    hubDir = path.join(homeDir, '.agenthub');
    ensureDir(homeDir);
    setCustomHome(homeDir, hubDir);
    initHub({ force: true, customHome: homeDir });
  });

  afterEach(() => {
    setCustomHome(null, null);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
    vi.restoreAllMocks();
  });

  describe('sanitizeIdentifier', () => {
    it('cleans up invalid characters and whitespace', () => {
      expect(sanitizeIdentifier('  @my-org/my-pkg! ')).toBe('my-org-my-pkg');
      expect(sanitizeIdentifier('clean-name_123')).toBe('clean-name_123');
      expect(sanitizeIdentifier('---')).toBe('package');
      expect(sanitizeIdentifier('')).toBe('package');
    });
  });

  describe('resolvePackageTarget', () => {
    it('resolves existing local directory without cloning', () => {
      const localPkg = path.join(tmpDir, 'local-addon');
      ensureDir(localPkg);

      const resolved = resolvePackageTarget(localPkg);
      expect(resolved.dir).toBe(path.resolve(localPkg));
      expect(resolved.identifier).toBe('local-addon');

      // cleanup does not throw or delete local directory
      resolved.cleanup();
      expect(fs.existsSync(localPkg)).toBe(true);
    });

    it('throws when target does not exist and is not valid git shorthand/url', () => {
      const nonExistent = path.join(tmpDir, 'non-existent-addon');
      expect(() => resolvePackageTarget(nonExistent)).toThrow(/not an existing local directory/);
    });

    it('clones remote repo for owner/repo shorthand', () => {
      const cloneSpy = vi.spyOn(childProcess, 'spawnSync').mockImplementation((cmd, args) => {
        const dest = args?.[args.length - 1] as string;
        if (dest && fs.existsSync(path.dirname(dest))) {
          ensureDir(dest);
          safeWriteFile(path.join(dest, 'agenthub.json'), JSON.stringify({ name: 'cloned-agent' }));
        }
        return {
          status: 0,
          stdout: 'Cloning into...',
          stderr: '',
          output: [],
          pid: 1234,
          signal: null,
        } as any;
      });

      const res = resolvePackageTarget('alice/my-agent');
      expect(cloneSpy).toHaveBeenCalledWith(
        'git',
        ['clone', '--depth', '1', 'https://github.com/alice/my-agent.git', expect.any(String)],
        expect.any(Object)
      );
      expect(res.identifier).toBe('alice-my-agent');
      expect(fs.existsSync(res.dir)).toBe(true);

      // Verify cleanup removes the cloned directory
      res.cleanup();
      expect(fs.existsSync(res.dir)).toBe(false);
    });

    it('clones remote repo for git URL and cleans up on error', () => {
      vi.spyOn(childProcess, 'spawnSync').mockReturnValue({
        status: 128,
        stdout: '',
        stderr: 'fatal: repository not found',
        output: [],
        pid: 1234,
        signal: null,
      } as any);

      expect(() => resolvePackageTarget('https://github.com/alice/not-found.git')).toThrow(
        /fatal: repository not found/
      );
    });
  });

  describe('packageInfo', () => {
    it('returns analysis report for a local fixture package', () => {
      const fixturePkg = path.join(tmpDir, 'info-fixture');
      ensureDir(fixturePkg);

      safeWriteFile(
        path.join(fixturePkg, 'agenthub.json'),
        JSON.stringify({
          name: 'info-fixture',
          version: '1.2.0',
          type: 'addon',
          description: 'A test fixture package',
          platforms: ['gemini', 'claude'],
        })
      );

      safeWriteFile(path.join(fixturePkg, 'rules', 'common.md'), '# Fixture Rules\nRule content.');
      safeWriteFile(
        path.join(fixturePkg, 'skills', 'helper-skill', 'SKILL.md'),
        '---\nname: helper-skill\ndescription: A helpful skill\n---\nSkill instructions.'
      );
      safeWriteFile(
        path.join(fixturePkg, 'mcp', 'servers.json'),
        JSON.stringify({
          mcpServers: {
            fixture_mcp: {
              command: 'npx',
              args: ['-y', '@modelcontextprotocol/server-filesystem', '/safe/path'],
            },
          },
        })
      );

      const report = packageInfo(fixturePkg);

      expect(report.manifest.name).toBe('info-fixture');
      expect(report.manifest.version).toBe('1.2.0');
      expect(report.manifest.description).toBe('A test fixture package');
      expect(report.manifest.type).toBe('addon');
      expect(report.manifest.platforms).toEqual(['gemini', 'claude']);
      expect(report.mcpServers).toHaveLength(1);
      expect(report.mcpServers[0].name).toBe('fixture_mcp');
      expect(report.tokenFootprint.rulesTokens).toBeGreaterThan(0);
      expect(report.tokenFootprint.skillsTokens).toBeGreaterThan(0);
      expect(report.tokenFootprint.totalTokens).toBeGreaterThan(0);
      expect(report.riskLevel).toBe('LOW');
      expect(report.isClean).toBe(true);
    });
  });

  describe('packageAdd', () => {
    it('installs complete package with rules, skills, MCP servers, and auto-projection', () => {
      const fixturePkg = path.join(tmpDir, 'full-addon');
      ensureDir(fixturePkg);

      safeWriteFile(
        path.join(fixturePkg, 'agenthub.json'),
        JSON.stringify({
          name: 'full-addon',
          version: '1.0.0',
          type: 'addon',
          description: 'Complete addon package',
        })
      );

      safeWriteFile(path.join(fixturePkg, 'rules', 'common.md'), '# Full Addon Rules\nAlways verify before commit.');
      safeWriteFile(
        path.join(fixturePkg, 'skills', 'deployer', 'SKILL.md'),
        '---\nname: deployer\ndescription: Deployment helper skill\n---\nDeploy instructions.'
      );
      safeWriteFile(
        path.join(fixturePkg, 'mcp', 'servers.json'),
        JSON.stringify({
          mcpServers: {
            deploy_server: {
              command: 'npx',
              args: ['-y', 'deploy-mcp'],
            },
          },
        })
      );

      // Setup platform directories in home
      ensureDir(path.join(homeDir, '.gemini'));
      ensureDir(path.join(homeDir, '.claude'));
      ensureDir(path.join(homeDir, '.codex'));

      const result = packageAdd(fixturePkg, { homeDir, hubDir });

      expect(result.success).toBe(true);
      expect(result.identifier).toBe('full-addon');
      expect(result.installedRules).toBe(true);
      expect(result.installedSkills).toEqual(['deployer']);
      expect(result.mergedMcpServers).toEqual(['deploy_server']);

      // 1. Verify addon rule file created
      const addonRulePath = path.join(hubDir, 'rules', 'addons', 'full-addon.md');
      expect(fs.existsSync(addonRulePath)).toBe(true);
      expect(fs.readFileSync(addonRulePath, 'utf-8')).toContain('Always verify before commit.');

      // 2. Verify projection to downstream platforms
      const geminiRuleFile = path.join(homeDir, '.gemini', 'GEMINI.md');
      expect(fs.existsSync(geminiRuleFile)).toBe(true);
      expect(fs.readFileSync(geminiRuleFile, 'utf-8')).toContain('Always verify before commit.');

      const claudeRuleFile = path.join(homeDir, '.claude', 'CLAUDE.md');
      expect(fs.existsSync(claudeRuleFile)).toBe(true);
      expect(fs.readFileSync(claudeRuleFile, 'utf-8')).toMatch(/rules\/addons\/full-addon\.md/);

      const codexRuleFile = path.join(homeDir, '.codex', 'AGENTS.md');
      expect(fs.existsSync(codexRuleFile)).toBe(true);
      expect(fs.readFileSync(codexRuleFile, 'utf-8')).toContain('Always verify before commit.');

      // 3. Verify skills installed to hub and manifests projected
      const hubSkillDir = path.join(hubDir, 'skills', 'deployer');
      expect(fs.existsSync(hubSkillDir)).toBe(true);
      expect(fs.existsSync(path.join(hubSkillDir, 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(hubSkillDir, 'agents', 'openai.yaml'))).toBe(true);

      // 4. Verify MCP server merged into hub mcp/servers.json
      const hubMcpFile = path.join(hubDir, 'mcp', 'servers.json');
      expect(fs.existsSync(hubMcpFile)).toBe(true);
      const hubMcpConfig = JSON.parse(fs.readFileSync(hubMcpFile, 'utf-8'));
      expect(hubMcpConfig.mcpServers.deploy_server).toEqual({
        command: 'npx',
        args: ['-y', 'deploy-mcp'],
      });
    });

    it('installs rules from concatenated rules/ directory when common.md is absent', () => {
      const pkg = path.join(tmpDir, 'multi-rules-addon');
      ensureDir(pkg);

      safeWriteFile(path.join(pkg, 'rules', '01-alpha.md'), '# Alpha Rules');
      safeWriteFile(path.join(pkg, 'rules', '02-beta.md'), '# Beta Rules');
      // Subdir overrides should be excluded
      safeWriteFile(path.join(pkg, 'rules', 'overrides', 'ignored.md'), '# Ignored');

      const result = packageAdd(pkg, { homeDir, hubDir });

      expect(result.installedRules).toBe(true);
      const addonRulePath = path.join(hubDir, 'rules', 'addons', 'multi-rules-addon.md');
      expect(fs.existsSync(addonRulePath)).toBe(true);
      const content = fs.readFileSync(addonRulePath, 'utf-8');
      expect(content).toContain('# Alpha Rules');
      expect(content).toContain('# Beta Rules');
      expect(content).not.toContain('# Ignored');
    });

    it('installs rules from root rules.md when rules/ does not exist', () => {
      const pkg = path.join(tmpDir, 'root-rule-addon');
      ensureDir(pkg);

      safeWriteFile(path.join(pkg, 'rules.md'), '# Root Rules Only');

      const result = packageAdd(pkg, { homeDir, hubDir });

      expect(result.installedRules).toBe(true);
      const addonRulePath = path.join(hubDir, 'rules', 'addons', 'root-rule-addon.md');
      expect(fs.existsSync(addonRulePath)).toBe(true);
      expect(fs.readFileSync(addonRulePath, 'utf-8')).toContain('# Root Rules Only');
    });

    it('installs only rules when rulesOnly is true', () => {
      const pkg = path.join(tmpDir, 'rules-only-addon');
      ensureDir(pkg);

      safeWriteFile(path.join(pkg, 'rules', 'common.md'), '# Only Rules');
      safeWriteFile(path.join(pkg, 'skills', 'skipped-skill', 'SKILL.md'), 'name: skipped');
      safeWriteFile(
        path.join(pkg, 'mcp', 'servers.json'),
        JSON.stringify({ mcpServers: { skipped_mcp: { command: 'echo' } } })
      );

      const result = packageAdd(pkg, { homeDir, hubDir, rulesOnly: true });

      expect(result.installedRules).toBe(true);
      expect(result.installedSkills).toEqual([]);
      expect(result.mergedMcpServers).toEqual([]);
      expect(fs.existsSync(path.join(hubDir, 'skills', 'skipped-skill'))).toBe(false);
      const hubMcpFile = path.join(hubDir, 'mcp', 'servers.json');
      if (fs.existsSync(hubMcpFile)) {
        const hubMcp = JSON.parse(fs.readFileSync(hubMcpFile, 'utf-8'));
        expect(hubMcp.mcpServers?.skipped_mcp).toBeUndefined();
      }
    });

    it('installs only selected skills when skills option is provided', () => {
      const pkg = path.join(tmpDir, 'selective-skills-addon');
      ensureDir(pkg);

      safeWriteFile(path.join(pkg, 'rules', 'common.md'), '# Selective Rules');
      safeWriteFile(path.join(pkg, 'skills', 'skill-one', 'SKILL.md'), 'name: skill-one');
      safeWriteFile(path.join(pkg, 'skills', 'skill-two', 'SKILL.md'), 'name: skill-two');

      const result = packageAdd(pkg, {
        homeDir,
        hubDir,
        skills: ['skill-two'],
      });

      expect(result.installedSkills).toEqual(['skill-two']);
      expect(fs.existsSync(path.join(hubDir, 'skills', 'skill-two'))).toBe(true);
      expect(fs.existsSync(path.join(hubDir, 'skills', 'skill-one'))).toBe(false);
    });
  });
});
