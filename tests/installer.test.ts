import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCustomHome } from '../src/core/detector.js';
import { MANAGED_BLOCK_END, MANAGED_BLOCK_START, updateManagedIgnoreBlock } from '../src/core/git-sync.js';
import {
  checkSubpath,
  describePlan,
  finalizeInstall,
  hasDeclaredSources,
  isBareHub,
  planInstall,
  runInstall,
  updatePins,
} from '../src/core/installer.js';
import { loadLock, runtime, saveLock } from '../src/core/sources.js';

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });

describe('installer', () => {
  let tmp: string;
  let home: string;
  let hub: string;

  const writeManifest = (data: Record<string, unknown>) =>
    fs.writeFileSync(path.join(hub, 'agenthub.json'), JSON.stringify(data));
  const writeServers = (servers: Record<string, unknown>) => {
    fs.mkdirSync(path.join(hub, 'mcp'), { recursive: true });
    fs.writeFileSync(path.join(hub, 'mcp', 'servers.json'), JSON.stringify({ mcpServers: servers }));
  };
  const readServers = () => JSON.parse(fs.readFileSync(path.join(hub, 'mcp', 'servers.json'), 'utf-8')).mcpServers;

  // Fake git/npm: ls-remote answers with SHA, `npm view` with 1.2.3, everything else succeeds
  const mockTools = () =>
    vi.spyOn(runtime, 'spawn').mockImplementation((cmd, args) => {
      if (cmd === 'git' && args[0] === 'ls-remote') return ok(`${SHA}\tHEAD\n`);
      if (cmd === 'npm' && args[0] === 'view') return ok('"1.2.3"');
      return ok();
    });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-installer-'));
    home = path.join(tmp, 'home');
    hub = path.join(home, '.agenthub');
    fs.mkdirSync(path.join(hub, 'skills'), { recursive: true });
    setCustomHome(home, hub);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setCustomHome(null, null);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('detects declared sources and invalid declarations', () => {
    expect(hasDeclaredSources(hub)).toBe(false);
    writeManifest({ skills: { a: 'bogus' } });
    expect(hasDeclaredSources(hub)).toBe(true);
  });

  it('plans a missing github skill with the exact command and a pinned commit', async () => {
    writeManifest({ skills: { s: 'github:o/r#skills/s' } });
    mockTools();
    const plan = await planInstall(hub);
    expect(plan.errors).toEqual([]);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({ item: 's', kind: 'skills', type: 'github', reason: 'missing' });
    expect(plan.actions[0].commands).toEqual([
      `git init -q && git fetch -q --depth 1 -- https://github.com/o/r.git ${SHA} && git checkout -q --detach ${SHA}  (in vendor/skills/s)`,
    ]);
    expect(describePlan(plan)).toEqual(['skill s [missing]', `    ${plan.actions[0].commands[0]}`]);
    expect(plan.lock.skills.s).toEqual({ source: 'github:o/r#skills/s', commit: SHA });
    expect(fs.existsSync(path.join(hub, 'agenthub.lock.json'))).toBe(false);
  });

  it('uses the lockfile pin instead of resolving again', async () => {
    writeManifest({ skills: { s: 'github:o/r' } });
    saveLock(hub, { version: 1, skills: { s: { source: 'github:o/r', commit: SHA2 } }, mcp: {} });
    const spawn = mockTools();
    const plan = await planInstall(hub);
    expect(plan.actions[0].pin?.commit).toBe(SHA2);
    expect(spawn.mock.calls.some(([, args]) => args[0] === 'ls-remote')).toBe(false);
  });

  it('re-resolves when the declared source changed since the lock was written', async () => {
    writeManifest({ skills: { s: 'github:o/other' } });
    saveLock(hub, { version: 1, skills: { s: { source: 'github:o/r', commit: SHA2 } }, mcp: {} });
    mockTools();
    const plan = await planInstall(hub);
    expect(plan.lock.skills.s).toEqual({ source: 'github:o/other', commit: SHA });
  });

  it('plans nothing once installed, and marks a changed pin as outdated', async () => {
    writeManifest({ skills: { s: 'github:o/r' } });
    mockTools();
    const first = await planInstall(hub);
    fs.mkdirSync(path.join(hub, 'vendor', 'skills', 's'), { recursive: true });
    fs.mkdirSync(path.join(hub, 'vendor', '.pins'), { recursive: true });
    fs.writeFileSync(path.join(hub, 'vendor', '.pins', 'skills-s'), `${SHA}|`);
    expect((await planInstall(hub)).actions).toEqual([]);
    expect(first.actions).toHaveLength(1);

    saveLock(hub, { version: 1, skills: { s: { source: 'github:o/r', commit: SHA2 } }, mcp: {} });
    expect((await planInstall(hub)).actions[0].reason).toBe('outdated');
  });

  it('reports a missing tool as a per-item error and keeps planning the others', async () => {
    writeManifest({ skills: { a: 'github:o/r', b: { install: 'echo hi', check: 'false', path: '~/b' } } });
    saveLock(hub, { version: 1, skills: { a: { source: 'github:o/r', commit: SHA } }, mcp: {} });
    vi.spyOn(runtime, 'spawn').mockReturnValue({
      status: -1,
      stdout: '',
      stderr: '',
      error: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }),
    });
    vi.spyOn(runtime, 'shell').mockReturnValue({ status: 1, stdout: '', stderr: '' });
    const plan = await planInstall(hub);
    expect(plan.errors).toEqual([{ item: 'skill a', message: "'git' is not installed or not in PATH" }]);
    expect(plan.actions.map((a) => a.item)).toEqual(['b']);
  });

  it('plans custom items with both commands and never runs a hub-declared command while planning', async () => {
    writeManifest({ mcp: { t: { install: 'make install', check: 'which t' } }, skills: { l: 'local' } });
    writeServers({ t: { command: 't' } });
    fs.mkdirSync(path.join(hub, 'skills', 'l'), { recursive: true });
    const shell = vi.spyOn(runtime, 'shell').mockReturnValue(ok());
    const plan = await planInstall(hub);
    expect(shell).not.toHaveBeenCalled();
    expect(plan.actions[0]).toMatchObject({ item: 't', type: 'custom', reason: 'check' });
    expect(plan.actions[0].commands).toEqual(['check:   which t', 'install: make install  (only if check fails)']);
  });

  it('runs check after approval and skips install when it passes, or installs when it fails', async () => {
    writeManifest({ mcp: { t: { install: 'make install', check: 'which t' } } });
    writeServers({ t: { command: 't' } });
    const shell = vi.spyOn(runtime, 'shell').mockReturnValue(ok());
    const plan = await planInstall(hub);
    expect(runInstall(plan).failed).toEqual([]);
    expect(shell.mock.calls.map((c) => c[0])).toEqual(['which t']);

    shell.mockReset();
    let installed = false;
    shell.mockImplementation((cmd) => {
      if (cmd === 'make install') installed = true;
      return cmd === 'which t' && !installed ? { status: 1, stdout: '', stderr: '' } : ok();
    });
    expect(runInstall(plan).installed).toEqual(['mcp t']);
    expect(shell.mock.calls.map((c) => c[0])).toEqual(['which t', 'make install', 'which t']);
  });

  it('errors on a local item whose folder is missing and warns about missing MCP entries', async () => {
    writeManifest({ skills: { s: 'local' }, mcp: { m: 'local', n: 'npm:pkg' } });
    mockTools();
    const plan = await planInstall(hub);
    expect(plan.errors[0].message).toContain('skills/s/ does not exist');
    expect(plan.errors[1].message).toContain('mcp/servers/m/ does not exist');
    expect(plan.warnings).toEqual(['mcp m is declared but has no entry in mcp/servers.json']);
  });

  it('plans a local MCP build once and records it', async () => {
    writeManifest({ mcp: { m: { source: 'local', build: 'npm run build' } } });
    writeServers({ m: { command: 'node' } });
    fs.mkdirSync(path.join(hub, 'mcp', 'servers', 'm'), { recursive: true });
    const shell = vi.spyOn(runtime, 'shell').mockReturnValue(ok());
    const plan = await planInstall(hub);
    expect(plan.actions[0].commands).toEqual(['npm run build  (in mcp/servers/m)']);
    fs.writeFileSync(path.join(hub, 'mcp', 'servers', 'm', 'index.js'), 'v1');
    const result = runInstall(await planInstall(hub));
    expect(result.failed).toEqual([]);
    expect(shell).toHaveBeenCalledWith('npm run build', path.join(hub, 'mcp', 'servers', 'm'));
    expect((await planInstall(hub)).actions).toEqual([]);

    // Build outputs and node_modules do not count, source changes do
    fs.mkdirSync(path.join(hub, 'mcp', 'servers', 'm', 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(hub, 'mcp', 'servers', 'm', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(hub, 'mcp', 'servers', 'm', 'dist', 'out.js'), 'x');
    expect((await planInstall(hub)).actions).toEqual([]);
    fs.writeFileSync(path.join(hub, 'mcp', 'servers', 'm', 'index.js'), 'v2');
    const again = await planInstall(hub);
    expect(again.actions[0].reason).toBe('outdated');

    // A changed build string rebuilds too
    writeManifest({ mcp: { m: { source: 'local', build: 'make' } } });
    expect((await planInstall(hub)).actions[0].commands[0]).toContain('make');
  });

  it('isolates failures: one failing install does not stop the others', async () => {
    writeManifest({
      mcp: { bad: { install: 'boom', check: 'nope' }, good: { install: 'fine', check: 'checkgood' } },
    });
    writeServers({ bad: { command: 'x' }, good: { command: 'y' } });
    let installed = false;
    vi.spyOn(runtime, 'shell').mockImplementation((cmd) => {
      if (cmd === 'boom') return { status: 2, stdout: '', stderr: 'it broke' };
      if (cmd === 'fine') {
        installed = true;
        return ok();
      }
      return installed && cmd === 'checkgood' ? ok() : { status: 1, stdout: '', stderr: '' };
    });
    const plan = await planInstall(hub);
    expect(plan.actions).toHaveLength(2);
    const result = runInstall(plan);
    expect(result.installed).toEqual(['mcp good']);
    expect(result.failed).toEqual([{ item: 'mcp bad', message: 'install failed: it broke' }]);
  });

  describe('npm and pypi MCP servers', () => {
    it('generates servers.json entries from the locked version', async () => {
      writeManifest({ mcp: { n: 'npm:@s/pkg@^1', p: 'pypi:py-thing@2.0.0' } });
      mockTools();
      vi.spyOn(runtime, 'fetchJson').mockResolvedValue({ info: { version: '2.0.0' }, releases: {} });
      const plan = await planInstall(hub);
      expect(plan.actions).toEqual([]);
      runInstall(plan);
      expect(readServers()).toEqual({
        n: { command: 'npx', args: ['-y', '@s/pkg@1.2.3'] },
        p: { command: 'uvx', args: ['py-thing==2.0.0'] },
      });
      expect(loadLock(hub).mcp.n).toEqual({ source: 'npm:@s/pkg@^1', version: '1.2.3' });
    });

    it('keeps hand-written entries but moves the pinned version on update', async () => {
      writeManifest({ mcp: { n: 'npm:pkg' } });
      writeServers({ n: { command: 'npx', args: ['-y', 'pkg@0.1.0', '--flag'], env: { K: 'v' } } });
      mockTools();
      await updatePins(hub);
      finalizeInstall(hub);
      expect(readServers().n).toEqual({ command: 'npx', args: ['-y', 'pkg@1.2.3', '--flag'], env: { K: 'v' } });

      writeServers({ n: { command: 'node', args: ['custom.js'] } });
      finalizeInstall(hub);
      expect(readServers().n).toEqual({ command: 'node', args: ['custom.js'] });
    });

    it('errors per item when uvx is missing', async () => {
      writeManifest({ mcp: { p: 'pypi:thing@1.0.0' } });
      vi.spyOn(runtime, 'fetchJson').mockResolvedValue({});
      vi.spyOn(runtime, 'spawn').mockReturnValue({
        status: -1,
        stdout: '',
        stderr: '',
        error: Object.assign(new Error('x'), { code: 'ENOENT' }),
      });
      const plan = await planInstall(hub);
      expect(plan.errors[0].message).toContain("'uvx' is not installed");
    });
  });

  describe('finalizeInstall', () => {
    it('links vendored and custom skills, ignores them in git, and keeps local skills tracked', () => {
      const custom = path.join(home, 'acme', 'custom-skill');
      fs.mkdirSync(custom, { recursive: true });
      fs.writeFileSync(path.join(custom, 'SKILL.md'), '---\nname: c\ndescription: d\n---\n');
      fs.mkdirSync(path.join(hub, 'vendor', 'skills', 'v', 'skills', 'v'), { recursive: true });
      fs.mkdirSync(path.join(hub, 'skills', 'mine'), { recursive: true });
      writeManifest({
        skills: {
          mine: 'local',
          v: 'github:o/r#skills/v',
          c: { install: 'i', check: 'c', path: custom },
          pending: 'github:o/r#skills/pending',
        },
      });
      // The pending skill has no folder yet: that is reported, the others still link
      const problems = finalizeInstall(hub);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatchObject({ item: 'skill pending' });
      expect(problems[0].message).toContain('is not installed');
      expect(finalizeInstall(hub, ['skill pending'])).toEqual([]);

      const skills = path.join(hub, 'skills');
      expect(fs.lstatSync(path.join(skills, 'v')).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(path.join(skills, 'v'))).toBe(fs.realpathSync(path.join(hub, 'vendor', 'skills', 'v', 'skills', 'v')));
      expect(fs.realpathSync(path.join(skills, 'c'))).toBe(fs.realpathSync(custom));
      expect(fs.lstatSync(path.join(skills, 'mine')).isSymbolicLink()).toBe(false);
      expect(fs.existsSync(path.join(skills, 'pending'))).toBe(false);

      const ignore = fs.readFileSync(path.join(hub, '.gitignore'), 'utf-8');
      expect(ignore).toContain('/vendor/');
      expect(ignore).toContain(`${MANAGED_BLOCK_START}\n/skills/c\n/skills/pending\n/skills/v\n${MANAGED_BLOCK_END}`);
      expect(ignore).not.toContain('/skills/mine');
    });

    it('refuses to shadow a real folder and removes links of undeclared skills', () => {
      fs.mkdirSync(path.join(hub, 'vendor', 'skills', 'v'), { recursive: true });
      fs.mkdirSync(path.join(hub, 'vendor', 'skills', 'gone'), { recursive: true });
      fs.mkdirSync(path.join(hub, 'skills', 'v'), { recursive: true });
      fs.symlinkSync(path.join(hub, 'vendor', 'skills', 'gone'), path.join(hub, 'skills', 'gone'), 'dir');
      writeManifest({ skills: { v: 'github:o/r' } });
      const problems = finalizeInstall(hub);
      expect(problems).toHaveLength(1);
      expect(problems[0].message).toContain('a real folder is already there');
      expect(fs.existsSync(path.join(hub, 'skills', 'gone'))).toBe(false);
      expect(fs.lstatSync(path.join(hub, 'skills', 'v')).isSymbolicLink()).toBe(false);
    });
  });

  it('keeps the lock pin when only the subpath changed, and installs again if the folder is missing', async () => {
    writeManifest({ skills: { s: 'github:o/r#skills/new' } });
    saveLock(hub, { version: 1, skills: { s: { source: 'github:o/r#skills/old', commit: SHA2 } }, mcp: {} });
    const spawn = mockTools();
    fs.mkdirSync(path.join(hub, 'vendor', 'skills', 's', 'skills', 'old'), { recursive: true });
    fs.mkdirSync(path.join(hub, 'vendor', '.pins'), { recursive: true });
    fs.writeFileSync(path.join(hub, 'vendor', '.pins', 'skills-s'), `${SHA2}|`);
    const plan = await planInstall(hub);
    expect(spawn.mock.calls.some(([, args]) => args[0] === 'ls-remote')).toBe(false);
    expect(plan.lock.skills.s).toEqual({ source: 'github:o/r#skills/new', commit: SHA2 });
    // same commit, but skills/new is not in the vendored copy
    expect(plan.actions[0]).toMatchObject({ reason: 'outdated', pin: { commit: SHA2 } });

    fs.mkdirSync(path.join(hub, 'vendor', 'skills', 's', 'skills', 'new'), { recursive: true });
    expect((await planInstall(hub)).actions).toEqual([]);

    writeManifest({ skills: { s: { source: 'github:o/r#skills/new', ref: 'v2' } } });
    vi.spyOn(runtime, 'spawn').mockReturnValue(ok(`${SHA}\trefs/tags/v2\n`));
    expect((await planInstall(hub)).lock.skills.s.commit).toBe(SHA);
  });

  it('reports invalid lock entries as an error for that item', async () => {
    writeManifest({ skills: { s: 'github:o/r' } });
    fs.writeFileSync(
      path.join(hub, 'agenthub.lock.json'),
      JSON.stringify({ version: 1, skills: { s: { source: 'github:o/r', commit: '--upload-pack=x' } }, mcp: {} })
    );
    mockTools();
    const plan = await planInstall(hub);
    expect(plan.actions).toEqual([]);
    expect(plan.errors).toEqual([{ item: 'skill s', message: 'agenthub.lock.json: invalid commit "--upload-pack=x"' }]);
  });

  describe('custom skill paths', () => {
    const planFor = async (p: string) => {
      writeManifest({ skills: { c: { install: 'i', check: 'c', path: p } } });
      return planInstall(hub);
    };

    it('resolves relative paths against the hub, not the cwd', async () => {
      const inHub = path.join(hub, 'tools', 'c');
      fs.mkdirSync(inHub, { recursive: true });
      fs.writeFileSync(path.join(inHub, 'SKILL.md'), '---\nname: c\ndescription: d\n---\n');
      expect((await planFor('tools/c')).errors).toEqual([]);
      expect(finalizeInstall(hub, ['skill c'])).toEqual([]);
      const problems = finalizeInstall(hub);
      expect(problems).toEqual([]);
      expect(fs.realpathSync(path.join(hub, 'skills', 'c'))).toBe(fs.realpathSync(inHub));
    });

    it.each([
      ['/etc'],
      ['../../../outside'],
      ['~'],
      ['~/.ssh'],
      ['~/.config/x'],
    ])('rejects %s', async (p) => {
      const plan = await planFor(p);
      expect(plan.errors).toHaveLength(1);
      expect(plan.errors[0].message).toContain('must be inside the hub');
    });

    it('accepts a folder inside home', async () => {
      expect((await planFor('~/acme/skill')).errors).toEqual([]);
    });

    it.each([['~/.local/share/ripwire/skills/x'], ['~/.claude/plugins/cache/m/p/1/skills/x'], ['~/.agents/skills/x']])(
      'accepts the tool skill folder %s',
      async (p) => {
        expect((await planFor(p)).errors).toEqual([]);
      }
    );

    it.each([
      ['~/.local/share'],
      ['~/.local/share/keyrings'],
      ['~/.local/share/ripwire/data/x'],
      ['~/.local/bin/x'],
      ['~/.claude/settings'],
      ['~/.claude/plugins'],
      ['~/.agents/other'],
    ])('still rejects %s', async (p) => {
      expect((await planFor(p)).errors).toHaveLength(1);
    });

    it('follows symlinks before checking: a link from ~/.agents to ~/.ssh is rejected', async () => {
      fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
      fs.mkdirSync(path.join(home, '.agents', 'skills'), { recursive: true });
      fs.symlinkSync(path.join(home, '.ssh'), path.join(home, '.agents', 'skills', 'evil'));
      const plan = await planFor('~/.agents/skills/evil');
      expect(plan.errors).toHaveLength(1);
      expect(plan.errors[0].message).toContain('must be inside the hub');
    });

    it('requires a SKILL.md in an existing target', async () => {
      fs.mkdirSync(path.join(home, 'acme', 'noskill'), { recursive: true });
      const plan = await planFor('~/acme/noskill');
      expect(plan.errors[0].message).toContain('has no SKILL.md');
    });
  });

  it('removes links of undeclared custom-path skills that a previous run managed', () => {
    const custom = path.join(home, 'acme', 'c');
    fs.mkdirSync(custom, { recursive: true });
    fs.writeFileSync(path.join(custom, 'SKILL.md'), '---\nname: c\ndescription: d\n---\n');
    writeManifest({ skills: { c: { install: 'i', check: 'c', path: custom } } });
    expect(finalizeInstall(hub)).toEqual([]);
    expect(fs.existsSync(path.join(hub, 'skills', 'c'))).toBe(true);
    writeManifest({});
    finalizeInstall(hub);
    expect(fs.existsSync(path.join(hub, 'skills', 'c'))).toBe(false);
    expect(fs.existsSync(custom)).toBe(true);
  });

  it('updatePins re-resolves and reports changes, and rejects unknown names', async () => {
    writeManifest({ skills: { s: 'github:o/r', l: 'local' } });
    saveLock(hub, { version: 1, skills: { s: { source: 'github:o/r', commit: SHA2 } }, mcp: {} });
    mockTools();
    const res = await updatePins(hub, ['s', 'l', 'zzz']);
    expect(res.changes).toEqual([{ item: 'skill s', from: SHA2, to: SHA }]);
    expect(res.errors.map((e) => e.item)).toEqual(['l', 'zzz']);
    expect(loadLock(hub).skills.s.commit).toBe(SHA);
  });
});

