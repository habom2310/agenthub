import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCustomHome } from '../src/core/detector.js';
import {
  ensureGitignore,
  gitInitHub,
  gitPull,
  gitPush,
  gitStatus,
  isGitInstalled,
  isGitRepo,
  redactGitSecrets,
  STANDARD_IGNORE_ENTRIES,
} from '../src/core/git-sync.js';
import { initHub } from '../src/core/scaffold.js';
import { ensureDir, safeWriteFile } from '../src/utils/fs.js';

describe('git-sync', () => {
  let tmpDir: string;
  let homeDir: string;
  let hubDir: string;
  let savedGlobalConfig: string | undefined;
  let savedNoSystem: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-gitsync-test-'));
    homeDir = path.join(tmpDir, 'home');
    hubDir = path.join(tmpDir, 'hub');
    ensureDir(homeDir);
    ensureDir(hubDir);
    setCustomHome(homeDir, hubDir);

    savedGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
    savedNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  });

  afterEach(() => {
    setCustomHome(null, null);
    if (savedGlobalConfig !== undefined) {
      process.env.GIT_CONFIG_GLOBAL = savedGlobalConfig;
    } else {
      delete process.env.GIT_CONFIG_GLOBAL;
    }
    if (savedNoSystem !== undefined) {
      process.env.GIT_CONFIG_NOSYSTEM = savedNoSystem;
    } else {
      delete process.env.GIT_CONFIG_NOSYSTEM;
    }

    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe('redactGitSecrets', () => {
    it('redacts credentials from https and http urls', () => {
      const url = 'https://username:secret_token_12345@github.com/org/repo.git';
      expect(redactGitSecrets(url)).toBe('https://username:***@github.com/org/repo.git');

      const tokenUrl = 'https://token@github.com/org/repo.git';
      expect(redactGitSecrets(tokenUrl)).toBe('https://***@github.com/org/repo.git');

      const httpUrl = 'http://user:pass123@gitlab.example.com/project.git';
      expect(redactGitSecrets(httpUrl)).toBe('http://user:***@gitlab.example.com/project.git');
    });

    it('leaves urls without credentials untouched', () => {
      const standard = 'https://github.com/org/repo.git';
      expect(redactGitSecrets(standard)).toBe(standard);

      const ssh = 'git@github.com:org/repo.git';
      expect(redactGitSecrets(ssh)).toBe(ssh);
    });

    it('redacts credentials embedded in error output strings', () => {
      const errorMsg = 'fatal: unable to access https://token:secret999@github.com/repo.git/: The requested URL returned error: 403';
      expect(redactGitSecrets(errorMsg)).toBe(
        'fatal: unable to access https://token:***@github.com/repo.git/: The requested URL returned error: 403'
      );
    });
  });

  describe('isGitInstalled', () => {
    it('detects whether git is installed in environment', () => {
      const installed = isGitInstalled();
      expect(typeof installed).toBe('boolean');
      expect(installed).toBe(true);
    });
  });

  describe('isGitRepo and non-git status', () => {
    it('reports non-git dir status properly (is_repo: false, is_clean: true)', () => {
      expect(isGitRepo(hubDir)).toBe(false);

      const status = gitStatus(hubDir);
      expect(status.git_installed).toBe(true);
      expect(status.is_repo).toBe(false);
      expect(status.branch).toBeNull();
      expect(status.is_clean).toBe(true);
      expect(status.modified).toEqual([]);
      expect(status.untracked).toEqual([]);
      expect(status.remotes).toEqual({});
    });
  });

  describe('gitInitHub and ensureGitignore', () => {
    it('initializes git repository and populates .gitignore', () => {
      const initRes = gitInitHub(hubDir);
      expect(initRes.ok).toBe(true);
      expect(initRes.message).toBe('Initialized git repository in hub');
      expect(isGitRepo(hubDir)).toBe(true);

      const gitignorePath = path.join(hubDir, '.gitignore');
      expect(fs.existsSync(gitignorePath)).toBe(true);
      const content = fs.readFileSync(gitignorePath, 'utf-8');

      for (const entry of STANDARD_IGNORE_ENTRIES) {
        expect(content).toContain(entry);
      }
    });

    it('ignores vendor/ at the hub root only', () => {
      expect(STANDARD_IGNORE_ENTRIES).toContain('/vendor/');
    });

    it('preserves existing entries when appending to .gitignore', () => {
      const gitignorePath = path.join(hubDir, '.gitignore');
      safeWriteFile(gitignorePath, '# Custom user entry\nmy-secret.key\n');

      ensureGitignore(hubDir);

      const updated = fs.readFileSync(gitignorePath, 'utf-8');
      expect(updated).toContain('my-secret.key');
      for (const entry of STANDARD_IGNORE_ENTRIES) {
        expect(updated).toContain(entry);
      }
    });

    it('configures remoteUrl when provided', () => {
      const remoteUrl = 'https://github.com/example/repo.git';
      const initRes = gitInitHub(hubDir, remoteUrl);
      expect(initRes.ok).toBe(true);

      const status = gitStatus(hubDir);
      expect(status.remotes.origin).toBe(remoteUrl);

      // Updating remote URL
      const updatedUrl = 'https://github.com/example/updated.git';
      const updateRes = gitInitHub(hubDir, updatedUrl);
      expect(updateRes.ok).toBe(true);

      const statusAfterUpdate = gitStatus(hubDir);
      expect(statusAfterUpdate.remotes.origin).toBe(updatedUrl);
    });

    it('redacts credentials in remote URLs returned by gitStatus', () => {
      const secretUrl = 'https://user:ghp_mySecretKey123@github.com/example/repo.git';
      gitInitHub(hubDir, secretUrl);

      const status = gitStatus(hubDir);
      expect(status.remotes.origin).toBe('https://user:***@github.com/example/repo.git');
    });
  });

  describe('gitStatus path preservation', () => {
    it('preserves relative directory paths for untracked and modified files', () => {
      gitInitHub(hubDir);

      // Create nested file
      const nestedRel = path.join('skills', 'test-skill', 'SKILL.md').replace(/\\/g, '/');
      safeWriteFile(path.join(hubDir, 'skills', 'test-skill', 'SKILL.md'), '# Test Skill');

      const statusUntracked = gitStatus(hubDir);
      expect(statusUntracked.is_clean).toBe(false);
      expect(statusUntracked.untracked).toContain(nestedRel);

      // Commit file
      gitPush(hubDir, 'Add initial skill');

      // Now modify the file
      safeWriteFile(
        path.join(hubDir, 'skills', 'test-skill', 'SKILL.md'),
        '# Test Skill (Modified)'
      );

      const statusModified = gitStatus(hubDir);
      expect(statusModified.is_clean).toBe(false);
      expect(statusModified.modified).toContain(nestedRel);
    });
  });

  describe('gitPush', () => {
    it('commits locally with no remote without failing', () => {
      gitInitHub(hubDir);
      safeWriteFile(path.join(hubDir, 'rules', 'common.md'), '# Common Rules');

      const pushRes = gitPush(hubDir, 'Commit rules');
      expect(pushRes.ok).toBe(true);
      expect(pushRes.message).toBe('Changes committed locally. No remote configured, skipping push.');

      const status = gitStatus(hubDir);
      expect(status.is_clean).toBe(true);
      expect(status.modified).toEqual([]);
      expect(status.untracked).toEqual([]);
    });

    it('auto-initializes repo if not already initialized when pushing', () => {
      safeWriteFile(path.join(hubDir, 'sample.txt'), 'Sample content');
      expect(isGitRepo(hubDir)).toBe(false);

      const pushRes = gitPush(hubDir, 'Initial push');
      expect(pushRes.ok).toBe(true);
      expect(isGitRepo(hubDir)).toBe(true);
    });

    it('uses safe author fallback when git user.name is not set', () => {
      // Isolate git environment from global user config
      const emptyConfigFile = path.join(tmpDir, 'empty.gitconfig');
      safeWriteFile(emptyConfigFile, '');
      process.env.GIT_CONFIG_GLOBAL = emptyConfigFile;
      process.env.GIT_CONFIG_NOSYSTEM = '1';

      gitInitHub(hubDir);
      safeWriteFile(path.join(hubDir, 'fallback-test.txt'), 'author fallback');

      const pushRes = gitPush(hubDir, 'Test author fallback');
      expect(pushRes.ok).toBe(true);

      const logRes = spawnSync('git', ['log', '-1', '--format=%an <%ae>'], {
        cwd: hubDir,
        encoding: 'utf-8',
      });
      expect(logRes.stdout.trim()).toBe('agenthub <agenthub@local>');
    });

    it('uses safe author fallback when user.name is set but user.email is not set', () => {
      const customConfig = path.join(tmpDir, 'user-only.gitconfig');
      safeWriteFile(customConfig, '[user]\n\tname = CustomCoder\n');
      process.env.GIT_CONFIG_GLOBAL = customConfig;
      process.env.GIT_CONFIG_NOSYSTEM = '1';

      gitInitHub(hubDir);
      safeWriteFile(path.join(hubDir, 'user-email-fallback.txt'), 'user set email fallback');

      const pushRes = gitPush(hubDir, 'Test email fallback');
      expect(pushRes.ok).toBe(true);

      const logRes = spawnSync('git', ['log', '-1', '--format=%an <%ae>'], {
        cwd: hubDir,
        encoding: 'utf-8',
      });
      expect(logRes.stdout.trim()).toBe('CustomCoder <agenthub@local>');
    });

    it('returns error when git is not installed', () => {
      const oldPath = process.env.PATH;
      const oldPathLower = process.env.Path;
      try {
        delete process.env.PATH;
        delete process.env.Path;
        process.env.PATH = '';
        process.env.Path = '';

        expect(isGitInstalled()).toBe(false);
        const res = gitPush(hubDir, 'Should fail');
        expect(res.ok).toBe(false);
        expect(res.message).toBe('git is not installed or not in PATH');
      } finally {
        if (oldPath !== undefined) process.env.PATH = oldPath;
        if (oldPathLower !== undefined) process.env.Path = oldPathLower;
      }
    });
  });

  describe('gitPull', () => {
    it('fails gracefully when hub is not a git repo or remote does not exist', () => {
      const notRepoRes = gitPull(hubDir, 'origin');
      expect(notRepoRes.ok).toBe(false);
      expect(notRepoRes.message).toBe('Hub is not a git repository');

      gitInitHub(hubDir);
      const noRemoteRes = gitPull(hubDir, 'origin');
      expect(noRemoteRes.ok).toBe(false);
      expect(noRemoteRes.message).toBe("Remote 'origin' does not exist");
    });

    it('pulls changes and auto-reprojects rules and subagent manifests', () => {
      // Create a bare remote repository
      const remoteDir = path.join(tmpDir, 'remote.git');
      ensureDir(remoteDir);
      spawnSync('git', ['init', '--bare', '-b', 'main'], { cwd: remoteDir });

      // Create a feeder repository to populate the remote
      const feederDir = path.join(tmpDir, 'feeder');
      ensureDir(feederDir);
      spawnSync('git', ['init', '-b', 'main'], { cwd: feederDir });
      spawnSync('git', ['remote', 'add', 'origin', remoteDir], { cwd: feederDir });

      // Push initial commit to remote
      safeWriteFile(path.join(feederDir, 'rules', 'common.md'), '# Initial Common Rules');
      spawnSync('git', ['add', '-A'], { cwd: feederDir });
      spawnSync(
        'git',
        ['-c', 'user.name=feeder', '-c', 'user.email=feeder@test', 'commit', '-m', 'Initial'],
        { cwd: feederDir }
      );
      spawnSync('git', ['push', '-u', 'origin', 'main'], { cwd: feederDir });

      // Initialize hubDir with remote
      gitInitHub(hubDir, remoteDir);
      // Initial pull
      const pullRes1 = gitPull(hubDir, 'origin', 'main', false);
      expect(pullRes1.ok).toBe(true);

      // Now add a skill to feeder repo and push to remote
      const feederSkillDir = path.join(feederDir, 'skills', 'tester');
      ensureDir(feederSkillDir);
      safeWriteFile(
        path.join(feederSkillDir, 'SKILL.md'),
        '---\nname: tester\ndescription: Testing skill\n---\n# Tester Skill\n'
      );
      spawnSync('git', ['add', '-A'], { cwd: feederDir });
      spawnSync(
        'git',
        ['-c', 'user.name=feeder', '-c', 'user.email=feeder@test', 'commit', '-m', 'Add tester skill'],
        { cwd: feederDir }
      );
      spawnSync('git', ['push', 'origin', 'main'], { cwd: feederDir });

      // Pull from hub with reproject = true
      const pullRes2 = gitPull(hubDir, 'origin', 'main', true);
      expect(pullRes2.ok).toBe(true);

      // Verify skill was pulled
      expect(fs.existsSync(path.join(hubDir, 'skills', 'tester', 'SKILL.md'))).toBe(true);

      // Verify projectCodexSkillManifests ran (agents/openai.yaml generated)
      const manifestPath = path.join(hubDir, 'skills', 'tester', 'agents', 'openai.yaml');
      expect(fs.existsSync(manifestPath)).toBe(true);
      const manifestContent = fs.readFileSync(manifestPath, 'utf-8');
      expect(manifestContent).toContain('Tester');
    });

    it('backs up colliding user files, then checks out the remote branch, when HEAD is unborn', () => {
      const remoteDir = path.join(tmpDir, 'remote.git');
      spawnSync('git', ['init', '--bare', '-b', 'main', remoteDir]);
      const feederDir = path.join(tmpDir, 'feeder');
      ensureDir(feederDir);
      spawnSync('git', ['init', '-b', 'main'], { cwd: feederDir });
      spawnSync('git', ['remote', 'add', 'origin', remoteDir], { cwd: feederDir });
      safeWriteFile(path.join(feederDir, 'rules', 'common.md'), '# Remote Rules');
      safeWriteFile(path.join(feederDir, 'agenthub.json'), '{"name":"remote"}');
      spawnSync('git', ['add', '-A'], { cwd: feederDir });
      spawnSync('git', ['-c', 'user.name=f', '-c', 'user.email=f@test', 'commit', '-m', 'Initial'], { cwd: feederDir });
      spawnSync('git', ['push', '-u', 'origin', 'main'], { cwd: feederDir });

      // Scaffold defaults that setup would have written before the first pull
      safeWriteFile(path.join(hubDir, 'rules', 'common.md'), '# Scaffold default');
      safeWriteFile(path.join(hubDir, 'agenthub.json'), '{"name":"scaffold"}');
      gitInitHub(hubDir, remoteDir);

      const res = gitPull(hubDir, 'origin', undefined, false);
      expect(res.ok).toBe(true);
      expect(fs.readFileSync(path.join(hubDir, 'rules', 'common.md'), 'utf-8')).toBe('# Remote Rules');
      expect(fs.readFileSync(path.join(hubDir, 'agenthub.json'), 'utf-8')).toBe('{"name":"remote"}');
      expect(gitStatus(hubDir).branch).toBe('main');
      expect(res.message).toContain('Backed up 2 conflicting file(s) to backups/pre-pull-');
      const backups = fs.readdirSync(path.join(hubDir, 'backups')).filter((d) => d.startsWith('pre-pull-'));
      expect(backups).toHaveLength(1);
      const backupDir = path.join(hubDir, 'backups', backups[0]);
      expect(fs.readFileSync(path.join(backupDir, 'rules', 'common.md'), 'utf-8')).toBe('# Scaffold default');
      expect(fs.readFileSync(path.join(backupDir, 'agenthub.json'), 'utf-8')).toBe('{"name":"scaffold"}');

      // A second pull takes the normal path and tracks the remote
      expect(gitPull(hubDir, 'origin', undefined, false).ok).toBe(true);
    });

    it('replaces untouched scaffold output without a backup, but backs up an edited scaffold file', () => {
      const remoteDir = path.join(tmpDir, 'remote.git');
      spawnSync('git', ['init', '--bare', '-b', 'main', remoteDir]);
      const feederDir = path.join(tmpDir, 'feeder');
      ensureDir(feederDir);
      spawnSync('git', ['init', '-b', 'main'], { cwd: feederDir });
      spawnSync('git', ['remote', 'add', 'origin', remoteDir], { cwd: feederDir });
      safeWriteFile(path.join(feederDir, 'rules', 'common.md'), '# Remote Rules');
      safeWriteFile(path.join(feederDir, 'rules', 'handoffs.md'), '# Remote handoffs');
      safeWriteFile(path.join(feederDir, 'agenthub.json'), '{"name":"remote"}');
      safeWriteFile(path.join(feederDir, '.gitignore'), 'remote-ignore\n');
      spawnSync('git', ['add', '-A'], { cwd: feederDir });
      spawnSync('git', ['-c', 'user.name=f', '-c', 'user.email=f@test', 'commit', '-m', 'Initial'], { cwd: feederDir });
      spawnSync('git', ['push', '-u', 'origin', 'main'], { cwd: feederDir });

      initHub({});
      gitInitHub(hubDir, remoteDir);
      fs.appendFileSync(path.join(hubDir, 'rules', 'handoffs.md'), '\nMy own edit\n');

      const res = gitPull(hubDir, 'origin', undefined, false);
      expect(res.ok).toBe(true);
      expect(res.message).toContain('Backed up 1 conflicting file(s)');
      expect(res.message).toContain('rules/handoffs.md');
      expect(res.message).not.toContain('agenthub.json');
      expect(res.message).not.toContain('.gitignore');
      expect(fs.readFileSync(path.join(hubDir, 'rules', 'handoffs.md'), 'utf-8')).toBe('# Remote handoffs');
      expect(fs.readFileSync(path.join(hubDir, 'rules', 'common.md'), 'utf-8')).toBe('# Remote Rules');
    });

    it('reports a clear error when the remote branch does not exist', () => {
      const remoteDir = path.join(tmpDir, 'empty.git');
      spawnSync('git', ['init', '--bare', '-b', 'main', remoteDir]);
      gitInitHub(hubDir, remoteDir);
      const res = gitPull(hubDir, 'origin', undefined, false);
      expect(res.ok).toBe(false);
      expect(res.message).toContain('Failed to pull from origin');
    });
  });
});
