import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listPackageSkills,
  packageAdd,
  packageInfo,
  resolvePackageTarget,
  sanitizeIdentifier,
} from '../src/core/distribution.js';
import { setCustomHome } from '../src/core/detector.js';
import { hashSkill } from '../src/core/hash.js';
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
        if (args?.[0] === 'rev-parse') return { status: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' } as any;
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
      expect(res.remote).toEqual({ source: 'github:alice/my-agent', commit: 'a'.repeat(40), warnings: [] });
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

  describe('packageAdd with a remote target', () => {
    const sha = 'd'.repeat(40);

    const mockClone = () =>
      vi.spyOn(childProcess, 'spawnSync').mockImplementation((cmd, args) => {
        if (args?.[0] === 'rev-parse') return { status: 0, stdout: `${sha}\n`, stderr: '' } as any;
        const dest = args?.[args.length - 1] as string;
        safeWriteFile(path.join(dest, 'skills', 'alpha', 'SKILL.md'), '# alpha');
        safeWriteFile(path.join(dest, 'skills', 'beta', 'SKILL.md'), '# beta');
        return { status: 0, stdout: '', stderr: '' } as any;
      });

    it('vendors skills, declares github sources, locks the commit and links them', () => {
      mockClone();
      const res = packageAdd('alice/pack', { homeDir, hubDir, skills: ['alpha'] });
      expect(res.installedSkills).toEqual(['alpha']);

      const link = path.join(hubDir, 'skills', 'alpha');
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(path.join(link, 'SKILL.md'), 'utf-8')).toBe('# alpha');
      expect(fs.existsSync(path.join(hubDir, 'vendor', 'skills', 'alpha', 'skills', 'alpha', 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(hubDir, 'skills', 'beta'))).toBe(false);

      const manifest = JSON.parse(fs.readFileSync(path.join(hubDir, 'agenthub.json'), 'utf-8'));
      expect(manifest.skills).toEqual({ alpha: 'github:alice/pack#skills/alpha' });
      const lock = JSON.parse(fs.readFileSync(path.join(hubDir, 'agenthub.lock.json'), 'utf-8'));
      const vendored = path.join(hubDir, 'vendor', 'skills', 'alpha', 'skills', 'alpha');
      expect(lock.skills.alpha).toEqual({ source: 'github:alice/pack#skills/alpha', commit: sha, hash: hashSkill(vendored) });
      expect(fs.readFileSync(path.join(hubDir, '.gitignore'), 'utf-8')).toContain('/skills/alpha');
    });

    it('refuses to shadow an existing local skill folder', () => {
      mockClone();
      safeWriteFile(path.join(hubDir, 'skills', 'alpha', 'SKILL.md'), '# mine');
      expect(() => packageAdd('alice/pack', { homeDir, hubDir })).toThrow(/already exists in the hub as a local folder/);
      expect(fs.readFileSync(path.join(hubDir, 'skills', 'alpha', 'SKILL.md'), 'utf-8')).toBe('# mine');
    });

    it('does not record credentials from the URL and warns', () => {
      mockClone();
      const res = packageAdd('https://bob:s3cret@git.example.com/team/pack.git', { homeDir, hubDir, skills: ['alpha'] });
      const manifest = fs.readFileSync(path.join(hubDir, 'agenthub.json'), 'utf-8');
      const lock = fs.readFileSync(path.join(hubDir, 'agenthub.lock.json'), 'utf-8');
      expect(manifest + lock).not.toContain('s3cret');
      expect(manifest + lock).not.toContain('bob');
      expect(JSON.parse(manifest).skills.alpha).toBe('git:https://git.example.com/team/pack.git#skills/alpha');
      expect(res.warnings[0]).toContain('Credentials in the URL');
    });

    it('rejects a "#" in a remote URL', () => {
      expect(() => resolvePackageTarget('https://git.example.com/team/pack.git#frag')).toThrow('must not contain "#"');
    });

    it('validates every skill name before vendoring any of them', () => {
      vi.spyOn(childProcess, 'spawnSync').mockImplementation((cmd, args) => {
        if (args?.[0] === 'rev-parse') return { status: 0, stdout: `${sha}\n`, stderr: '' } as any;
        const dest = args?.[args.length - 1] as string;
        safeWriteFile(path.join(dest, 'skills', 'good', 'SKILL.md'), '# good');
        safeWriteFile(path.join(dest, 'skills', 'zz bad name', 'SKILL.md'), '# bad');
        return { status: 0, stdout: '', stderr: '' } as any;
      });
      expect(() => packageAdd('alice/pack', { homeDir, hubDir })).toThrow(/invalid name/);
      expect(fs.existsSync(path.join(hubDir, 'vendor'))).toBe(false);
      expect(fs.existsSync(path.join(hubDir, 'skills', 'good'))).toBe(false);
      expect(fs.existsSync(path.join(hubDir, 'agenthub.lock.json'))).toBe(false);
    });

    it('does not silently replace a vendored declaration with a local copy', () => {
      mockClone();
      packageAdd('alice/pack', { homeDir, hubDir, skills: ['alpha'] });
      const pkg = path.join(tmpDir, 'localpkg2');
      safeWriteFile(path.join(pkg, 'skills', 'alpha', 'SKILL.md'), '# mine');
      expect(() => packageAdd(pkg, { homeDir, hubDir })).toThrow(/already declared as "github:alice\/pack#skills\/alpha"/);
      expect(fs.readFileSync(path.join(hubDir, 'skills', 'alpha', 'SKILL.md'), 'utf-8')).toBe('# alpha');
    });

    it('copies and declares a local directory target as local', () => {
      const pkg = path.join(tmpDir, 'localpkg');
      safeWriteFile(path.join(pkg, 'skills', 'gamma', 'SKILL.md'), '# gamma');
      packageAdd(pkg, { homeDir, hubDir });
      expect(fs.lstatSync(path.join(hubDir, 'skills', 'gamma')).isSymbolicLink()).toBe(false);
      const manifest = JSON.parse(fs.readFileSync(path.join(hubDir, 'agenthub.json'), 'utf-8'));
      expect(manifest.skills).toEqual({ gamma: 'local' });
      expect(fs.existsSync(path.join(hubDir, 'agenthub.lock.json'))).toBe(false);
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

  describe('more source formats and skill discovery', () => {
    const sha = 'e'.repeat(40);
    // a fake clone that lays out the given files and records the git calls
    const mockClone = (files: Record<string, string>) => {
      const calls: string[][] = [];
      vi.spyOn(childProcess, 'spawnSync').mockImplementation((cmd, args) => {
        calls.push(args as string[]);
        if (args?.[0] === 'rev-parse') return { status: 0, stdout: `${sha}\n`, stderr: '' } as any;
        if (args?.[0] === 'clone') {
          const dest = args[args.length - 1] as string;
          for (const [rel, content] of Object.entries(files)) safeWriteFile(path.join(dest, rel), content);
        }
        return { status: 0, stdout: '', stderr: '' } as any;
      });
      return calls;
    };
    const manifestSkills = () => JSON.parse(fs.readFileSync(path.join(hubDir, 'agenthub.json'), 'utf-8')).skills;
    const lockSkills = () => JSON.parse(fs.readFileSync(path.join(hubDir, 'agenthub.lock.json'), 'utf-8')).skills;
    const repo = { 'skills/alpha/SKILL.md': '# alpha', 'skills/beta/SKILL.md': '# beta' };

    it('owner/repo@skill installs only that skill', () => {
      mockClone(repo);
      const res = packageAdd('alice/pack@beta', { homeDir, hubDir });
      expect(res.installedSkills).toEqual(['beta']);
      expect(manifestSkills()).toEqual({ beta: 'github:alice/pack#skills/beta' });
    });

    it('owner/repo@skill fails when the skill does not exist, listing what does', () => {
      mockClone(repo);
      expect(() => packageAdd('alice/pack@nope', { homeDir, hubDir })).toThrow('Skill "nope" not found. Available: alpha, beta');
      expect(fs.existsSync(path.join(hubDir, 'agenthub.lock.json'))).toBe(false);
    });

    it('--ref clones that ref and records it as the ref field and in the lock source', () => {
      const calls = mockClone(repo);
      packageAdd('alice/pack@alpha', { homeDir, hubDir, ref: 'release/1.0' });
      expect(calls[0]).toEqual(['clone', '--depth', '1', '--branch', 'release/1.0', 'https://github.com/alice/pack.git', expect.any(String)]);
      expect(manifestSkills()).toEqual({ alpha: { source: 'github:alice/pack#skills/alpha', ref: 'release/1.0' } });
      expect(lockSkills().alpha).toMatchObject({ source: 'github:alice/pack#skills/alpha ref=release/1.0', commit: sha });
    });

    it('a commit ref is checked out after a full clone', () => {
      const calls = mockClone(repo);
      const ref = 'c'.repeat(40);
      packageAdd('alice/pack@alpha', { homeDir, hubDir, ref });
      expect(calls[0].slice(0, 2)).toEqual(['clone', 'https://github.com/alice/pack.git']);
      expect(calls[1]).toEqual(['checkout', '-q', '--detach', ref]);
    });

    it('a GitHub tree URL gives ref and subpath; the skill is found under it', () => {
      const calls = mockClone(repo);
      const res = packageAdd('https://github.com/alice/pack/tree/main/skills/alpha?tab=x', { homeDir, hubDir });
      expect(calls[0]).toEqual(['clone', '--depth', '1', '--branch', 'main', 'https://github.com/alice/pack.git', expect.any(String)]);
      expect(res.installedSkills).toEqual(['alpha']);
      expect(manifestSkills()).toEqual({ alpha: { source: 'github:alice/pack#skills/alpha', ref: 'main' } });
      expect(fs.readFileSync(path.join(hubDir, 'skills', 'alpha', 'SKILL.md'), 'utf-8')).toBe('# alpha');
    });

    it('a tree URL to a folder of skills finds the skills below it, with the full subpath', () => {
      mockClone({ 'packs/x/one/SKILL.md': '# one', 'packs/x/cat/two/SKILL.md': '# two' });
      const res = packageAdd('https://github.com/alice/pack/tree/dev/packs/x', { homeDir, hubDir });
      expect([...res.installedSkills].sort()).toEqual(['one', 'two']);
      expect(manifestSkills().two).toEqual({ source: 'github:alice/pack#packs/x/cat/two', ref: 'dev' });
    });

    it('a GitLab tree URL is recorded as git: with ref and subpath', () => {
      const calls = mockClone(repo);
      packageAdd('https://gitlab.com/grp/sub/pack/-/tree/main/skills/beta', { homeDir, hubDir });
      expect(calls[0]).toContain('https://gitlab.com/grp/sub/pack.git');
      expect(manifestSkills()).toEqual({ beta: { source: 'git:https://gitlab.com/grp/sub/pack.git#skills/beta', ref: 'main' } });
    });

    it('an Azure Repos URL records path and branch without the query', () => {
      mockClone(repo);
      packageAdd('https://dev.azure.com/org/proj/_git/pack?path=/skills/alpha&version=GBmain', { homeDir, hubDir });
      expect(manifestSkills()).toEqual({ alpha: { source: 'git:https://dev.azure.com/org/proj/_git/pack#skills/alpha', ref: 'main' } });
      expect(fs.readFileSync(path.join(hubDir, 'agenthub.json'), 'utf-8')).not.toContain('?');
    });

    it('a subpath that does not exist is an error and leaves no temp clone behind', () => {
      mockClone(repo);
      expect(() => packageAdd('https://github.com/alice/pack/tree/main/nope', { homeDir, hubDir })).toThrow(/subpath "nope" not found/);
    });

    it('discovers skills in category folders and from plugin manifests', () => {
      mockClone({
        'skills/cat/deep/SKILL.md': '# deep',
        'extra/ext/SKILL.md': '# ext',
        '.claude-plugin/plugin.json': JSON.stringify({ skills: ['./extra', '../outside'] }),
      });
      const res = packageAdd('alice/pack', { homeDir, hubDir });
      expect(res.installedSkills).toEqual(['deep', 'ext']);
      expect(manifestSkills()).toEqual({ deep: 'github:alice/pack#skills/cat/deep', ext: 'github:alice/pack#extra/ext' });
    });

    it('--ref conflicting with the ref of a tree URL is an error; the same ref is fine', () => {
      mockClone(repo);
      expect(() => packageAdd('https://github.com/alice/pack/tree/main/skills/alpha', { homeDir, hubDir, ref: 'dev' })).toThrow(/conflicts/);
      expect(packageAdd('https://github.com/alice/pack/tree/main/skills/alpha', { homeDir, hubDir, ref: 'main' }).installedSkills).toEqual(['alpha']);
      expect(() => packageAdd('alice/pack', { homeDir, hubDir, ref: '-x' })).toThrow(/Invalid --ref/);
    });

    it('a failed clone of a tree URL explains that branch names with a slash are ambiguous', () => {
      vi.spyOn(childProcess, 'spawnSync').mockReturnValue({ status: 128, stdout: '', stderr: 'fatal: Remote branch feature not found', output: [], pid: 1, signal: null } as any);
      expect(() => packageAdd('https://github.com/alice/pack/tree/feature/x/skills/a', { homeDir, hubDir })).toThrow(/ambiguous in tree URLs; use the repo URL with --ref/);
      expect(() => packageAdd('alice/pack', { homeDir, hubDir })).toThrow(/^((?!ambiguous).)*$/s);
    });

    it('a root SKILL.md without a name is named after the repo, not the temp clone folder', () => {
      mockClone({ 'SKILL.md': '# unnamed' });
      const res = packageAdd('alice/whole-thing', { homeDir, hubDir });
      expect(res.installedSkills).toEqual(['alice-whole-thing']);
      expect(manifestSkills()).toEqual({ 'alice-whole-thing': 'github:alice/whole-thing' });
      expect(JSON.stringify(manifestSkills())).not.toContain('agenthub-fetch');
    });

    it('warns about folders without a SKILL.md and about duplicate names, and --list shows both', () => {
      mockClone({
        'skills/a/SKILL.md': '# a',
        'skills/draft/notes.md': 'no skill here',
        'skills/cat/empty/readme.md': 'x',
        '.claude/skills/a/SKILL.md': '# a again',
      });
      const res = packageAdd('alice/pack', { homeDir, hubDir });
      expect(res.installedSkills).toEqual(['a']);
      expect(res.warnings).toContain('skipped skills/draft: no SKILL.md');
      expect(res.warnings).toContain('skipped skills/cat: no SKILL.md');
      expect(res.warnings).toContain('duplicate skill "a": using skills/a, ignoring .claude/skills/a');
      expect(manifestSkills().a).toBe('github:alice/pack#skills/a');

      const listed = listPackageSkills('alice/pack');
      expect(listed.warnings).toEqual(expect.arrayContaining(['skipped skills/draft: no SKILL.md', 'duplicate skill "a": using skills/a, ignoring .claude/skills/a']));
    });

    it('a repo with a root SKILL.md is vendored as one skill without a subpath', () => {
      mockClone({ 'SKILL.md': '---\nname: whole\n---\n# whole', 'skills/other/SKILL.md': '# other' });
      const res = packageAdd('alice/whole', { homeDir, hubDir });
      expect(res.installedSkills).toEqual(['whole']);
      expect(manifestSkills()).toEqual({ whole: 'github:alice/whole' });
    });

    it('--list: listPackageSkills reports what it found and installs nothing', () => {
      mockClone({ ...repo, 'skills/alpha/SKILL.md': '---\nname: alpha\ndescription: Does alpha\n---\n' });
      const found = listPackageSkills('alice/pack');
      expect(found.skills.map((s) => [s.name, s.rel, s.description])).toEqual([
        ['alpha', 'skills/alpha', 'Does alpha'],
        ['beta', 'skills/beta', undefined],
      ]);
      expect(fs.existsSync(path.join(hubDir, 'vendor'))).toBe(false);
      expect(fs.existsSync(path.join(hubDir, 'agenthub.lock.json'))).toBe(false);
    });

    it('does not record credentials, queries or the token of a GitLab URL', () => {
      mockClone(repo);
      packageAdd('https://oauth2:tok3n@gitlab.com/g/pack/-/tree/main/skills/alpha?ref_type=heads', { homeDir, hubDir });
      const written = fs.readFileSync(path.join(hubDir, 'agenthub.json'), 'utf-8') + fs.readFileSync(path.join(hubDir, 'agenthub.lock.json'), 'utf-8');
      expect(written).not.toMatch(/tok3n|oauth2|ref_type/);
    });
  });
});
