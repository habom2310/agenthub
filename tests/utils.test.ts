import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  backupSkillsDir,
  createJunction,
  ensureDir,
  findExecutable,
  isJunctionOrSymlink,
  safeWriteFile,
} from '../src/utils/fs.js';

describe('fs utils', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-fs-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe('backupSkillsDir', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('uses skills.old, then a timestamp, then -N on a same-second clash', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-29T08:09:10Z'));
      const skills = path.join(tmpDir, 'skills');

      const backups = ['a', 'b', 'c'].map((marker) => {
        safeWriteFile(path.join(skills, 'marker.txt'), marker);
        return path.basename(backupSkillsDir(skills));
      });

      expect(backups).toEqual([
        'skills.old',
        'skills.old.20261029_080910Z',
        'skills.old.20261029_080910Z-1',
      ]);
      expect(fs.readFileSync(path.join(tmpDir, 'skills.old', 'marker.txt'), 'utf-8')).toBe('a');
    });

    it('treats a dangling skills.old symlink as taken and leaves it alone', () => {
      const skills = path.join(tmpDir, 'skills');
      const skillsOld = path.join(tmpDir, 'skills.old');
      fs.symlinkSync(path.join(tmpDir, 'missing'), skillsOld, 'junction');
      safeWriteFile(path.join(skills, 'marker.txt'), 'a');

      const backup = backupSkillsDir(skills);

      expect(path.basename(backup)).toMatch(/^skills\.old\.\d{8}_\d{6}Z$/);
      expect(fs.lstatSync(skillsOld).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(path.join(backup, 'marker.txt'), 'utf-8')).toBe('a');
    });
  });

  describe('ensureDir & safeWriteFile', () => {
    it('creates nested directories recursively', () => {
      const nested = path.join(tmpDir, 'a', 'b', 'c');
      ensureDir(nested);
      expect(fs.existsSync(nested)).toBe(true);
      expect(fs.statSync(nested).isDirectory()).toBe(true);
    });

    it('writes file and creates parent directories if missing', () => {
      const target = path.join(tmpDir, 'deep', 'folder', 'test.txt');
      safeWriteFile(target, 'hello agenthub');
      expect(fs.existsSync(target)).toBe(true);
      expect(fs.readFileSync(target, 'utf-8')).toBe('hello agenthub');
    });

    it('atomically overwrites existing file without leaving temporary sibling files', () => {
      const target = path.join(tmpDir, 'atomic', 'data.txt');
      safeWriteFile(target, 'version 1');
      expect(fs.readFileSync(target, 'utf-8')).toBe('version 1');

      safeWriteFile(target, 'version 2');
      expect(fs.readFileSync(target, 'utf-8')).toBe('version 2');

      const files = fs.readdirSync(path.join(tmpDir, 'atomic'));
      expect(files).toEqual(['data.txt']);
    });
  });

  describe('createJunction & isJunctionOrSymlink', () => {
    it('creates junction/symlink to target directory', () => {
      const targetDir = path.join(tmpDir, 'target');
      const linkPath = path.join(tmpDir, 'link');
      ensureDir(targetDir);

      const created = createJunction(targetDir, linkPath);
      expect(created).toBe(true);
      expect(isJunctionOrSymlink(linkPath)).toBe(true);
      expect(isJunctionOrSymlink(targetDir)).toBe(false);
    });

    it('returns true if link already points to target directory', () => {
      const targetDir = path.join(tmpDir, 'target');
      const linkPath = path.join(tmpDir, 'link');
      ensureDir(targetDir);

      expect(createJunction(targetDir, linkPath)).toBe(true);
      // Calling again should return true without failure
      expect(createJunction(targetDir, linkPath)).toBe(true);
    });

    it('replaces existing junction if target changes', () => {
      const targetA = path.join(tmpDir, 'targetA');
      const targetB = path.join(tmpDir, 'targetB');
      const linkPath = path.join(tmpDir, 'link');
      ensureDir(targetA);
      ensureDir(targetB);
      safeWriteFile(path.join(targetA, 'a.txt'), 'file a');
      safeWriteFile(path.join(targetB, 'b.txt'), 'file b');

      expect(createJunction(targetA, linkPath)).toBe(true);
      expect(fs.existsSync(path.join(linkPath, 'a.txt'))).toBe(true);

      // Point to targetB
      expect(createJunction(targetB, linkPath)).toBe(true);
      expect(fs.existsSync(path.join(linkPath, 'b.txt'))).toBe(true);
      expect(fs.existsSync(path.join(linkPath, 'a.txt'))).toBe(false);
    });

    it('fails safely if target does not exist', () => {
      const nonexistent = path.join(tmpDir, 'does-not-exist');
      const linkPath = path.join(tmpDir, 'link');
      const result = createJunction(nonexistent, linkPath);
      expect(result).toBe(false);
      expect(fs.existsSync(linkPath)).toBe(false);
    });

    it('refuses to replace normal directory without force, replaces with force', () => {
      const targetDir = path.join(tmpDir, 'target');
      const existingDir = path.join(tmpDir, 'existing');
      ensureDir(targetDir);
      ensureDir(existingDir);

      // Without force, should return false and not delete existing directory
      const resWithoutForce = createJunction(targetDir, existingDir, { force: false });
      expect(resWithoutForce).toBe(false);
      expect(isJunctionOrSymlink(existingDir)).toBe(false);

      // With force, should replace directory with junction
      const resWithForce = createJunction(targetDir, existingDir, { force: true });
      expect(resWithForce).toBe(true);
      expect(isJunctionOrSymlink(existingDir)).toBe(true);
    });

    it('returns false for nonexistent paths in isJunctionOrSymlink', () => {
      expect(isJunctionOrSymlink(path.join(tmpDir, 'phantom'))).toBe(false);
    });

    it('returns false for normal files nested inside a symlinked directory', () => {
      const realDir = path.join(tmpDir, 'real-folder');
      const nestedFile = path.join(realDir, 'nested.txt');
      safeWriteFile(nestedFile, 'content');

      const linkDir = path.join(tmpDir, 'link-folder');
      createJunction(realDir, linkDir);

      expect(isJunctionOrSymlink(linkDir)).toBe(true);
      // The nested file inside linkDir is a normal file, not a symlink itself
      expect(isJunctionOrSymlink(path.join(linkDir, 'nested.txt'))).toBe(false);
    });
  });

  describe('findExecutable', () => {
    it('finds node executable on PATH', () => {
      const nodeExe = findExecutable('node');
      expect(nodeExe).not.toBeNull();
      expect(typeof nodeExe).toBe('string');
      expect(fs.existsSync(nodeExe!)).toBe(true);
    });

    it('returns null for non-existent executable', () => {
      const phantom = findExecutable('phantom_binary_that_does_not_exist_xyz123');
      expect(phantom).toBeNull();
    });

    it('returns null for empty name', () => {
      expect(findExecutable('')).toBeNull();
    });

    it('locates executable with direct path', () => {
      const binDir = path.join(tmpDir, 'bin');
      ensureDir(binDir);
      const isWin = process.platform === 'win32';
      const scriptName = isWin ? 'testcmd.bat' : 'testcmd.sh';
      const scriptPath = path.join(binDir, scriptName);
      safeWriteFile(scriptPath, isWin ? '@echo test' : '#!/bin/sh\necho test');

      if (!isWin) {
        fs.chmodSync(scriptPath, 0o755);
      }

      const found = findExecutable(scriptPath);
      expect(found).not.toBeNull();
    });

    it('handles quoted entries in PATH environment variable', () => {
      const originalPath = process.env.PATH;
      try {
        const binDir = path.join(tmpDir, 'quoted bin');
        ensureDir(binDir);
        const isWin = process.platform === 'win32';
        const scriptName = isWin ? 'quotedcmd.bat' : 'quotedcmd.sh';
        const scriptPath = path.join(binDir, scriptName);
        safeWriteFile(scriptPath, isWin ? '@echo test' : '#!/bin/sh\necho test');

        if (!isWin) {
          fs.chmodSync(scriptPath, 0o755);
        }

        process.env.PATH = `"${binDir}"${path.delimiter}${originalPath || ''}`;
        const found = findExecutable(isWin ? 'quotedcmd' : 'quotedcmd.sh');
        expect(found).not.toBeNull();
      } finally {
        process.env.PATH = originalPath;
      }
    });
  });
});

