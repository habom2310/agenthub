import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setCustomHome } from '../src/core/detector.js';
import { backupExistingConfigs, expandTilde, initHub } from '../src/core/scaffold.js';
import { ensureDir, safeWriteFile } from '../src/utils/fs.js';

describe('scaffold', () => {
  let tmpDir: string;
  let homeDir: string;
  let hubDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-scaffold-test-'));
    homeDir = path.join(tmpDir, 'home');
    hubDir = path.join(tmpDir, 'hub');
    ensureDir(homeDir);
    ensureDir(hubDir);
    setCustomHome(homeDir, hubDir);
  });

  afterEach(() => {
    setCustomHome(null, null);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe('backupExistingConfigs', () => {
    it('backs up targeted config files and ignores large/unrelated files', () => {
      // Setup whitelist files
      safeWriteFile(path.join(homeDir, '.gemini', 'GEMINI.md'), '# Gemini Rules');
      safeWriteFile(path.join(homeDir, '.gemini', 'config', 'skills.json'), '{"skills":[]}');
      safeWriteFile(path.join(homeDir, '.gemini', 'config', 'agents', 'custom.md'), '# Custom Agent');
      safeWriteFile(path.join(homeDir, '.claude', 'CLAUDE.md'), '# Claude Rules');
      safeWriteFile(path.join(homeDir, '.claude', 'agents', 'helper.md'), '# Helper Agent');
      safeWriteFile(path.join(homeDir, '.codex', 'AGENTS.md'), '# Codex Rules');
      safeWriteFile(path.join(homeDir, '.codex', 'config.toml'), 'model = "gpt-4"');

      // Setup non-whitelisted files (brain, logs, db)
      safeWriteFile(path.join(homeDir, '.gemini', 'antigravity.db'), 'binary data');
      safeWriteFile(path.join(homeDir, '.gemini', 'brain', 'scratch.txt'), 'brain content');
      safeWriteFile(path.join(homeDir, '.claude', 'logs.txt'), 'log entries');

      const backupDir = path.join(hubDir, 'backups', 'test-backup');
      const backedUp = backupExistingConfigs(backupDir, homeDir);

      expect(backedUp).toContain('.gemini/GEMINI.md');
      expect(backedUp).toContain('.gemini/config/skills.json');
      expect(backedUp).toContain('.gemini/config/agents/custom.md');
      expect(backedUp).toContain('.claude/CLAUDE.md');
      expect(backedUp).toContain('.claude/agents/helper.md');
      expect(backedUp).toContain('.codex/AGENTS.md');
      expect(backedUp).toContain('.codex/config.toml');

      // Check backed-up files exist on disk
      expect(fs.existsSync(path.join(backupDir, '.gemini', 'GEMINI.md'))).toBe(true);
      expect(fs.existsSync(path.join(backupDir, '.claude', 'CLAUDE.md'))).toBe(true);

      // Verify non-whitelisted files were NOT backed up
      expect(fs.existsSync(path.join(backupDir, '.gemini', 'antigravity.db'))).toBe(false);
      expect(fs.existsSync(path.join(backupDir, '.gemini', 'brain'))).toBe(false);
      expect(fs.existsSync(path.join(backupDir, '.claude', 'logs.txt'))).toBe(false);
    });

    it('handles clean runs when no config files exist', () => {
      const backupDir = path.join(hubDir, 'backups', 'empty-backup');
      const backedUp = backupExistingConfigs(backupDir, homeDir);
      expect(backedUp).toEqual([]);
    });
  });

  describe('initHub', () => {
    it('creates hub directory structure and writes agenthub.json manifest', () => {
      const result = initHub();

      expect(result.hubDir).toBe(hubDir);
      expect(fs.existsSync(path.join(hubDir, 'rules', 'overrides'))).toBe(true);
      expect(fs.existsSync(path.join(hubDir, 'skills'))).toBe(true);
      expect(fs.existsSync(path.join(hubDir, 'agents'))).toBe(true);
      expect(fs.existsSync(path.join(hubDir, 'mcp'))).toBe(true);
      expect(fs.existsSync(path.join(hubDir, 'backups'))).toBe(true);

      const manifestPath = path.join(hubDir, 'agenthub.json');
      expect(fs.existsSync(manifestPath)).toBe(true);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      expect(manifest.version).toBe('0.1.0');
      expect(manifest.platforms.claude.enabled).toBe(true);
      expect(manifest.platforms.antigravity.enabled).toBe(true);
      expect(manifest.links.skills).toBe(path.join(hubDir, 'skills'));
    });

    it('creates pre-agenthub backup during initialization', () => {
      safeWriteFile(path.join(homeDir, '.gemini', 'GEMINI.md'), '# Existing');

      const result = initHub();
      expect(result.backedUpFiles).toContain('.gemini/GEMINI.md');

      const backups = fs.readdirSync(path.join(hubDir, 'backups'));
      expect(backups.length).toBeGreaterThan(0);
      expect(backups[0]).toMatch(/^pre-agenthub-\d{8}_\d{6}Z$/);
    });

    it('copies templates into hub without overwriting existing files unless force is true', () => {
      const templateDir = path.join(tmpDir, 'custom-templates');
      safeWriteFile(path.join(templateDir, 'rules', 'common.md'), '# Common Template');
      safeWriteFile(path.join(templateDir, 'rules', 'overrides', 'claude.md'), '# Claude Override');
      safeWriteFile(path.join(templateDir, 'agents', 'coder.md'), '# Coder Agent');
      safeWriteFile(path.join(templateDir, 'mcp', 'servers.json'), '{"mcpServers":{}}');

      // Pre-exist a rule in hub with customized text
      safeWriteFile(path.join(hubDir, 'rules', 'common.md'), '# My Custom Common');

      // First run without force
      const res1 = initHub({ templateDir, force: false });
      expect(res1.copiedTemplates).toContain('rules/overrides/claude.md');
      expect(res1.copiedTemplates).toContain('agents/coder.md');
      expect(res1.copiedTemplates).toContain('mcp/servers.json');
      // Should NOT have copied rules/common.md because it already existed
      expect(res1.copiedTemplates).not.toContain('rules/common.md');
      expect(fs.readFileSync(path.join(hubDir, 'rules', 'common.md'), 'utf-8')).toBe('# My Custom Common');

      // Second run with force
      const res2 = initHub({ templateDir, force: true });
      expect(res2.copiedTemplates).toContain('rules/common.md');
      expect(fs.readFileSync(path.join(hubDir, 'rules', 'common.md'), 'utf-8')).toBe('# Common Template');
    });

    it('migrates rules, skills, agents, and mcp from an older hub', () => {
      const oldHub = path.join(tmpDir, 'old-agentrc');
      safeWriteFile(path.join(oldHub, 'rules', 'custom-rule.md'), '# Old Custom Rule');
      safeWriteFile(path.join(oldHub, 'rules', 'overrides', 'agy.md'), '# Old AGY Override');
      safeWriteFile(path.join(oldHub, 'agents', 'specialist.md'), '# Specialist');
      safeWriteFile(path.join(oldHub, 'mcp', 'mcp-config.json'), '{"migrated": true}');

      // Skill directory with SKILL.md
      const oldSkillDir = path.join(oldHub, 'skills', 'transcribe');
      safeWriteFile(path.join(oldSkillDir, 'SKILL.md'), '# Transcribe Skill');
      safeWriteFile(path.join(oldSkillDir, 'scripts', 'run.py'), 'print("transcribe")');

      const result = initHub({ migrateFrom: oldHub });

      expect(result.migratedFrom).toBe(path.resolve(oldHub));
      expect(result.migratedFiles).toContain('rules/custom-rule.md');
      expect(result.migratedFiles).toContain('rules/overrides/agy.md');
      expect(result.migratedFiles).toContain('agents/specialist.md');
      expect(result.migratedFiles).toContain('mcp/mcp-config.json');
      expect(result.migratedFiles).toContain('skills/transcribe');

      // Verify files exist in new hub
      expect(fs.readFileSync(path.join(hubDir, 'rules', 'custom-rule.md'), 'utf-8')).toBe('# Old Custom Rule');
      expect(fs.readFileSync(path.join(hubDir, 'skills', 'transcribe', 'SKILL.md'), 'utf-8')).toBe('# Transcribe Skill');
      expect(fs.readFileSync(path.join(hubDir, 'skills', 'transcribe', 'scripts', 'run.py'), 'utf-8')).toBe('print("transcribe")');
    });

    it('expands tilde and throws error for non-existent migrateFrom path', () => {
      // Test expandTilde helper
      expect(expandTilde('~')).toBe(homeDir);
      expect(expandTilde('~/.agentrc')).toBe(path.join(homeDir, '.agentrc'));
      expect(expandTilde('~\\.agentrc')).toBe(path.join(homeDir, '.agentrc'));
      expect(expandTilde('relative/path')).toBe('relative/path');

      // Test non-existent path throws error with expanded path
      const missingPath = path.resolve(path.join(homeDir, '.non-existent-agentrc'));
      expect(() => {
        initHub({ migrateFrom: '~/.non-existent-agentrc' });
      }).toThrow(`Migration source directory does not exist: ${missingPath}`);

      // Test file instead of directory throws error
      const notADir = path.join(tmpDir, 'some-file.txt');
      safeWriteFile(notADir, 'not a directory');
      expect(() => {
        initHub({ migrateFrom: notADir });
      }).toThrow(`Migration source directory does not exist: ${path.resolve(notADir)}`);
    });

    it('does not overwrite migrated files with templates even when force is true', () => {
      const oldHub = path.join(tmpDir, 'old-hub-priority');
      safeWriteFile(path.join(oldHub, 'rules', 'common.md'), '# Migrated Common Rule');
      safeWriteFile(path.join(oldHub, 'agents', 'specialist.md'), '# Migrated Specialist Agent');
      safeWriteFile(path.join(oldHub, 'mcp', 'servers.json'), '{"migrated": true}');

      const templateDir = path.join(tmpDir, 'template-priority');
      safeWriteFile(path.join(templateDir, 'rules', 'common.md'), '# Template Common Rule');
      safeWriteFile(path.join(templateDir, 'rules', 'extra.md'), '# Template Extra Rule');
      safeWriteFile(path.join(templateDir, 'agents', 'specialist.md'), '# Template Specialist Agent');
      safeWriteFile(path.join(templateDir, 'mcp', 'servers.json'), '{"template": true}');

      const result = initHub({ migrateFrom: oldHub, templateDir, force: true });

      // Migrated files must be preserved
      expect(fs.readFileSync(path.join(hubDir, 'rules', 'common.md'), 'utf-8')).toBe('# Migrated Common Rule');
      expect(fs.readFileSync(path.join(hubDir, 'agents', 'specialist.md'), 'utf-8')).toBe('# Migrated Specialist Agent');
      expect(fs.readFileSync(path.join(hubDir, 'mcp', 'servers.json'), 'utf-8')).toBe('{"migrated": true}');

      // Copied templates should include unmigrated files only
      expect(result.copiedTemplates).toContain('rules/extra.md');
      expect(result.copiedTemplates).not.toContain('rules/common.md');
      expect(result.copiedTemplates).not.toContain('agents/specialist.md');
      expect(result.copiedTemplates).not.toContain('mcp/servers.json');
    });

    it('preserves manifest platform settings from agentrc.json on migration', () => {
      const oldHub = path.join(tmpDir, 'old-agentrc-manifest');
      const oldManifest = {
        platforms: {
          cursor: { enabled: true },
          windsurf: { enabled: true, customKey: 'val' },
          claude: { enabled: false },
        },
      };
      safeWriteFile(path.join(oldHub, 'agentrc.json'), JSON.stringify(oldManifest, null, 2));

      initHub({ migrateFrom: oldHub });

      const manifestPath = path.join(hubDir, 'agenthub.json');
      expect(fs.existsSync(manifestPath)).toBe(true);

      const generatedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      // Migrated platform settings should be applied
      expect(generatedManifest.platforms.cursor.enabled).toBe(true);
      expect(generatedManifest.platforms.windsurf.enabled).toBe(true);
      expect(generatedManifest.platforms.windsurf.customKey).toBe('val');
      expect(generatedManifest.platforms.claude.enabled).toBe(false);
      // Default unset platforms remain enabled
      expect(generatedManifest.platforms.antigravity.enabled).toBe(true);
    });
  });
});