describe('updateManagedIgnoreBlock', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-ignore-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('replaces only the managed block and removes it when empty', () => {
    const file = path.join(dir, '.gitignore');
    fs.writeFileSync(file, 'keep-me\n');
    updateManagedIgnoreBlock(dir, ['/skills/b', '/skills/a', '/skills/a']);
    expect(fs.readFileSync(file, 'utf-8')).toBe(`keep-me\n${MANAGED_BLOCK_START}\n/skills/a\n/skills/b\n${MANAGED_BLOCK_END}\n`);

    fs.appendFileSync(file, 'after-block\n');
    updateManagedIgnoreBlock(dir, ['/skills/c']);
    expect(fs.readFileSync(file, 'utf-8')).toBe(`keep-me\nafter-block\n${MANAGED_BLOCK_START}\n/skills/c\n${MANAGED_BLOCK_END}\n`);

    updateManagedIgnoreBlock(dir, []);
    expect(fs.readFileSync(file, 'utf-8')).toBe('keep-me\nafter-block\n');
  });

  it('keeps user lines when the end marker is missing, and preserves CRLF', () => {
    const file = path.join(dir, '.gitignore');
    fs.writeFileSync(file, `a\r\n${MANAGED_BLOCK_START}\r\nuser-line\r\n`);
    updateManagedIgnoreBlock(dir, ['/skills/x']);
    expect(fs.readFileSync(file, 'utf-8')).toBe(`a\r\nuser-line\r\n${MANAGED_BLOCK_START}\r\n/skills/x\r\n${MANAGED_BLOCK_END}\r\n`);
    updateManagedIgnoreBlock(dir, ['/skills/y']);
    expect(fs.readFileSync(file, 'utf-8')).toBe(`a\r\nuser-line\r\n${MANAGED_BLOCK_START}\r\n/skills/y\r\n${MANAGED_BLOCK_END}\r\n`);
  });

  it('creates the file when missing', () => {
    updateManagedIgnoreBlock(dir, ['/skills/x']);
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8')).toContain('/skills/x');
  });
});

