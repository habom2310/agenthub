import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import yaml from 'yaml';
import { setCustomHome } from '../src/core/detector.js';
import {
  linkSkillsForClaude,
  linkSkillsForCodex,
  linkSkillsForGemini,
  projectCodexSkillManifests,
} from '../src/core/linker.js';
import { ensureDir, isJunctionOrSymlink, safeWriteFile } from '../src/utils/fs.js';

describe('linker', () => {
  let tmpDir: string;
  let homeDir: string;
  let hubDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-linker-test-'));
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

  describe('linkSkillsForClaude', () => {
    it('creates junction when ~/.claude/skills does not exist', () => {
      const result = linkSkillsForClaude(homeDir, hubDir);
      expect(result.success).toBe(true);

      const claudeSkills = path.join(homeDir, '.claude', 'skills');
      expect(fs.existsSync(claudeSkills)).toBe(true);
      expect(isJunctionOrSymlink(claudeSkills)).toBe(true);
    });

    it('migrates pre-existing skills from real dir ~/.claude/skills to hub and creates skills.old', () => {
      const claudeSkills = path.join(homeDir, '.claude', 'skills');
      safeWriteFile(
        path.join(claudeSkills, 'my-skill', 'SKILL.md'),
        '# Pre-existing Claude Skill'
      );
      safeWriteFile(
        path.join(claudeSkills, 'root-skill.txt'),
        'some root skill'
      );

      const result = linkSkillsForClaude(homeDir, hubDir);
      expect(result.success).toBe(true);

      // Verify migrated to hub
      expect(
        fs.readFileSync(path.join(hubDir, 'skills', 'my-skill', 'SKILL.md'), 'utf-8')
      ).toBe('# Pre-existing Claude Skill');
      expect(
        fs.readFileSync(path.join(hubDir, 'skills', 'root-skill.txt'), 'utf-8')
      ).toBe('some root skill');

      // Verify backup in skills.old
      const skillsOld = path.join(homeDir, '.claude', 'skills.old');
      expect(fs.existsSync(skillsOld)).toBe(true);
      expect(
        fs.existsSync(path.join(skillsOld, 'my-skill', 'SKILL.md'))
      ).toBe(true);

      // Verify claude skills is now a junction
      expect(isJunctionOrSymlink(claudeSkills)).toBe(true);
    });

    it('does not overwrite existing hub files during migration', () => {
      const claudeSkills = path.join(homeDir, '.claude', 'skills');
      safeWriteFile(
        path.join(claudeSkills, 'skill-1', 'version.txt'),
        'claude-v1'
      );
      safeWriteFile(
        path.join(hubDir, 'skills', 'skill-1', 'version.txt'),
        'hub-v2'
      );

      linkSkillsForClaude(homeDir, hubDir);

      expect(
        fs.readFileSync(path.join(hubDir, 'skills', 'skill-1', 'version.txt'), 'utf-8')
      ).toBe('hub-v2');
    });

    it('is idempotent on repeated calls', () => {
      const res1 = linkSkillsForClaude(homeDir, hubDir);
      expect(res1.success).toBe(true);

      const res2 = linkSkillsForClaude(homeDir, hubDir);
      expect(res2.success).toBe(true);

      const claudeSkills = path.join(homeDir, '.claude', 'skills');
      expect(isJunctionOrSymlink(claudeSkills)).toBe(true);
    });

    it('returns error when migration fails during rename', () => {
      const claudeSkills = path.join(homeDir, '.claude', 'skills');
      safeWriteFile(path.join(claudeSkills, 'skill-1', 'SKILL.md'), '# S1');
      const spy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
        throw new Error('EPERM: operation not permitted');
      });
      const res = linkSkillsForClaude(homeDir, hubDir);
      spy.mockRestore();
      expect(res.success).toBe(false);
      expect(res.message).toContain('Failed to migrate skills: EPERM: operation not permitted');
    });
  });

  describe('linkSkillsForGemini', () => {
    it('creates skills.json with resolved posix path when file does not exist', () => {
      const result = linkSkillsForGemini(homeDir, hubDir);
      expect(result.success).toBe(true);

      const skillsJsonPath = path.join(homeDir, '.gemini', 'config', 'skills.json');
      expect(fs.existsSync(skillsJsonPath)).toBe(true);

      const parsed = JSON.parse(fs.readFileSync(skillsJsonPath, 'utf-8'));
      expect(Array.isArray(parsed.entries)).toBe(true);
      expect(parsed.entries.length).toBe(1);

      const expectedPath = path.resolve(hubDir, 'skills').replace(/\\/g, '/');
      expect(parsed.entries[0].path).toBe(expectedPath);
      expect(parsed.entries[0].path.includes('\\')).toBe(false);
    });

    it('updates existing .agenthub, .agentrc, or .claude entry in place', () => {
      const skillsJsonPath = path.join(homeDir, '.gemini', 'config', 'skills.json');
      safeWriteFile(
        skillsJsonPath,
        JSON.stringify({
          entries: [
            { path: '/old/path/.agentrc/skills' },
            { name: 'other-tool', path: '/opt/other' },
          ],
        })
      );

      const result = linkSkillsForGemini(homeDir, hubDir);
      expect(result.success).toBe(true);

      const parsed = JSON.parse(fs.readFileSync(skillsJsonPath, 'utf-8'));
      expect(parsed.entries.length).toBe(2);

      const expectedPath = path.resolve(hubDir, 'skills').replace(/\\/g, '/');
      expect(parsed.entries[0].path).toBe(expectedPath);
      expect(parsed.entries[1].path).toBe('/opt/other');
    });

    it('is idempotent on repeated calls', () => {
      linkSkillsForGemini(homeDir, hubDir);
      linkSkillsForGemini(homeDir, hubDir);

      const skillsJsonPath = path.join(homeDir, '.gemini', 'config', 'skills.json');
      const parsed = JSON.parse(fs.readFileSync(skillsJsonPath, 'utf-8'));
      expect(parsed.entries.length).toBe(1);
    });

    it('refuses to overwrite corrupt or invalid skills.json', () => {
      const skillsJsonPath = path.join(homeDir, '.gemini', 'config', 'skills.json');
      safeWriteFile(skillsJsonPath, '{ corrupt json');

      const res = linkSkillsForGemini(homeDir, hubDir);
      expect(res.success).toBe(false);
      expect(res.message).toContain('Refusing to overwrite invalid or corrupt skills.json');
      expect(fs.readFileSync(skillsJsonPath, 'utf-8')).toBe('{ corrupt json');
    });

    it('refuses to overwrite non-object skills.json (e.g. array)', () => {
      const skillsJsonPath = path.join(homeDir, '.gemini', 'config', 'skills.json');
      safeWriteFile(skillsJsonPath, '["entry1", "entry2"]');

      const res = linkSkillsForGemini(homeDir, hubDir);
      expect(res.success).toBe(false);
      expect(res.message).toContain('Refusing to overwrite invalid or corrupt skills.json');
      expect(fs.readFileSync(skillsJsonPath, 'utf-8')).toBe('["entry1", "entry2"]');
    });
  });

  describe('linkSkillsForCodex', () => {
    it('fails gracefully when ~/.codex does not exist', () => {
      const result = linkSkillsForCodex(homeDir, hubDir);
      expect(result.success).toBe(false);
      expect(result.message).toBe('~/.codex directory does not exist');
    });

    it('links skills when ~/.codex exists and migrates pre-existing real dir', () => {
      const codexDir = path.join(homeDir, '.codex');
      const codexSkills = path.join(codexDir, 'skills');
      safeWriteFile(
        path.join(codexSkills, 'codex-skill', 'SKILL.md'),
        '---\nname: codex-skill\ndescription: A Codex test skill.\n---\n# Codex Skill'
      );

      const result = linkSkillsForCodex(homeDir, hubDir);
      expect(result.success).toBe(true);

      // Migrated to hub
      expect(fs.existsSync(path.join(hubDir, 'skills', 'codex-skill', 'SKILL.md'))).toBe(true);

      // skills.old created
      expect(fs.existsSync(path.join(codexDir, 'skills.old'))).toBe(true);

      // codex/skills is junction
      expect(isJunctionOrSymlink(codexSkills)).toBe(true);

      // openai.yaml projected
      const manifestPath = path.join(hubDir, 'skills', 'codex-skill', 'agents', 'openai.yaml');
      expect(fs.existsSync(manifestPath)).toBe(true);
    });

    it('returns error when Codex skills migration fails during rename', () => {
      const codexDir = path.join(homeDir, '.codex');
      const codexSkills = path.join(codexDir, 'skills');
      safeWriteFile(path.join(codexSkills, 'skill-1', 'SKILL.md'), '# S1');
      const spy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
        throw new Error('EPERM: operation not permitted');
      });
      const res = linkSkillsForCodex(homeDir, hubDir);
      spy.mockRestore();
      expect(res.success).toBe(false);
      expect(res.message).toContain('Failed to migrate skills: EPERM: operation not permitted');
    });
  });

  describe('projectCodexSkillManifests', () => {
    it('generates openai.yaml for skills without existing manifest', () => {
      safeWriteFile(
        path.join(hubDir, 'skills', 'my-tool', 'SKILL.md'),
        '---\nname: my-tool\ndescription: Does awesome things with code. Second sentence.\n---\n# My Tool'
      );

      const result = projectCodexSkillManifests(hubDir);
      expect(result.success).toBe(true);

      const manifestPath = path.join(hubDir, 'skills', 'my-tool', 'agents', 'openai.yaml');
      expect(fs.existsSync(manifestPath)).toBe(true);

      const content = fs.readFileSync(manifestPath, 'utf-8');
      const parsed = yaml.parse(content);

      expect(parsed.interface.display_name).toBe('My Tool');
      expect(parsed.interface.short_description).toBe('Does awesome things with code.');
      expect(parsed.interface.default_prompt).toBe('Use my-tool skill for this task.');
    });

    it('truncates short_description to 80 chars if first sentence is longer', () => {
      const longSentence = 'A'.repeat(120) + '.';
      safeWriteFile(
        path.join(hubDir, 'skills', 'long-desc', 'SKILL.md'),
        `---\nname: long-desc\ndescription: ${longSentence}\n---\n# Long`
      );

      projectCodexSkillManifests(hubDir);

      const manifestPath = path.join(hubDir, 'skills', 'long-desc', 'agents', 'openai.yaml');
      const parsed = yaml.parse(fs.readFileSync(manifestPath, 'utf-8'));
      expect(parsed.interface.short_description.length).toBeLessThanOrEqual(80);
      expect(parsed.interface.short_description).toBe('A'.repeat(80));
    });

    it('does not overwrite existing openai.yaml', () => {
      const manifestPath = path.join(hubDir, 'skills', 'custom', 'agents', 'openai.yaml');
      safeWriteFile(manifestPath, 'custom: manifest\n');

      safeWriteFile(
        path.join(hubDir, 'skills', 'custom', 'SKILL.md'),
        '---\nname: custom\ndescription: desc\n---\n# Custom'
      );

      projectCodexSkillManifests(hubDir);

      expect(fs.readFileSync(manifestPath, 'utf-8')).toBe('custom: manifest\n');
    });

    it('handles skills without frontmatter using directory name', () => {
      safeWriteFile(
        path.join(hubDir, 'skills', 'plain-skill', 'SKILL.md'),
        '# Plain skill without frontmatter'
      );

      projectCodexSkillManifests(hubDir);

      const manifestPath = path.join(hubDir, 'skills', 'plain-skill', 'agents', 'openai.yaml');
      const parsed = yaml.parse(fs.readFileSync(manifestPath, 'utf-8'));
      expect(parsed.interface.display_name).toBe('Plain Skill');
      expect(parsed.interface.default_prompt).toBe('Use plain-skill skill for this task.');
    });
  });
});
