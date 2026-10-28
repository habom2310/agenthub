import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCustomHome } from '../src/core/detector.js';
import { projectAll } from '../src/core/projector.js';
import { initHub } from '../src/core/scaffold.js';
import {
  cleanupGeneratedRules,
  cleanupJunctions,
  findEarliestBackup,
  restoreFromBackup,
  uninstallHub,
} from '../src/core/uninstaller.js';
import { createJunction, ensureDir, isJunctionOrSymlink, safeWriteFile } from '../src/utils/fs.js';

describe('uninstaller', () => {
  let tmpDir: string;
  let homeDir: string;
  let hubDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-uninstaller-test-'));
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

  describe('findEarliestBackup', () => {
    it('returns null when backups directory does not exist or has no matching directories', () => {
      expect(findEarliestBackup(hubDir)).toBeNull();

      const backupsDir = path.join(hubDir, 'backups');
      ensureDir(backupsDir);
      expect(findEarliestBackup(hubDir)).toBeNull();

      // Non-matching directories
      ensureDir(path.join(backupsDir, 'random-backup'));
      expect(findEarliestBackup(hubDir)).toBeNull();
    });

    it('returns earliest backup when sorted alphabetically', () => {
      const backupsDir = path.join(hubDir, 'backups');
      const backup1 = path.join(backupsDir, 'pre-agenthub-20261027_100000Z');
      const backup2 = path.join(backupsDir, 'pre-agenthub-20261028_100000Z');
      const backup3 = path.join(backupsDir, 'pre-agenthub-20261026_100000Z');

      ensureDir(backup1);
      ensureDir(backup2);
      ensureDir(backup3);

      const earliest = findEarliestBackup(hubDir);
      expect(earliest).toBe(backup3);
    });
  });

  describe('restoreFromBackup', () => {
    it('restores all backed up files recursively into homeDir', () => {
      const backupDir = path.join(hubDir, 'backups', 'pre-agenthub-20261028_120000Z');
      safeWriteFile(path.join(backupDir, '.claude', 'CLAUDE.md'), 'original claude rules');
      safeWriteFile(path.join(backupDir, '.gemini', 'config', 'skills.json'), '{"skills":[]}');
      safeWriteFile(path.join(backupDir, '.codex', 'config.toml'), 'model = "gpt-4"');

      const restored = restoreFromBackup(backupDir, homeDir);

      expect(restored).toContain('.claude/CLAUDE.md');
      expect(restored).toContain('.gemini/config/skills.json');
      expect(restored).toContain('.codex/config.toml');

      expect(fs.readFileSync(path.join(homeDir, '.claude', 'CLAUDE.md'), 'utf-8')).toBe(
        'original claude rules'
      );
      expect(
        fs.readFileSync(path.join(homeDir, '.gemini', 'config', 'skills.json'), 'utf-8')
      ).toBe('{"skills":[]}');
      expect(fs.readFileSync(path.join(homeDir, '.codex', 'config.toml'), 'utf-8')).toBe(
        'model = "gpt-4"'
      );
    });

    it('rejects path traversal attempting to escape homeDir', () => {
      const backupDir = path.join(hubDir, 'backups', 'pre-agenthub-evil');
      ensureDir(backupDir);
      safeWriteFile(path.join(backupDir, 'valid.txt'), 'valid');

      const spy = vi.spyOn(fs, 'readdirSync').mockImplementationOnce(() => [
        {
          name: '../../evil.txt',
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
        } as any,
      ]);

      expect(() => restoreFromBackup(backupDir, homeDir)).toThrow(/path traversal/i);
      spy.mockRestore();
    });

    it('skips non-files and directory symlinks cleanly', () => {
      const backupDir = path.join(hubDir, 'backups', 'pre-agenthub-symlinks');
      ensureDir(backupDir);
      safeWriteFile(path.join(backupDir, 'valid.txt'), 'valid content');

      const spy = vi.spyOn(fs, 'readdirSync').mockImplementationOnce(() => [
        {
          name: 'valid.txt',
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
        } as any,
        {
          name: 'symlink-dir',
          isDirectory: () => false,
          isFile: () => false,
          isSymbolicLink: () => true,
        } as any,
      ]);

      const restored = restoreFromBackup(backupDir, homeDir);
      expect(restored).toEqual(['valid.txt']);
      expect(fs.existsSync(path.join(homeDir, 'valid.txt'))).toBe(true);
      expect(fs.existsSync(path.join(homeDir, 'symlink-dir'))).toBe(false);
      spy.mockRestore();
    });
  });

  describe('uninstallHub integration', () => {
    it('Test 1: Full rollback with backup restores pre-agenthub files', () => {
      // Setup earliest backup in hubDir
      const backupDir = path.join(hubDir, 'backups', 'pre-agenthub-20261028_000000Z');
      safeWriteFile(path.join(backupDir, '.claude', 'CLAUDE.md'), 'original claude rules');
      safeWriteFile(path.join(backupDir, '.gemini', 'GEMINI.md'), 'original gemini rules');
      safeWriteFile(path.join(backupDir, '.gemini', 'config', 'skills.json'), '{"original":true}');
      safeWriteFile(path.join(backupDir, '.claude', 'agents', 'helper.md'), '# Original Helper');

      // Overwrite files in homeDir with agenthub managed content
      safeWriteFile(
        path.join(homeDir, '.claude', 'CLAUDE.md'),
        '<!-- AUTOGENERATED BY AGENTRC -->\n@.agenthub/rules/common.md'
      );
      safeWriteFile(
        path.join(homeDir, '.gemini', 'GEMINI.md'),
        '<!-- AUTOGENERATED BY AGENTRC -->\nagenthub rules'
      );
      safeWriteFile(path.join(homeDir, '.gemini', 'config', 'skills.json'), '{"modified":true}');
      safeWriteFile(
        path.join(homeDir, '.claude', 'agents', 'helper.md'),
        '# Modified by agenthub'
      );

      const result = uninstallHub({ home: homeDir, hub: hubDir });

      expect(result.success).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.backupRestored).toBe(backupDir);
      expect(result.restoredFiles).toContain('.claude/CLAUDE.md');
      expect(result.restoredFiles).toContain('.gemini/GEMINI.md');
      expect(result.restoredFiles).toContain('.gemini/config/skills.json');
      expect(result.restoredFiles).toContain('.claude/agents/helper.md');

      // Verify files on disk match pre-agenthub content
      expect(fs.readFileSync(path.join(homeDir, '.claude', 'CLAUDE.md'), 'utf-8')).toBe(
        'original claude rules'
      );
      expect(fs.readFileSync(path.join(homeDir, '.gemini', 'GEMINI.md'), 'utf-8')).toBe(
        'original gemini rules'
      );
      expect(
        fs.readFileSync(path.join(homeDir, '.gemini', 'config', 'skills.json'), 'utf-8')
      ).toBe('{"original":true}');
      expect(fs.readFileSync(path.join(homeDir, '.claude', 'agents', 'helper.md'), 'utf-8')).toBe(
        '# Original Helper'
      );
    });

    it('Test 2: Junctions pointing to .agenthub/skills are unlinked; if .agentrc/skills exists, restored to .agentrc/skills', () => {
      // Create .agentrc/skills
      const agentrcSkills = path.join(homeDir, '.agentrc', 'skills');
      safeWriteFile(path.join(agentrcSkills, 'rc-skill', 'SKILL.md'), '# RC Skill');

      // Create hub skills
      const hubSkills = path.join(hubDir, 'skills');
      safeWriteFile(path.join(hubSkills, 'hub-skill', 'SKILL.md'), '# Hub Skill');

      // Link claude and cursor skills to hub
      const claudeSkills = path.join(homeDir, '.claude', 'skills');
      const cursorSkills = path.join(homeDir, '.cursor', 'skills');
      createJunction(hubSkills, claudeSkills);
      createJunction(hubSkills, cursorSkills);

      expect(isJunctionOrSymlink(claudeSkills)).toBe(true);
      expect(isJunctionOrSymlink(cursorSkills)).toBe(true);

      const result = uninstallHub({ home: homeDir, hub: hubDir });

      expect(result.success).toBe(true);
      expect(result.unlinkedJunctions).toContain(claudeSkills);
      expect(result.unlinkedJunctions).toContain(cursorSkills);
      expect(result.restoredJunctions).toContain(claudeSkills);
      expect(result.restoredJunctions).toContain(cursorSkills);

      // Verify junctions now point to .agentrc/skills
      expect(isJunctionOrSymlink(claudeSkills)).toBe(true);
      expect(isJunctionOrSymlink(cursorSkills)).toBe(true);
      expect(fs.existsSync(path.join(claudeSkills, 'rc-skill', 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(cursorSkills, 'rc-skill', 'SKILL.md'))).toBe(true);
    });

    it('Test 3: If skills.old exists, restored back to skills', () => {
      const hubSkills = path.join(hubDir, 'skills');
      safeWriteFile(path.join(hubSkills, 'hub-skill', 'SKILL.md'), '# Hub Skill');

      // Create skills.old in .claude
      const claudeDir = path.join(homeDir, '.claude');
      const skillsOld = path.join(claudeDir, 'skills.old');
      safeWriteFile(path.join(skillsOld, 'my-old-skill', 'SKILL.md'), '# Old Skill');

      // Create agentrc/skills to ensure skills.old takes priority over agentrc
      const agentrcSkills = path.join(homeDir, '.agentrc', 'skills');
      safeWriteFile(path.join(agentrcSkills, 'rc-skill', 'SKILL.md'), '# RC Skill');

      // Create junction pointing to hub
      const claudeSkills = path.join(claudeDir, 'skills');
      createJunction(hubSkills, claudeSkills);

      const result = uninstallHub({ home: homeDir, hub: hubDir });

      expect(result.success).toBe(true);
      expect(result.unlinkedJunctions).toContain(claudeSkills);
      expect(result.restoredJunctions).toContain(claudeSkills);

      // Verify skills.old was renamed to skills
      expect(fs.existsSync(skillsOld)).toBe(false);
      expect(fs.existsSync(claudeSkills)).toBe(true);
      expect(isJunctionOrSymlink(claudeSkills)).toBe(false);
      expect(fs.existsSync(path.join(claudeSkills, 'my-old-skill', 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(claudeSkills, 'rc-skill'))).toBe(false);
    });

    it('Test 4: Generated files with agenthub are removed if not in backup', () => {
      // Put one file in backup
      const backupDir = path.join(hubDir, 'backups', 'pre-agenthub-20261028_000000Z');
      safeWriteFile(
        path.join(backupDir, '.gemini', 'GEMINI.md'),
        '# Pre-existing Gemini rules mentioning agenthub'
      );

      // Create files generated by agenthub NOT in backup
      const mdcFile = path.join(homeDir, '.cursor', 'rules', 'agenthub.mdc');
      const cursorrulesFile = path.join(homeDir, '.cursorrules');
      const windsurfrulesFile = path.join(homeDir, '.windsurfrules');
      const windsurfGlobalRules = path.join(
        homeDir,
        '.windsurf',
        'memories',
        'global_rules.md'
      );
      const codeiumGlobalRules = path.join(
        homeDir,
        '.codeium',
        'windsurf',
        'memories',
        'global_rules.md'
      );
      const claudeRules = path.join(homeDir, '.claude', 'CLAUDE.md');
      const codexAgents = path.join(homeDir, '.codex', 'AGENTS.md');
      const scoutAgent = path.join(homeDir, '.claude', 'agents', 'scout.md');
      const reviewerAgent = path.join(
        homeDir,
        '.gemini',
        'config',
        'agents',
        'reviewer.md'
      );
      const customAgent = path.join(
        homeDir,
        '.claude',
        'agents',
        'custom.md'
      );
      const unrelatedAgent = path.join(
        homeDir,
        '.claude',
        'agents',
        'unrelated.md'
      );

      safeWriteFile(mdcFile, '# AgentHub MDC');
      safeWriteFile(cursorrulesFile, '# Cursor rules autogenerated by agenthub');
      safeWriteFile(windsurfrulesFile, '# Windsurf rules from agenthub');
      safeWriteFile(windsurfGlobalRules, '# Global rules from agenthub');
      safeWriteFile(codeiumGlobalRules, '# Codeium rules from agenthub');
      safeWriteFile(claudeRules, '@~/.agenthub/rules/global.md');
      safeWriteFile(codexAgents, '# Codex agenthub agents');
      safeWriteFile(scoutAgent, '# Scout subagent');
      safeWriteFile(reviewerAgent, '# Reviewer subagent');
      safeWriteFile(customAgent, '# Custom subagent generated by agenthub');
      safeWriteFile(unrelatedAgent, '# Unrelated user subagent with no keyword');

      // The backup also restored .gemini/GEMINI.md
      safeWriteFile(
        path.join(homeDir, '.gemini', 'GEMINI.md'),
        '# Backup restored'
      );

      const result = uninstallHub({ home: homeDir, hub: hubDir });

      expect(result.success).toBe(true);

      // Verify generated agenthub files were removed
      expect(fs.existsSync(mdcFile)).toBe(false);
      expect(fs.existsSync(cursorrulesFile)).toBe(false);
      expect(fs.existsSync(windsurfrulesFile)).toBe(false);
      expect(fs.existsSync(windsurfGlobalRules)).toBe(false);
      expect(fs.existsSync(codeiumGlobalRules)).toBe(false);
      expect(fs.existsSync(claudeRules)).toBe(false);
      expect(fs.existsSync(codexAgents)).toBe(false);
      expect(fs.existsSync(scoutAgent)).toBe(false);
      expect(fs.existsSync(reviewerAgent)).toBe(false);
      expect(fs.existsSync(customAgent)).toBe(false);

      // Verify unrelated agent and backup-restored file were preserved
      expect(fs.existsSync(unrelatedAgent)).toBe(true);
      expect(fs.existsSync(path.join(homeDir, '.gemini', 'GEMINI.md'))).toBe(true);
    });

    it('Test 5: Dry-run does not modify filesystem', () => {
      // Setup backup
      const backupDir = path.join(hubDir, 'backups', 'pre-agenthub-20261028_000000Z');
      safeWriteFile(path.join(backupDir, '.claude', 'CLAUDE.md'), 'pre-backup claude rules');

      // Setup home files
      const claudeRules = path.join(homeDir, '.claude', 'CLAUDE.md');
      safeWriteFile(claudeRules, 'modified agenthub claude rules');

      const hubSkills = path.join(hubDir, 'skills');
      safeWriteFile(path.join(hubSkills, 'test', 'SKILL.md'), '# Test Skill');
      const claudeSkills = path.join(homeDir, '.claude', 'skills');
      createJunction(hubSkills, claudeSkills);

      const mdcFile = path.join(homeDir, '.cursor', 'rules', 'agenthub.mdc');
      safeWriteFile(mdcFile, 'mdc rule');

      const result = uninstallHub({
        home: homeDir,
        hub: hubDir,
        dryRun: true,
        purge: true,
      });

      expect(result.success).toBe(true);
      expect(result.restoredFiles).toContain('.claude/CLAUDE.md');
      expect(result.unlinkedJunctions).toContain(claudeSkills);
      expect(result.removedFiles).toContain(mdcFile);
      expect(result.purgedHub).toBe(true);

      // Verify filesystem was NOT modified
      expect(fs.readFileSync(claudeRules, 'utf-8')).toBe(
        'modified agenthub claude rules'
      );
      expect(isJunctionOrSymlink(claudeSkills)).toBe(true);
      expect(fs.existsSync(mdcFile)).toBe(true);
      expect(fs.existsSync(hubDir)).toBe(true);
    });

    it('Test 6: Purge removes hubDir', () => {
      safeWriteFile(path.join(hubDir, 'manifest.json'), '{}');
      safeWriteFile(path.join(hubDir, 'skills', 'test', 'SKILL.md'), '# Skill');

      expect(fs.existsSync(hubDir)).toBe(true);

      const result = uninstallHub({ home: homeDir, hub: hubDir, purge: true });

      expect(result.success).toBe(true);
      expect(result.purgedHub).toBe(true);
      expect(fs.existsSync(hubDir)).toBe(false);
    });

    it('Test 7: Full real projection (initHub -> projectAll -> uninstallHub) cleanly removes all projected files', () => {
      // 1. Initialize real hub in custom sandbox
      initHub({ force: true, customHome: homeDir });

      // Setup connected assistants
      ensureDir(path.join(homeDir, '.cursor'));
      ensureDir(path.join(homeDir, '.windsurf'));

      // 2. Project all rules and subagents
      const projectRes = projectAll({ homeDir, hubDir });
      expect(projectRes.success).toBe(true);

      const geminiMd = path.join(homeDir, '.gemini', 'GEMINI.md');
      const codexAgents = path.join(homeDir, '.codex', 'AGENTS.md');
      const claudeMd = path.join(homeDir, '.claude', 'CLAUDE.md');
      const cursorrules = path.join(homeDir, '.cursorrules');
      const cursorMdc = path.join(homeDir, '.cursor', 'rules', 'agentrc.mdc');
      const cursorHubMdc = path.join(homeDir, '.cursor', 'rules', 'agenthub.mdc');
      safeWriteFile(cursorHubMdc, '# AgentHub MDC');
      const windsurfrules = path.join(homeDir, '.windsurfrules');
      const windsurfGlobal = path.join(homeDir, '.windsurf', 'memories', 'global_rules.md');
      const scoutClaude = path.join(homeDir, '.claude', 'agents', 'scout.md');
      const implementerClaude = path.join(homeDir, '.claude', 'agents', 'implementer.md');
      const reviewerGemini = path.join(homeDir, '.gemini', 'config', 'agents', 'reviewer.md');

      // Verify projected files exist before uninstall
      expect(fs.existsSync(geminiMd)).toBe(true);
      expect(fs.existsSync(codexAgents)).toBe(true);
      expect(fs.existsSync(claudeMd)).toBe(true);
      expect(fs.existsSync(cursorrules)).toBe(true);
      expect(fs.existsSync(cursorMdc)).toBe(true);
      expect(fs.existsSync(cursorHubMdc)).toBe(true);
      expect(fs.existsSync(windsurfrules)).toBe(true);
      expect(fs.existsSync(windsurfGlobal)).toBe(true);
      expect(fs.existsSync(scoutClaude)).toBe(true);
      expect(fs.existsSync(implementerClaude)).toBe(true);
      expect(fs.existsSync(reviewerGemini)).toBe(true);

      // 3. Uninstall
      const uninstallRes = uninstallHub({ home: homeDir, hub: hubDir });
      expect(uninstallRes.success).toBe(true);

      // Verify all projected files are cleanly removed
      expect(fs.existsSync(geminiMd)).toBe(false);
      expect(fs.existsSync(codexAgents)).toBe(false);
      expect(fs.existsSync(claudeMd)).toBe(false);
      expect(fs.existsSync(cursorrules)).toBe(false);
      expect(fs.existsSync(cursorMdc)).toBe(false);
      expect(fs.existsSync(cursorHubMdc)).toBe(false);
      expect(fs.existsSync(windsurfrules)).toBe(false);
      expect(fs.existsSync(windsurfGlobal)).toBe(false);
      expect(fs.existsSync(scoutClaude)).toBe(false);
      expect(fs.existsSync(implementerClaude)).toBe(false);
      expect(fs.existsSync(reviewerGemini)).toBe(false);
    });

    it('Test 8: Preserves non-agenthub junctions pointing to other directories', () => {
      const otherSkillsDir = path.join(tmpDir, 'other-skills');
      ensureDir(otherSkillsDir);
      safeWriteFile(path.join(otherSkillsDir, 'custom', 'SKILL.md'), '# Custom Skill');

      const claudeSkills = path.join(homeDir, '.claude', 'skills');
      createJunction(otherSkillsDir, claudeSkills);
      expect(isJunctionOrSymlink(claudeSkills)).toBe(true);

      const result = uninstallHub({ home: homeDir, hub: hubDir });
      expect(result.success).toBe(true);
      expect(result.unlinkedJunctions).not.toContain(claudeSkills);
      expect(isJunctionOrSymlink(claudeSkills)).toBe(true);
      expect(fs.existsSync(path.join(claudeSkills, 'custom', 'SKILL.md'))).toBe(true);
    });

    it('Test 9: Restores .gemini/config/GEMINI.md.backup and .gemini/GEMINI.md.backup back to GEMINI.md', () => {
      const geminiConfigDir = path.join(homeDir, '.gemini', 'config');
      ensureDir(geminiConfigDir);

      safeWriteFile(
        path.join(homeDir, '.gemini', 'GEMINI.md'),
        '<!-- AUTOGENERATED BY AGENTRC -->\nautogenerated content'
      );
      safeWriteFile(
        path.join(geminiConfigDir, 'GEMINI.md.backup'),
        '# Original Gemini Config Rules'
      );

      const result = uninstallHub({ home: homeDir, hub: hubDir });
      expect(result.success).toBe(true);

      expect(fs.existsSync(path.join(geminiConfigDir, 'GEMINI.md.backup'))).toBe(false);
      expect(fs.existsSync(path.join(geminiConfigDir, 'GEMINI.md'))).toBe(true);
      expect(fs.readFileSync(path.join(geminiConfigDir, 'GEMINI.md'), 'utf-8')).toBe(
        '# Original Gemini Config Rules'
      );
      expect(fs.existsSync(path.join(homeDir, '.gemini', 'GEMINI.md'))).toBe(false);
    });

    it('Test 10: Refuses to purge home directory or filesystem root', () => {
      expect(() => uninstallHub({ home: homeDir, hub: homeDir, purge: true })).toThrow(
        /refusing to purge hub directory/i
      );

      const rootDir = path.parse(homeDir).root;
      expect(() => uninstallHub({ home: homeDir, hub: rootDir, purge: true })).toThrow(
        /refusing to purge hub directory/i
      );
    });
  });
});
