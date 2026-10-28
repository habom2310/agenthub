import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectPlatforms,
  getHomeDir,
  getHubDir,
  setCustomHome,
} from '../src/core/detector.js';
import { createJunction, ensureDir, safeWriteFile } from '../src/utils/fs.js';

describe('detector', () => {
  let tmpDir: string;
  let homeDir: string;
  let hubDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-detector-test-'));
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

  describe('directory resolution & overrides', () => {
    it('uses custom override if set', () => {
      expect(getHomeDir()).toBe(homeDir);
      expect(getHubDir()).toBe(hubDir);
    });

    it('falls back to AGENTHUB environment variables when override is unset', () => {
      setCustomHome(null, null);
      const originalHome = process.env.AGENTHUB_HOME;
      const originalHub = process.env.AGENTHUB_HUB;

      try {
        process.env.AGENTHUB_HOME = path.join(tmpDir, 'env-home');
        process.env.AGENTHUB_HUB = path.join(tmpDir, 'env-hub');

        expect(getHomeDir()).toBe(path.join(tmpDir, 'env-home'));
        expect(getHubDir()).toBe(path.join(tmpDir, 'env-hub'));
      } finally {
        if (originalHome !== undefined) process.env.AGENTHUB_HOME = originalHome;
        else delete process.env.AGENTHUB_HOME;
        if (originalHub !== undefined) process.env.AGENTHUB_HUB = originalHub;
        else delete process.env.AGENTHUB_HUB;
      }
    });

    it('defaults to os.homedir() and .agenthub when no overrides or env vars are set', () => {
      setCustomHome(null, null);
      const origHubHome = process.env.AGENTHUB_HOME;
      const origHubHub = process.env.AGENTHUB_HUB;

      delete process.env.AGENTHUB_HOME;
      delete process.env.AGENTHUB_HUB;

      try {
        expect(getHomeDir()).toBe(os.homedir());
        expect(getHubDir()).toBe(path.join(os.homedir(), '.agenthub'));
      } finally {
        if (origHubHome !== undefined) process.env.AGENTHUB_HOME = origHubHome;
        if (origHubHub !== undefined) process.env.AGENTHUB_HUB = origHubHub;
      }
    });
  });

  describe('detectPlatforms', () => {
    it('detects empty hub status correctly', () => {
      const res = detectPlatforms();
      expect(res.hub.path).toBe(hubDir);
      expect(res.hub.exists).toBe(true);
      expect(res.hub.manifest_exists).toBe(false);
      expect(res.hub.skills_count).toBe(0);
      expect(res.hub.rules_count).toBe(0);
      expect(res.platforms.antigravity.detected).toBe(false);
      expect(res.platforms.claude.detected).toBe(false);
      expect(res.platforms.cursor.detected).toBe(false);
    });

    it('detects hub manifest and content counts', () => {
      safeWriteFile(path.join(hubDir, 'agenthub.json'), JSON.stringify({ version: '0.1.0' }));
      safeWriteFile(path.join(hubDir, 'rules', 'common.md'), '# Common');
      safeWriteFile(path.join(hubDir, 'rules', 'code.md'), '# Code');
      safeWriteFile(path.join(hubDir, 'rules', 'notes.txt'), 'not markdown');
      ensureDir(path.join(hubDir, 'skills', 'skill-1'));
      ensureDir(path.join(hubDir, 'skills', 'skill-2'));

      const res = detectPlatforms();
      expect(res.hub.manifest_exists).toBe(true);
      expect(res.hub.rules_count).toBe(2);
      expect(res.hub.skills_count).toBe(2);
    });

    it('detects Antigravity platform configurations', () => {
      const geminiDir = path.join(homeDir, '.gemini');
      safeWriteFile(path.join(geminiDir, 'GEMINI.md'), '# Gemini Rules');
      safeWriteFile(path.join(geminiDir, 'config', 'hooks.json'), '{}');
      safeWriteFile(path.join(geminiDir, 'config', 'agents', 'implementer.md'), '# Agent');
      safeWriteFile(path.join(geminiDir, 'config', 'agents', 'reviewer.md'), '# Agent');

      // Test skills.json linking
      const skillsConfig = {
        entries: [{ name: 'test', path: 'C:/Users/user/.agenthub/skills/test' }],
      };
      safeWriteFile(path.join(geminiDir, 'config', 'skills.json'), JSON.stringify(skillsConfig));

      const res = detectPlatforms();
      const agy = res.platforms.antigravity;
      expect(agy.detected).toBe(true);
      expect(agy.rules_exists).toBe(true);
      expect(agy.hooks_exists).toBe(true);
      expect(agy.skills_json_exists).toBe(true);
      expect(agy.skills_linked).toBe(true);
      expect(agy.agents_count).toBe(2);
    });

    it('detects Claude Code platform and skills junction', () => {
      const claudeDir = path.join(homeDir, '.claude');
      safeWriteFile(path.join(claudeDir, 'CLAUDE.md'), '# Claude');
      safeWriteFile(path.join(claudeDir, 'settings.json'), '{}');
      safeWriteFile(path.join(claudeDir, 'agents', 'scout.md'), '# Scout');

      const hubSkills = path.join(hubDir, 'skills');
      ensureDir(hubSkills);
      const claudeSkills = path.join(claudeDir, 'skills');
      createJunction(hubSkills, claudeSkills);

      const res = detectPlatforms();
      const claude = res.platforms.claude;
      expect(claude.detected).toBe(true);
      expect(claude.rules_exists).toBe(true);
      expect(claude.settings_exists).toBe(true);
      expect(claude.skills_exists).toBe(true);
      expect(claude.skills_is_junction).toBe(true);
      expect(claude.skills_linked).toBe(true);
      expect(claude.agents_count).toBe(1);
    });

    it('detects Codex CLI platform and configurations', () => {
      const codexDir = path.join(homeDir, '.codex');
      safeWriteFile(path.join(codexDir, 'AGENTS.md'), '# Codex');
      safeWriteFile(path.join(codexDir, 'config.toml'), 'model = "gpt-4"');

      const hubSkills = path.join(hubDir, 'skills');
      ensureDir(hubSkills);
      createJunction(hubSkills, path.join(codexDir, 'skills'));

      const res = detectPlatforms();
      const codex = res.platforms.codex;
      expect(codex.detected).toBe(true);
      expect(codex.rules_exists).toBe(true);
      expect(codex.config_exists).toBe(true);
      expect(codex.skills_exists).toBe(true);
      expect(codex.skills_linked).toBe(true);
    });

    it('detects Cursor with agenthub.mdc rules', () => {
      const cursorDir = path.join(homeDir, '.cursor');
      safeWriteFile(path.join(cursorDir, 'rules', 'agenthub.mdc'), '# Rules');
      const hubSkills = path.join(hubDir, 'skills');
      ensureDir(hubSkills);
      createJunction(hubSkills, path.join(cursorDir, 'skills'));

      const res = detectPlatforms();
      const cursor = res.platforms.cursor;
      expect(cursor.detected).toBe(true);
      expect(cursor.rules_exists).toBe(true);
      expect(cursor.skills_linked).toBe(true);
    });

    it('detects Cursor with legacy .cursorrules', () => {
      const cursorDir = path.join(homeDir, '.cursor');
      ensureDir(cursorDir);
      safeWriteFile(path.join(homeDir, '.cursorrules'), '# Legacy Rules');

      const res = detectPlatforms();
      const cursor = res.platforms.cursor;
      expect(cursor.detected).toBe(true);
      expect(cursor.rules_exists).toBe(true);
    });

    it('detects Windsurf with codeium dir and global rules', () => {
      const wsDir = path.join(homeDir, '.codeium', 'windsurf');
      safeWriteFile(path.join(wsDir, 'memories', 'global_rules.md'), '# WS Rules');

      const res = detectPlatforms();
      const ws = res.platforms.windsurf;
      expect(ws.detected).toBe(true);
      expect(ws.rules_exists).toBe(true);
      expect(ws.path).toBe(wsDir);
    });

    it('detects Windsurf with fallback .windsurf directory', () => {
      const wsDir = path.join(homeDir, '.windsurf');
      safeWriteFile(path.join(wsDir, 'memories', 'global_rules.md'), '# WS Rules');

      const res = detectPlatforms();
      const ws = res.platforms.windsurf;
      expect(ws.detected).toBe(true);
      expect(ws.rules_exists).toBe(true);
      expect(ws.path).toBe(wsDir);
    });

    it('detects Windsurf with legacy .windsurfrules', () => {
      const wsDir = path.join(homeDir, '.windsurf');
      ensureDir(wsDir);
      safeWriteFile(path.join(homeDir, '.windsurfrules'), '# Legacy WS');

      const res = detectPlatforms();
      const ws = res.platforms.windsurf;
      expect(ws.detected).toBe(true);
      expect(ws.rules_exists).toBe(true);
    });

    it('includes copilot platform report', () => {
      const res = detectPlatforms();
      expect(res.platforms.copilot).toBeDefined();
      expect(typeof res.platforms.copilot.detected).toBe('boolean');
    });
  });
});
