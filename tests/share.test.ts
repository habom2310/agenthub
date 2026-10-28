import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCustomHome } from '../src/core/detector.js';
import { gitInitHub } from '../src/core/git-sync.js';
import { initHub } from '../src/core/scaffold.js';
import { extractRepoShorthand, shareSetup } from '../src/core/share.js';
import { ensureDir, safeWriteFile } from '../src/utils/fs.js';

describe('share engine (shareSetup & extractRepoShorthand)', () => {
  let tmpDir: string;
  let homeDir: string;
  let hubDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-share-test-'));
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

  describe('extractRepoShorthand', () => {
    it('extracts owner/repo from https and git URLs', () => {
      expect(extractRepoShorthand('https://github.com/alice/agent-setup.git')).toBe('alice/agent-setup');
      expect(extractRepoShorthand('https://github.com/alice/agent-setup')).toBe('alice/agent-setup');
      expect(extractRepoShorthand('git@github.com:bob/my-hub.git')).toBe('bob/my-hub');
      expect(extractRepoShorthand('https://gitlab.com/team/shared-prompts.git')).toBe('team/shared-prompts');
      expect(extractRepoShorthand('https://custom-git.internal/repo.git')).toBeUndefined();
      expect(extractRepoShorthand('')).toBeUndefined();
    });
  });

  describe('shareSetup validation and git checks', () => {
    it('returns error when git repository or remote is not configured', () => {
      // Hub has no git initialized
      const res = shareSetup({ hubDir });
      expect(res.success).toBe(false);
      expect(res.message).toContain('Git remote not configured');
    });

    it('returns error when git is initialized but remote origin is missing', () => {
      gitInitHub(hubDir);
      const res = shareSetup({ hubDir });
      expect(res.success).toBe(false);
      expect(res.message).toContain('Git remote not configured');
    });

    it('blocks sharing when hardcoded secret is detected in scripts', () => {
      gitInitHub(hubDir);
      // Add fake remote
      spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/alice/agent-setup.git'], {
        cwd: hubDir,
      });

      // Inject a script with leaked GitHub secret
      const scriptPath = path.join(hubDir, 'skills', 'deployer', 'scripts', 'run.sh');
      safeWriteFile(
        scriptPath,
        '#!/bin/bash\nexport GITHUB_TOKEN="ghp_123456789012345678901234567890123456"\n'
      );

      const res = shareSetup({ hubDir });
      expect(res.success).toBe(false);
      expect(res.message).toContain('Security check failed');
      expect(res.warnings.some((w) => w.includes('Hardcoded secret'))).toBe(true);
    });

    it('allows sharing with --force even if secret or high-risk script is detected', () => {
      // Set up a local bare remote to accept the push
      const bareRemote = path.join(tmpDir, 'remote.git');
      spawnSync('git', ['init', '--bare', bareRemote]);

      gitInitHub(hubDir, bareRemote);

      // Inject a script with high-risk command
      const scriptPath = path.join(hubDir, 'skills', 'danger', 'scripts', 'run.sh');
      safeWriteFile(
        scriptPath,
        '#!/bin/bash\nexport GITHUB_TOKEN="ghp_123456789012345678901234567890123456"\n'
      );

      const res = shareSetup({ hubDir, force: true });
      expect(res.success).toBe(true);
      expect(res.warnings.length).toBeGreaterThan(0);
      expect(res.shareCommand).toContain('agenthub add');
      expect(res.profileCommand).toContain('agenthub profile use');
    });

    it('successfully pushes to configured remote and generates share commands', () => {
      const bareRemote = path.join(tmpDir, 'remote.git');
      spawnSync('git', ['init', '--bare', bareRemote]);

      gitInitHub(hubDir, bareRemote);

      // Add a clean rule and skill
      safeWriteFile(path.join(hubDir, 'rules', 'team.md'), '# Team Rules\nBe awesome.');
      ensureDir(path.join(hubDir, 'skills', 'formatter'));
      safeWriteFile(
        path.join(hubDir, 'skills', 'formatter', 'SKILL.md'),
        '---\nname: formatter\ndescription: Code formatter\n---\nRules'
      );

      const res = shareSetup({ hubDir, commitMessage: 'Initial share commit' });
      expect(res.success).toBe(true);
      expect(res.message).toContain('Ready to share');
      expect(res.shareCommand).toBe(`agenthub add ${bareRemote}`);
      expect(res.profileCommand).toBe(`agenthub profile use ${bareRemote}`);

      // Verify commit was received by bare remote
      const logRes = spawnSync('git', ['log', '--all', '--oneline'], { cwd: bareRemote, encoding: 'utf-8' });
      expect(logRes.stdout).toContain('Initial share commit');
    });

    it('formats shorthand commands when remote is a GitHub URL', async () => {
      // Set up git repo with a simulated GitHub remote
      gitInitHub(hubDir);
      spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/alice/agent-setup.git'], {
        cwd: hubDir,
      });

      // Mock gitPush so network is not touched
      const gitSync = await import('../src/core/git-sync.js');
      const pushSpy = vi.spyOn(gitSync, 'gitPush').mockReturnValue({
        ok: true,
        message: 'Pushed changes to origin/main',
      });

      const res = shareSetup({ hubDir });
      expect(res.success).toBe(true);
      expect(res.repoShorthand).toBe('alice/agent-setup');
      expect(res.shareCommand).toBe('agenthub add alice/agent-setup');
      expect(res.profileCommand).toBe('agenthub profile use alice/agent-setup');
      expect(pushSpy).toHaveBeenCalled();
    });

    it('warns when token budget is exceeded but still proceeds', () => {
      const bareRemote = path.join(tmpDir, 'remote.git');
      spawnSync('git', ['init', '--bare', bareRemote]);
      gitInitHub(hubDir, bareRemote);

      // Inject a massive rule file to exceed 2000 token budget (> 8000 characters)
      const hugeContent = '# Huge Rule\n' + 'A'.repeat(12000);
      safeWriteFile(path.join(hubDir, 'rules', 'addons', 'huge.md'), hugeContent);

      const res = shareSetup({ hubDir });
      expect(res.success).toBe(true);
      expect(res.warnings.some((w) => w.includes('Token budget exceeded'))).toBe(true);
    });
  });
});