describe('safeWriteFile and secret files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-safewrite-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it.skipIf(process.platform === 'win32')('creates new files with mode 0600 and keeps the mode of existing ones', () => {
    const created = path.join(dir, 'new.json');
    safeWriteFile(created, '{}');
    expect(fs.statSync(created).mode & 0o777).toBe(0o600);

    const existing = path.join(dir, 'existing.txt');
    fs.writeFileSync(existing, 'a');
    fs.chmodSync(existing, 0o640);
    safeWriteFile(existing, 'b');
    expect(fs.readFileSync(existing, 'utf-8')).toBe('b');
    expect(fs.statSync(existing).mode & 0o777).toBe(0o640);
  });

  it.skipIf(process.platform === 'win32')('writes through a symlink so it stays a symlink', () => {
    const real = path.join(dir, 'dotfiles', 'config.json');
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, 'old');
    const link = path.join(dir, 'config-link.json');
    fs.symlinkSync(real, link);
    safeWriteFile(link, 'new');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf-8')).toBe('new');

    const dangling = path.join(dir, 'dangling.json');
    fs.symlinkSync(path.join(dir, 'dotfiles', 'created-later.json'), dangling);
    safeWriteFile(dangling, 'x');
    expect(fs.lstatSync(dangling).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'dotfiles', 'created-later.json'), 'utf-8')).toBe('x');
  });
});
