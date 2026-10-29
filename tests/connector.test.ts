import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectCursor,
  connectPlatform,
  connectWindsurf,
  updateHubManifest,
} from '../src/core/connector.js';
import { setCustomHome } from '../src/core/detector.js';
import { ensureDir, isJunctionOrSymlink, safeWriteFile } from '../src/utils/fs.js';

describe('connector', () => {
  let tmpDir: string;
  let homeDir: string;
  let hubDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-connector-test-'));
    homeDir = path.join(tmpDir, 'home');
    hubDir = path.join(tmpDir, 'hub');
    ensureDir(homeDir);
    ensureDir(hubDir);
    setCustomHome(homeDir, hubDir);

    // Seed minimal hub manifest
    safeWriteFile(
      path.join(hubDir, 'agenthub.json'),
      JSON.stringify(
        {
          version: '0.1.0',
          platforms: {},
        },
        null,
        2
      )
    );

    // Seed rules files in hub
    const rules = [
      'common.md',
      'code-tools.md',
      'handoffs.md',
      'overrides/cursor.md',
      'overrides/windsurf.md',
      'overrides/codex.md',
      'overrides/claude.md',
      'overrides/agy.md',
    ];
    for (const rule of rules) {
      safeWriteFile(path.join(hubDir, 'rules', rule), `# Rule: ${rule}`);
    }
  });

  afterEach(() => {
    setCustomHome(null, null);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe('updateHubManifest', () => {
    it('updates agenthub.json with platform information', () => {
      updateHubManifest('cursor', { enabled: true, testProp: 123 }, hubDir);

      const data = JSON.parse(
        fs.readFileSync(path.join(hubDir, 'agenthub.json'), 'utf-8')
      );
      expect(data.platforms.cursor).toEqual({ enabled: true, testProp: 123 });
    });

    it('handles gracefully if manifest does not exist', () => {
      fs.unlinkSync(path.join(hubDir, 'agenthub.json'));
      expect(() => {
        updateHubManifest('cursor', { enabled: true }, hubDir);
      }).not.toThrow();
    });
  });

  describe('connectCursor', () => {
    it('creates skills junction, projects rules, and updates manifest', () => {
      const res = connectCursor(undefined, homeDir, hubDir);
      expect(res.success).toBe(true);
      expect(res.message).toContain('Connected Cursor');

      const cursorDir = path.join(homeDir, '.cursor');
      const cursorSkills = path.join(cursorDir, 'skills');
      expect(fs.existsSync(cursorSkills)).toBe(true);
      expect(isJunctionOrSymlink(cursorSkills)).toBe(true);

      const mdcFile = path.join(cursorDir, 'rules', 'agenthub.mdc');
      expect(fs.existsSync(mdcFile)).toBe(true);
      const mdcContent = fs.readFileSync(mdcFile, 'utf-8');
      expect(mdcContent).toContain('Global multi-assistant heuristics');

      const legacyRules = path.join(homeDir, '.cursorrules');
      expect(fs.existsSync(legacyRules)).toBe(true);

      const manifest = JSON.parse(
        fs.readFileSync(path.join(hubDir, 'agenthub.json'), 'utf-8')
      );
      expect(manifest.platforms.cursor.enabled).toBe(true);
      expect(manifest.platforms.cursor.path).toBe(cursorDir);
      expect(manifest.platforms.cursor.rules_file).toBe(mdcFile);
      expect(manifest.platforms.cursor.connected_at).toBeDefined();
    });

    it('supports custom targetDir for Cursor', () => {
      const customCursorDir = path.join(homeDir, 'custom-cursor');
      const res = connectCursor(customCursorDir, homeDir, hubDir);
      expect(res.success).toBe(true);

      const cursorSkills = path.join(customCursorDir, 'skills');
      expect(fs.existsSync(cursorSkills)).toBe(true);
      expect(isJunctionOrSymlink(cursorSkills)).toBe(true);

      const mdcFile = path.join(customCursorDir, 'rules', 'agenthub.mdc');
      expect(fs.existsSync(mdcFile)).toBe(true);

      const manifest = JSON.parse(
        fs.readFileSync(path.join(hubDir, 'agenthub.json'), 'utf-8')
      );
      expect(manifest.platforms.cursor.path).toBe(customCursorDir);
    });
  });

  describe('connectWindsurf', () => {
    it('creates skills junction, projects rules, and updates manifest', () => {
      const res = connectWindsurf(undefined, homeDir, hubDir);
      expect(res.success).toBe(true);
      expect(res.message).toContain('Connected Windsurf');

      const windsurfDir = path.join(homeDir, '.windsurf');
      const windsurfSkills = path.join(windsurfDir, 'skills');
      expect(fs.existsSync(windsurfSkills)).toBe(true);
      expect(isJunctionOrSymlink(windsurfSkills)).toBe(true);

      const globalRules = path.join(windsurfDir, 'memories', 'global_rules.md');
      expect(fs.existsSync(globalRules)).toBe(true);

      const legacyRules = path.join(homeDir, '.windsurfrules');
      expect(fs.existsSync(legacyRules)).toBe(true);

      const manifest = JSON.parse(
        fs.readFileSync(path.join(hubDir, 'agenthub.json'), 'utf-8')
      );
      expect(manifest.platforms.windsurf.enabled).toBe(true);
      expect(manifest.platforms.windsurf.path).toBe(windsurfDir);
      expect(manifest.platforms.windsurf.rules_file).toBe(globalRules);
      expect(manifest.platforms.windsurf.connected_at).toBeDefined();
    });

    it('prefers .codeium/windsurf if it exists', () => {
      const codeiumDir = path.join(homeDir, '.codeium', 'windsurf');
      ensureDir(codeiumDir);

      const res = connectWindsurf(undefined, homeDir, hubDir);
      expect(res.success).toBe(true);

      const windsurfSkills = path.join(codeiumDir, 'skills');
      expect(fs.existsSync(windsurfSkills)).toBe(true);
      expect(isJunctionOrSymlink(windsurfSkills)).toBe(true);

      const manifest = JSON.parse(
        fs.readFileSync(path.join(hubDir, 'agenthub.json'), 'utf-8')
      );
      expect(manifest.platforms.windsurf.path).toBe(codeiumDir);
    });
  });

  describe('skills migration', () => {
    it('migrates pre-existing skills from Cursor to hub and renames old dir to skills.old', () => {
      const cursorDir = path.join(homeDir, '.cursor');
      const cursorSkills = path.join(cursorDir, 'skills');
      safeWriteFile(
        path.join(cursorSkills, 'pre-skill', 'SKILL.md'),
        '# Pre-existing skill in cursor'
      );
      safeWriteFile(
        path.join(cursorSkills, 'root-note.txt'),
        'root note in skills'
      );

      const res = connectCursor(cursorDir, homeDir, hubDir);
      expect(res.success).toBe(true);

      // Verify copied to hub
      expect(
        fs.readFileSync(
          path.join(hubDir, 'skills', 'pre-skill', 'SKILL.md'),
          'utf-8'
        )
      ).toBe('# Pre-existing skill in cursor');
      expect(
        fs.readFileSync(path.join(hubDir, 'skills', 'root-note.txt'), 'utf-8')
      ).toBe('root note in skills');

      // Verify backup in skills.old
      const skillsOld = path.join(cursorDir, 'skills.old');
      expect(fs.existsSync(skillsOld)).toBe(true);
      expect(
        fs.existsSync(path.join(skillsOld, 'pre-skill', 'SKILL.md'))
      ).toBe(true);

      // Verify cursorSkills is now junction
      expect(isJunctionOrSymlink(cursorSkills)).toBe(true);
    });

    it('keeps the first Cursor skills.old when linking a second time', () => {
      const cursorDir = path.join(homeDir, '.cursor');
      const cursorSkills = path.join(cursorDir, 'skills');
      safeWriteFile(path.join(cursorSkills, 'marker.txt'), 'first');
      expect(connectCursor(cursorDir, homeDir, hubDir).success).toBe(true);

      fs.rmSync(cursorSkills, { recursive: true, force: true });
      safeWriteFile(path.join(cursorSkills, 'marker.txt'), 'second');
      expect(connectCursor(cursorDir, homeDir, hubDir).success).toBe(true);

      expect(
        fs.readFileSync(path.join(cursorDir, 'skills.old', 'marker.txt'), 'utf-8')
      ).toBe('first');
      const stamped = fs
        .readdirSync(cursorDir)
        .filter((name) => name.startsWith('skills.old.'));
      expect(stamped).toHaveLength(1);
      expect(stamped[0]).toMatch(/^skills\.old\.\d{8}_\d{6}Z$/);
      expect(
        fs.readFileSync(path.join(cursorDir, stamped[0], 'marker.txt'), 'utf-8')
      ).toBe('second');
      expect(isJunctionOrSymlink(cursorSkills)).toBe(true);
    });

    it('migrates pre-existing skills from Windsurf to hub and renames old dir to skills.old', () => {
      const windsurfDir = path.join(homeDir, '.windsurf');
      const windsurfSkills = path.join(windsurfDir, 'skills');
      safeWriteFile(
        path.join(windsurfSkills, 'windsurf-skill', 'SKILL.md'),
        '# Windsurf skill'
      );

      const res = connectWindsurf(windsurfDir, homeDir, hubDir);
      expect(res.success).toBe(true);

      expect(
        fs.existsSync(
          path.join(hubDir, 'skills', 'windsurf-skill', 'SKILL.md')
        )
      ).toBe(true);

      const skillsOld = path.join(windsurfDir, 'skills.old');
      expect(fs.existsSync(skillsOld)).toBe(true);
      expect(isJunctionOrSymlink(windsurfSkills)).toBe(true);
    });

    it('returns error when Cursor skills migration fails during rename', () => {
      const cursorDir = path.join(homeDir, '.cursor');
      const cursorSkills = path.join(cursorDir, 'skills');
      safeWriteFile(path.join(cursorSkills, 'pre-skill', 'SKILL.md'), '# Pre');
      const spy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
        throw new Error('EPERM: operation not permitted');
      });
      const res = connectCursor(cursorDir, homeDir, hubDir);
      spy.mockRestore();
      expect(res.success).toBe(false);
      expect(res.message).toContain('Failed to migrate skills: EPERM: operation not permitted');
    });

    it('returns error when Windsurf skills migration fails during rename', () => {
      const windsurfDir = path.join(homeDir, '.windsurf');
      const windsurfSkills = path.join(windsurfDir, 'skills');
      safeWriteFile(path.join(windsurfSkills, 'pre-skill', 'SKILL.md'), '# Pre');
      const spy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
        throw new Error('EPERM: operation not permitted');
      });
      const res = connectWindsurf(windsurfDir, homeDir, hubDir);
      spy.mockRestore();
      expect(res.success).toBe(false);
      expect(res.message).toContain('Failed to migrate skills: EPERM: operation not permitted');
    });
  });

  describe('connectPlatform', () => {
    it('validates --target-dir is allowed only for cursor and windsurf', () => {
      const customDir = path.join(homeDir, 'custom-loc');

      const resCursor = connectPlatform('cursor', customDir, homeDir, hubDir);
      expect(resCursor.success).toBe(true);

      const resWindsurf = connectPlatform('windsurf', customDir, homeDir, hubDir);
      expect(resWindsurf.success).toBe(true);

      const resCodeium = connectPlatform('codeium', customDir, homeDir, hubDir);
      expect(resCodeium.success).toBe(true);

      const resClaude = connectPlatform('claude', customDir, homeDir, hubDir);
      expect(resClaude.success).toBe(false);
      expect(resClaude.message).toBe(
        "Custom --target-dir is not supported for 'claude'. It is only supported for 'cursor' and 'windsurf'."
      );

      const resGemini = connectPlatform('gemini', customDir, homeDir, hubDir);
      expect(resGemini.success).toBe(false);
      expect(resGemini.message).toBe(
        "Custom --target-dir is not supported for 'gemini'. It is only supported for 'cursor' and 'windsurf'."
      );

      const resCodex = connectPlatform('codex', customDir, homeDir, hubDir);
      expect(resCodex.success).toBe(false);
      expect(resCodex.message).toBe(
        "Custom --target-dir is not supported for 'codex'. It is only supported for 'cursor' and 'windsurf'."
      );
    });

    it('connects Codex platform via chatgpt alias', () => {
      ensureDir(path.join(homeDir, '.codex'));
      const res = connectPlatform('chatgpt', undefined, homeDir, hubDir);
      expect(res.success).toBe(true);

      expect(isJunctionOrSymlink(path.join(homeDir, '.codex', 'skills'))).toBe(true);
      expect(fs.existsSync(path.join(homeDir, '.codex', 'AGENTS.md'))).toBe(true);

      const manifest = JSON.parse(
        fs.readFileSync(path.join(hubDir, 'agenthub.json'), 'utf-8')
      );
      expect(manifest.platforms.codex.enabled).toBe(true);
    });

    it('connects Claude platform via claudecode alias', () => {
      const res = connectPlatform('claudecode', undefined, homeDir, hubDir);
      expect(res.success).toBe(true);

      expect(isJunctionOrSymlink(path.join(homeDir, '.claude', 'skills'))).toBe(true);
      expect(fs.existsSync(path.join(homeDir, '.claude', 'CLAUDE.md'))).toBe(true);

      const manifest = JSON.parse(
        fs.readFileSync(path.join(hubDir, 'agenthub.json'), 'utf-8')
      );
      expect(manifest.platforms.claude.enabled).toBe(true);
    });

    it('connects Gemini platform via agy and antigravity aliases', () => {
      const res = connectPlatform('agy', undefined, homeDir, hubDir);
      expect(res.success).toBe(true);

      expect(
        fs.existsSync(path.join(homeDir, '.gemini', 'config', 'skills.json'))
      ).toBe(true);
      expect(fs.existsSync(path.join(homeDir, '.gemini', 'GEMINI.md'))).toBe(true);

      const manifest = JSON.parse(
        fs.readFileSync(path.join(hubDir, 'agenthub.json'), 'utf-8')
      );
      expect(manifest.platforms.antigravity.enabled).toBe(true);
    });

    it('rejects unsupported platform with clear message', () => {
      const res = connectPlatform('unknown-bot', undefined, homeDir, hubDir);
      expect(res.success).toBe(false);
      expect(res.message).toBe(
        "Unsupported platform 'unknown-bot'. Supported: cursor, windsurf, codex, claude, gemini"
      );
    });

    it('does not set enabled: true in manifest when platform connection fails', () => {
      // Codex directory does not exist, so connectPlatform('codex') will fail
      const resCodex = connectPlatform('codex', undefined, homeDir, hubDir);
      expect(resCodex.success).toBe(false);

      const manifest1 = JSON.parse(
        fs.readFileSync(path.join(hubDir, 'agenthub.json'), 'utf-8')
      );
      expect(manifest1.platforms?.codex).toBeUndefined();

      // Gemini skills.json is corrupt, so connectPlatform('gemini') will fail
      const geminiSkillsPath = path.join(homeDir, '.gemini', 'config', 'skills.json');
      safeWriteFile(geminiSkillsPath, '{ corrupt json');

      const resGemini = connectPlatform('gemini', undefined, homeDir, hubDir);
      expect(resGemini.success).toBe(false);

      const manifest2 = JSON.parse(
        fs.readFileSync(path.join(hubDir, 'agenthub.json'), 'utf-8')
      );
      expect(manifest2.platforms?.antigravity).toBeUndefined();
    });
  });
});
