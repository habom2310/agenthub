import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCustomHome } from '../src/core/detector.js';
import {
  profileCreate,
  profileList,
  profileUse,
} from '../src/core/profile.js';
import { initHub } from '../src/core/scaffold.js';
import { ensureDir, safeWriteFile } from '../src/utils/fs.js';

describe('profile engine (profileList, profileCreate, profileUse)', () => {
  let tmpDir: string;
  let homeDir: string;
  let hubDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-profile-test-'));
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

  describe('profileList', () => {
    it('returns default active profile and list when no profiles directory exists', () => {
      const res = profileList(hubDir);
      expect(res.active).toBe('default');
      expect(res.profiles).toEqual(['default']);
    });

    it('scans profiles directory and reads .active-profile', () => {
      const profilesDir = path.join(hubDir, 'profiles');
      ensureDir(path.join(profilesDir, 'work'));
      ensureDir(path.join(profilesDir, 'personal'));
      safeWriteFile(path.join(hubDir, '.active-profile'), 'work\n');

      const res = profileList(hubDir);
      expect(res.active).toBe('work');
      expect(res.profiles).toContain('work');
      expect(res.profiles).toContain('personal');
    });

    it('ensures default profile is included if active profile is default', () => {
      const profilesDir = path.join(hubDir, 'profiles');
      ensureDir(path.join(profilesDir, 'custom'));
      safeWriteFile(path.join(hubDir, '.active-profile'), 'default\n');

      const res = profileList(hubDir);
      expect(res.active).toBe('default');
      expect(res.profiles).toContain('default');
      expect(res.profiles).toContain('custom');
    });
  });

  describe('profileCreate', () => {
    it('validates profile name matching ^[a-zA-Z0-9_-]+$', () => {
      const invalid = profileCreate('invalid name with spaces', hubDir);
      expect(invalid.success).toBe(false);
      expect(invalid.message).toContain('Invalid profile name');

      const invalidSymbols = profileCreate('work@corp!', hubDir);
      expect(invalidSymbols.success).toBe(false);

      const valid = profileCreate('work_2026-setup', hubDir);
      expect(valid.success).toBe(true);
      expect(valid.name).toBe('work_2026-setup');
    });

    it('snapshots current hub setup into profiles directory', () => {
      // Create custom rule, skill, and mcp in hub
      safeWriteFile(path.join(hubDir, 'rules', 'custom.md'), '# Custom Rule');
      ensureDir(path.join(hubDir, 'skills', 'tester'));
      safeWriteFile(
        path.join(hubDir, 'skills', 'tester', 'SKILL.md'),
        '---\nname: tester\ndescription: Test skill\n---\nBody'
      );
      safeWriteFile(
        path.join(hubDir, 'mcp', 'servers.json'),
        JSON.stringify({ mcpServers: { myServer: { command: 'node' } } })
      );

      const res = profileCreate('work', hubDir);
      expect(res.success).toBe(true);

      const profileDir = path.join(hubDir, 'profiles', 'work');
      expect(fs.existsSync(path.join(profileDir, 'rules', 'custom.md'))).toBe(true);
      expect(fs.existsSync(path.join(profileDir, 'skills', 'tester', 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(profileDir, 'mcp', 'servers.json'))).toBe(true);
      expect(fs.existsSync(path.join(profileDir, 'agenthub.json'))).toBe(true);

      // Excludes .git, .active-profile, profiles/
      expect(fs.existsSync(path.join(profileDir, 'profiles'))).toBe(false);
      expect(fs.existsSync(path.join(profileDir, '.active-profile'))).toBe(false);
    });
  });

  describe('profileUse', () => {
    it('switches between local profiles and automatically snapshots default', () => {
      // 1. Initial hub has base rule
      safeWriteFile(path.join(hubDir, 'rules', 'base.md'), '# Base Rule\n');

      // 2. Create profile 'dev' with unique rule
      ensureDir(path.join(hubDir, 'profiles', 'dev', 'rules'));
      safeWriteFile(path.join(hubDir, 'profiles', 'dev', 'rules', 'dev.md'), '# Dev Rule\n');
      safeWriteFile(
        path.join(hubDir, 'profiles', 'dev', 'mcp', 'servers.json'),
        JSON.stringify({ mcpServers: { devDb: { command: 'docker' } } })
      );

      // 3. Switch to 'dev'
      const useDev = profileUse('dev', { hubDir, homeDir });
      expect(useDev.success).toBe(true);
      expect(useDev.name).toBe('dev');
      expect(useDev.previous).toBe('default');
      expect(useDev.isRemote).toBe(false);

      // Verify default was auto-snapshotted
      expect(fs.existsSync(path.join(hubDir, 'profiles', 'default', 'rules', 'base.md'))).toBe(true);

      // Verify active profile is now 'dev'
      const activeContent = fs.readFileSync(path.join(hubDir, '.active-profile'), 'utf-8').trim();
      expect(activeContent).toBe('dev');

      // Hub now has 'dev.md' and NOT 'base.md'
      expect(fs.existsSync(path.join(hubDir, 'rules', 'dev.md'))).toBe(true);
      expect(fs.existsSync(path.join(hubDir, 'rules', 'base.md'))).toBe(false);

      // Verify MCP was updated
      const hubMcp = JSON.parse(fs.readFileSync(path.join(hubDir, 'mcp', 'servers.json'), 'utf-8'));
      expect(hubMcp.mcpServers.devDb).toBeDefined();

      // 4. Switch back to 'default'
      const useDefault = profileUse('default', { hubDir, homeDir });
      expect(useDefault.success).toBe(true);
      expect(useDefault.name).toBe('default');
      expect(useDefault.previous).toBe('dev');

      expect(fs.existsSync(path.join(hubDir, 'rules', 'base.md'))).toBe(true);
      expect(fs.existsSync(path.join(hubDir, 'rules', 'dev.md'))).toBe(false);
    });

    it('switches to an external package directory target and projects downstream', () => {
      // Create external package fixture
      const fixtureDir = path.join(tmpDir, 'remote-style-pkg');
      ensureDir(fixtureDir);
      safeWriteFile(
        path.join(fixtureDir, 'agenthub.json'),
        JSON.stringify({ name: 'remote-style-pkg', version: '1.0.0' })
      );
      safeWriteFile(path.join(fixtureDir, 'rules.md'), '# Remote Package Universal Rules\n');
      ensureDir(path.join(fixtureDir, 'skills', 'searcher'));
      safeWriteFile(
        path.join(fixtureDir, 'skills', 'searcher', 'SKILL.md'),
        '---\nname: searcher\ndescription: Searches things\n---\nSearch logic\n'
      );

      const res = profileUse(fixtureDir, { hubDir, homeDir });
      expect(res.success).toBe(true);
      expect(res.name).toBe('remote-style-pkg');
      expect(res.isRemote).toBe(true); // resolved via package target resolution

      // Check profile snapshot in hub/profiles
      expect(fs.existsSync(path.join(hubDir, 'profiles', 'remote-style-pkg'))).toBe(true);

      // Check hub updated
      expect(fs.existsSync(path.join(hubDir, 'skills', 'searcher', 'SKILL.md'))).toBe(true);
      const hubCommonMd = path.join(hubDir, 'rules', 'common.md');
      expect(fs.existsSync(hubCommonMd)).toBe(true);
      expect(fs.readFileSync(hubCommonMd, 'utf-8')).toContain('Remote Package Universal Rules');

      // Check projection to Claude / Gemini
      const geminiMd = path.join(homeDir, '.gemini', 'GEMINI.md');
      expect(fs.existsSync(geminiMd)).toBe(true);
      const geminiContent = fs.readFileSync(geminiMd, 'utf-8');
      expect(geminiContent).toContain('Remote Package Universal Rules');
    });

    it('returns error when target profile does not exist and cannot be resolved', () => {
      const res = profileUse('nonexistent-profile-xyz', { hubDir, homeDir });
      expect(res.success).toBe(false);
      expect(res.name).toBe('nonexistent-profile-xyz');
      expect(res.message).toContain('nonexistent-profile-xyz');
    });
  });
});
