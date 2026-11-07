import { stateFile } from '../src/core/state.js';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { checkSources } from '../src/core/check.js';
import { setCustomHome } from '../src/core/detector.js';
import { sourceItems } from '../src/core/doctor-full.js';
import { GENERATED_MARK, hashFolder, hashSkill } from '../src/core/hash.js';
import { planInstall, runInstall, vendorCheckedOutSkill } from '../src/core/installer.js';
import { projectCodexSkillManifests } from '../src/core/linker.js';
import { loadLock, runtime, saveLock, serializeLock } from '../src/core/sources.js';

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const SKILL = 'skills/s';

describe('lockfile hashes, check and frozen lockfile', () => {
  let tmp: string;
  let home: string;
  let hub: string;
  let logs: string[];
  let latest: string;
  let content: string;

  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const manifest = (data: Record<string, unknown>) => write(path.join(hub, 'agenthub.json'), JSON.stringify(data));
  const vendored = () => path.join(hub, 'vendor', 'skills', 's', SKILL);

  // fake git: ls-remote answers `latest`, the checkout lays down the skill with `content`
  const mockGit = () =>
    vi.spyOn(runtime, 'spawn').mockImplementation((cmd, args, cwd) => {
      if (cmd === 'git' && args[0] === 'ls-remote') return ok(`${latest}\tHEAD\n`);
      if (cmd === 'git' && args[0] === 'checkout') write(path.join(cwd as string, SKILL, 'SKILL.md'), content);
      return ok();
    });
  const install = async (opts: { frozen?: boolean } = {}) => {
    const plan = await planInstall(hub, opts);
    return { plan, result: runInstall(plan) };
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-lock-'));
    home = path.join(tmp, 'home');
    hub = path.join(home, '.agenthub');
    fs.mkdirSync(path.join(hub, 'skills'), { recursive: true });
    setCustomHome(home, hub);
    latest = SHA;
    content = '# skill v1\n';
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
    process.exitCode = undefined;
    manifest({ skills: { s: `github:o/r#${SKILL}` } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setCustomHome(null, null);
    process.exitCode = undefined;
    delete process.env.CI;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('hash in the lock', () => {
    it('install records the hash of the vendored skill folder', async () => {
      mockGit();
      const { result } = await install();
      expect(result.failed).toEqual([]);
      const entry = loadLock(hub).skills.s;
      expect(entry).toEqual({ source: `github:o/r#${SKILL}`, commit: SHA, hash: hashFolder(vendored()) });
    });

    it('the lock bytes are deterministic: keys sorted, no timestamps, same on a second machine', async () => {
      mockGit();
      await install();
      const first = fs.readFileSync(path.join(hub, 'agenthub.lock.json'), 'utf-8');
      expect(Object.keys(JSON.parse(first).skills.s)).toEqual(['commit', 'hash', 'source']);
      expect(first).toBe(serializeLock({ version: 1, skills: { s: loadLock(hub).skills.s }, mcp: {} }));

      // another machine: fresh hub, same lock, other mtimes
      const other = path.join(tmp, 'other', '.agenthub');
      fs.mkdirSync(path.join(other, 'skills'), { recursive: true });
      write(path.join(other, 'agenthub.json'), JSON.stringify({ skills: { s: `github:o/r#${SKILL}` } }));
      write(path.join(other, 'agenthub.lock.json'), first);
      setCustomHome(path.join(tmp, 'other'), other);
      const plan = await planInstall(other);
      expect(runInstall(plan).failed).toEqual([]);
      expect(fs.readFileSync(path.join(other, 'agenthub.lock.json'), 'utf-8')).toBe(first);
    });

    it('fails with "content differs from lock" when the fetched folder does not match, and keeps the lock', async () => {
      mockGit();
      saveLock(hub, { version: 1, skills: { s: { source: `github:o/r#${SKILL}`, commit: SHA, hash: 'f'.repeat(64) } }, mcp: {} });
      const { result } = await install();
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].message).toContain('content differs from lock');
      expect(fs.existsSync(path.join(hub, 'vendor', 'skills', 's'))).toBe(false);
      expect(loadLock(hub).skills.s.hash).toBe('f'.repeat(64));
    });

    it('accepts a fetch that matches the lock', async () => {
      mockGit();
      await install();
      fs.rmSync(path.join(hub, 'vendor'), { recursive: true });
      const { result } = await install();
      expect(result.failed).toEqual([]);
      expect(fs.existsSync(vendored())).toBe(true);
    });

    it('a lock entry without a hash gets one: when fetched, and when the folder is already installed', async () => {
      mockGit();
      saveLock(hub, { version: 1, skills: { s: { source: `github:o/r#${SKILL}`, commit: SHA } }, mcp: {} });
      await install();
      const hash = loadLock(hub).skills.s.hash;
      expect(hash).toBe(hashFolder(vendored()));

      saveLock(hub, { version: 1, skills: { s: { source: `github:o/r#${SKILL}`, commit: SHA } }, mcp: {} });
      const { plan } = await install();
      expect(plan.actions).toEqual([]);
      expect(loadLock(hub).skills.s.hash).toBe(hash);
    });

    it('the Codex manifest agenthub writes into a skill is not a local edit', async () => {
      mockGit();
      await install();
      const before = hashSkill(vendored());
      write(path.join(vendored(), 'agents', 'openai.yaml'), `${GENERATED_MARK}\ninterface: {}\n`);
      expect(hashSkill(vendored())).toBe(before);
      expect((await sourceItems(hub, false)).find((i) => i.name === 'skill s')?.level).toBe('PASS');
    });

    it('updating to a new commit drops the old hash, and the new fetch records its own', async () => {
      mockGit();
      await install();
      const old = loadLock(hub).skills.s.hash;
      latest = SHA2;
      content = '# skill v2\n';
      await runCli(['update', '--yes']);
      const entry = loadLock(hub).skills.s;
      expect(entry.commit).toBe(SHA2);
      expect(entry.hash).not.toBe(old);
      expect(entry.hash).toBe(hashSkill(vendored()));
    });

    it('the Codex manifest agenthub generates carries the mark and never replaces a shipped one', () => {
      const dir = path.join(hub, 'skills', 'mine');
      write(path.join(dir, 'SKILL.md'), '---\nname: mine\ndescription: Mine\n---\n');
      projectCodexSkillManifests(hub);
      expect(fs.readFileSync(path.join(dir, 'agents', 'openai.yaml'), 'utf-8').split('\n')[0]).toBe(GENERATED_MARK);

      const shipped = path.join(hub, 'skills', 'own');
      write(path.join(shipped, 'SKILL.md'), '---\nname: own\n---\n');
      write(path.join(shipped, 'agents', 'openai.yaml'), 'shipped');
      projectCodexSkillManifests(hub);
      expect(fs.readFileSync(path.join(shipped, 'agents', 'openai.yaml'), 'utf-8')).toBe('shipped');
    });

    it('vendoring a skill from a checkout drops symlinks and .git', () => {
      const src = path.join(tmp, 'checkout', 'skills', 'link');
      write(path.join(src, 'SKILL.md'), '# link');
      write(path.join(tmp, 'checkout', 'secret.txt'), 'secret');
      write(path.join(src, '.git', 'HEAD'), 'ref');
      try {
        fs.symlinkSync(path.join(tmp, 'checkout', 'secret.txt'), path.join(src, 'leak.txt'));
      } catch {
        return; // no symlink permission here
      }
      vendorCheckedOutSkill(hub, 'link', 'github:o/r#skills/link', SHA, src);
      const target = path.join(hub, 'vendor', 'skills', 'link', 'skills', 'link');
      expect(fs.readdirSync(target)).toEqual(['SKILL.md']);
      expect(loadLock(hub).skills.link.hash).toBe(hashSkill(target));
    });

    it('a local build hash covers what git tracks plus untracked files it does not ignore', async () => {
      manifest({ mcp: { m: { source: 'local', build: 'make' } } });
      write(path.join(hub, 'mcp', 'servers.json'), JSON.stringify({ mcpServers: { m: { command: 'node', args: ['x'] } } }));
      const dir = path.join(hub, 'mcp', 'servers', 'm');
      write(path.join(dir, 'index.js'), 'one');
      write(path.join(dir, '.gitignore'), 'generated/\n');
      spawnSync('git', ['init', '-q'], { cwd: dir });
      const hashOf = async () => (await planInstall(hub)).lock.mcp.m.hash;
      const base = await hashOf();
      write(path.join(dir, 'generated', 'x.js'), 'ignored output');
      expect(await hashOf()).toBe(base);
      write(path.join(dir, 'untracked.js'), 'new source');
      expect(await hashOf()).not.toBe(base);
      // an output folder git does not ignore counts: only git decides, not the name
      write(path.join(dir, 'untracked.js'), 'new source');
      const withUntracked = await hashOf();
      write(path.join(dir, 'dist', 'o.js'), 'not ignored by git');
      expect(await hashOf()).not.toBe(withUntracked);
    });

    it('records a hash of the sources of a local MCP build, not of its build output', async () => {
      manifest({ mcp: { m: { source: 'local', build: 'npm run build' } } });
      write(path.join(hub, 'mcp', 'servers.json'), JSON.stringify({ mcpServers: { m: { command: 'node', args: ['x'] } } }));
      write(path.join(hub, 'mcp', 'servers', 'm', 'index.js'), 'one');
      const plan = await planInstall(hub);
      const hash = plan.lock.mcp.m.hash;
      expect(plan.lock.mcp.m).toEqual({ source: 'local', hash });
      write(path.join(hub, 'mcp', 'servers', 'm', 'dist', 'out.js'), 'build output');
      expect((await planInstall(hub)).lock.mcp.m.hash).toBe(hash);
      write(path.join(hub, 'mcp', 'servers', 'm', 'index.js'), 'two');
      expect((await planInstall(hub)).lock.mcp.m.hash).not.toBe(hash);
    });
  });

  describe('doctor: modified locally', () => {
    it('passes for an untouched skill and warns after an edit', async () => {
      mockGit();
      await install();
      expect((await sourceItems(hub, false)).find((i) => i.name === 'skill s')).toMatchObject({ level: 'PASS' });
      write(path.join(vendored(), 'SKILL.md'), '# edited\n');
      const item = (await sourceItems(hub, false)).find((i) => i.name === 'skill s');
      expect(item).toMatchObject({ level: 'WARN' });
      expect(item?.message).toContain('modified locally');
    });
  });

  describe('agenthub check', () => {
    it('exits 0 when everything is current and runs nothing the hub declares', async () => {
      const spawn = mockGit();
      await install();
      spawn.mockClear();
      const shell = vi.spyOn(runtime, 'shell');
      await runCli(['check']);
      expect(process.exitCode).toBeUndefined();
      expect(logs.join('\n')).toContain('up to date');
      expect(shell).not.toHaveBeenCalled();
      expect(spawn.mock.calls.every(([cmd, args]) => cmd === 'git' && args[0] === 'ls-remote')).toBe(true);
    });

    it('exits 1 and prints the change when a pin is outdated, installing nothing', async () => {
      mockGit();
      await install();
      latest = SHA2;
      const lockBefore = fs.readFileSync(path.join(hub, 'agenthub.lock.json'), 'utf-8');
      await runCli(['check']);
      expect(process.exitCode).toBe(1);
      expect(logs.join('\n')).toContain(`skill s: ${SHA.slice(0, 12)} -> ${SHA2.slice(0, 12)}`);
      expect(fs.readFileSync(path.join(hub, 'agenthub.lock.json'), 'utf-8')).toBe(lockBefore);
    });

    it('exits 1 for a skill modified locally even when the pin is current', async () => {
      mockGit();
      await install();
      write(path.join(vendored(), 'SKILL.md'), '# edited\n');
      await runCli(['check']);
      expect(process.exitCode).toBe(1);
      expect(logs.join('\n')).toContain('modified locally');
    });

    it('treats a declared source that is not in the lock as outdated', async () => {
      mockGit();
      const { findings, dirty } = await checkSources(hub);
      expect(dirty).toBe(true);
      expect(findings[0]).toMatchObject({ item: 'skill s', status: 'outdated' });
    });

    it('reports a source that cannot be resolved and exits 1', async () => {
      mockGit();
      await install();
      vi.spyOn(runtime, 'spawn').mockReturnValue({ status: 128, stdout: '', stderr: 'unreachable' });
      await runCli(['check']);
      expect(process.exitCode).toBe(1);
      expect(logs.join('\n')).toContain('unreachable');
    });

    it('respects the ignore list', async () => {
      mockGit();
      await install();
      latest = SHA2;
      write(stateFile(hub, 'local.json'), JSON.stringify({ ignore: { skills: ['s'], mcp: [] } }));
      await runCli(['check']);
      expect(process.exitCode).toBeUndefined();
    });

    it('checks custom items by neither running nor listing them', async () => {
      manifest({ mcp: { c: { check: 'false', install: 'false' } } });
      const shell = vi.spyOn(runtime, 'shell');
      await runCli(['check']);
      expect(process.exitCode).toBeUndefined();
      expect(shell).not.toHaveBeenCalled();
    });
  });

  describe('frozen lockfile', () => {
    it('refuses a pin that is not in the lock, resolves nothing and writes nothing', async () => {
      const spawn = mockGit();
      const { plan, result } = await install({ frozen: true });
      expect(plan.errors[0].message).toContain('has no pin in agenthub.lock.json (frozen lockfile');
      expect(plan.actions).toEqual([]);
      expect(result.installed).toEqual([]);
      expect(spawn.mock.calls.some(([, args]) => args[0] === 'ls-remote')).toBe(false);
      expect(fs.existsSync(path.join(hub, 'agenthub.lock.json'))).toBe(false);
    });

    it('refuses a lock entry without a hash', async () => {
      mockGit();
      saveLock(hub, { version: 1, skills: { s: { source: `github:o/r#${SKILL}`, commit: SHA } }, mcp: {} });
      const before = fs.readFileSync(path.join(hub, 'agenthub.lock.json'), 'utf-8');
      const { plan } = await install({ frozen: true });
      expect(plan.errors.some((e) => e.message.includes('no content hash'))).toBe(true);
      expect(fs.readFileSync(path.join(hub, 'agenthub.lock.json'), 'utf-8')).toBe(before);
    });

    it('refuses to prune an entry that is no longer declared', async () => {
      mockGit();
      await install();
      manifest({});
      const before = fs.readFileSync(path.join(hub, 'agenthub.lock.json'), 'utf-8');
      const { plan } = await install({ frozen: true });
      expect(plan.errors[0]).toMatchObject({ item: 'agenthub.lock.json' });
      expect(plan.errors[0].message).toContain('skills.s');
      expect(fs.readFileSync(path.join(hub, 'agenthub.lock.json'), 'utf-8')).toBe(before);
    });

    it('installs from a complete lock without changing it', async () => {
      mockGit();
      await install();
      fs.rmSync(path.join(hub, 'vendor'), { recursive: true });
      const before = fs.readFileSync(path.join(hub, 'agenthub.lock.json'), 'utf-8');
      const { plan, result } = await install({ frozen: true });
      expect(plan.errors).toEqual([]);
      expect(result.failed).toEqual([]);
      expect(fs.existsSync(vendored())).toBe(true);
      expect(fs.readFileSync(path.join(hub, 'agenthub.lock.json'), 'utf-8')).toBe(before);
    });

    it('an equivalent spelling of the source keeps its hash and passes frozen; a changed subpath is stale and fails', async () => {
      mockGit();
      manifest({ skills: { s: { source: `github:o/r#${SKILL}`, ref: 'main' } } });
      const hash = 'c'.repeat(64);
      saveLock(hub, { version: 1, skills: { s: { source: `github:o/r#${SKILL}  ref=main`, commit: SHA, hash } }, mcp: {} });
      fs.mkdirSync(path.join(hub, 'vendor', 'skills', 's'), { recursive: true });
      const { plan } = await install({ frozen: true });
      expect(plan.errors).toEqual([]);
      expect(plan.lock.skills.s.hash).toBe(hash);

      manifest({ skills: { s: { source: 'github:o/r#skills/other', ref: 'main' } } });
      const stale = await planInstall(hub, { frozen: true });
      expect(stale.errors.map((e) => e.message).join(' ')).toMatch(/no content hash|would change/);
      expect(stale.actions).toEqual([]);
    });

    it('a hash mismatch still fails when frozen', async () => {
      mockGit();
      await install();
      fs.rmSync(path.join(hub, 'vendor'), { recursive: true });
      content = '# tampered\n';
      const { result } = await install({ frozen: true });
      expect(result.failed[0].message).toContain('content differs from lock');
    });

    it('is on by default when CI is set, and --no-frozen-lockfile overrides it', async () => {
      mockGit();
      process.env.CI = 'true';
      await runCli(['install', '--yes']);
      expect(process.exitCode).toBe(1);
      expect(logs.join('\n')).toContain('frozen lockfile');
      expect(fs.existsSync(path.join(hub, 'agenthub.lock.json'))).toBe(false);

      process.exitCode = undefined;
      logs.length = 0;
      await runCli(['install', '--yes', '--no-frozen-lockfile']);
      expect(process.exitCode).toBeUndefined();
      expect(loadLock(hub).skills.s.hash).toBeDefined();
    });

    it('--frozen-lockfile works without CI, and CI=false does not freeze', async () => {
      mockGit();
      await runCli(['install', '--yes', '--frozen-lockfile']);
      expect(process.exitCode).toBe(1);
      process.exitCode = undefined;
      process.env.CI = 'false';
      await runCli(['install', '--yes']);
      expect(process.exitCode).toBeUndefined();
      expect(fs.existsSync(path.join(hub, 'agenthub.lock.json'))).toBe(true);
    });

    it('update is never frozen, even in CI', async () => {
      mockGit();
      await install();
      latest = SHA2;
      process.env.CI = 'true';
      await runCli(['update', '--yes']);
      expect(loadLock(hub).skills.s.commit).toBe(SHA2);
    });
  });
});
