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

    it('keeps the consumer\'s links and platforms when using a shared package', () => {
      const manifestPath = path.join(hubDir, 'agenthub.json');
      const own = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      own.platforms.cursor = { enabled: true, path: path.join(homeDir, 'my-cursor') };
      own.name = 'my-own-hub';
      own.description = 'mine';
      safeWriteFile(manifestPath, JSON.stringify(own, null, 2));

      const fixtureDir = path.join(tmpDir, 'author-pkg');
      safeWriteFile(
        path.join(fixtureDir, 'agenthub.json'),
        JSON.stringify({
          name: 'author-pkg',
          version: '2.0.0',
          type: 'profile',
          tags: ['typescript'],
          license: 'Apache-2.0',
          platforms: { claude: { enabled: false }, cursor: { enabled: false } },
          links: { skills: '/Users/author/.agenthub/skills' },
        })
      );
      safeWriteFile(path.join(fixtureDir, 'rules.md'), '# Author Rules\n');

      const res = profileUse(fixtureDir, { hubDir, homeDir });
      expect(res.success).toBe(true);

      const after = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      expect(after.links).toEqual(own.links);
      expect(after.platforms).toEqual(own.platforms);
      expect(after.created_at).toBe(own.created_at);
      expect(after.name).toBe('author-pkg');
      expect(after.version).toBe('2.0.0');
      expect(after.type).toBe('profile');
      expect(after.tags).toEqual(['typescript']);
      expect(after.license).toBe('Apache-2.0');
      // the author's package has no description, so the consumer's is not left behind
      expect(after.description).toBeUndefined();
    });

    it('keeps the current links and platforms when switching back to a local profile', () => {
      const manifestPath = path.join(hubDir, 'agenthub.json');
      const fixtureDir = path.join(tmpDir, 'author-pkg');
      safeWriteFile(
        path.join(fixtureDir, 'agenthub.json'),
        JSON.stringify({ name: 'author-pkg', links: { skills: '/Users/author/.agenthub/skills' } })
      );
      safeWriteFile(path.join(fixtureDir, 'rules.md'), '# Author Rules\n');
      expect(profileUse(fixtureDir, { hubDir, homeDir }).success).toBe(true);

      // machine state changes while on the shared profile (e.g. agenthub connect cursor)
      const current = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      current.platforms.windsurf = { enabled: true };
      safeWriteFile(manifestPath, JSON.stringify(current, null, 2));

      expect(profileUse('default', { hubDir, homeDir }).success).toBe(true);
      const after = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      expect(after.platforms.windsurf).toEqual({ enabled: true });
      expect(after.links).toEqual(current.links);
      expect(after.name).toBeUndefined();
    });

    it('returns error when target profile does not exist and cannot be resolved', () => {
      const res = profileUse('nonexistent-profile-xyz', { hubDir, homeDir });
      expect(res.success).toBe(false);
      expect(res.name).toBe('nonexistent-profile-xyz');
      expect(res.message).toContain('nonexistent-profile-xyz');
    });
  });
});