describe('a bare hub', () => {
  it('gets no new files from install, runInstall or finalizeInstall', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-bare-'));
    const hub = path.join(tmp, 'hub');
    fs.mkdirSync(hub, { recursive: true });
    fs.writeFileSync(path.join(hub, 'agenthub.json'), JSON.stringify({ name: 'bare' }));
    const list = (): string[] => {
      const out: string[] = [];
      const walk = (d: string): void => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, e.name);
          out.push(path.relative(hub, full));
          if (e.isDirectory()) walk(full);
        }
      };
      walk(hub);
      return out.sort();
    };
    try {
      const before = list();
      expect(isBareHub(hub)).toBe(true);
      const plan = await planInstall(hub);
      expect(plan.actions).toEqual([]);
      runInstall(plan);
      expect(finalizeInstall(hub)).toEqual([]);
      expect(list()).toEqual(before);

      // declaring something ends the bare state
      fs.writeFileSync(path.join(hub, 'agenthub.json'), JSON.stringify({ name: 'bare', skills: {} }));
      expect(isBareHub(hub)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('checkSubpath', () => {
  it('accepts a folder, rejects a missing one and a symlink that leaves the checkout', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-subpath-'));
    try {
      const root = path.join(tmp, 'checkout');
      fs.mkdirSync(path.join(root, 'skills', 'ok'), { recursive: true });
      fs.mkdirSync(path.join(tmp, 'outside'));
      fs.symlinkSync(path.join(tmp, 'outside'), path.join(root, 'skills', 'escape'));
      fs.symlinkSync(path.join(root, 'skills', 'ok'), path.join(root, 'skills', 'inner-link'));
      expect(() => checkSubpath(root, 'skills/ok', 'x')).not.toThrow();
      expect(() => checkSubpath(root, 'skills/inner-link', 'x')).not.toThrow();
      expect(() => checkSubpath(root, undefined, 'x')).not.toThrow();
      expect(() => checkSubpath(root, 'skills/nope', 'x')).toThrow('not found');
      expect(() => checkSubpath(root, 'skills/escape', 'x')).toThrow('leads outside the checkout');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
