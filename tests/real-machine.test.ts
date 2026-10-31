import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAdopt, scanAdoptable } from '../src/core/adopt.js';
import { runCli } from '../src/cli.js';
import { setCustomHome } from '../src/core/detector.js';
import { skillItems, sourceItems } from '../src/core/doctor-full.js';
import { finalizeInstall, planInstall, runInstall } from '../src/core/installer.js';
import { runtime } from '../src/core/sources.js';
import { gitInitHub, gitPush, ignoreMachineSpecificSkills } from '../src/core/git-sync.js';
import { buildPackagePayload } from '../src/core/registry.js';
import { createJunction } from '../src/utils/fs.js';

const git = (cwd: string, ...args: string[]) =>
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@test', ...args], { cwd, encoding: 'utf-8' });

const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const skillMd = (name: string) => `---\nname: ${name}\ndescription: d\n---\n# ${name}\n`;

describe.skipIf(process.platform === 'win32')('findings from a real machine', () => {
  let tmp: string;
  let logs: string[];

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-real-')));
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setCustomHome(null, null);
    process.exitCode = undefined;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('A+B+C: collections and custom-path links are never pushed, check-only sources are valid and manual', async () => {
    const bare = path.join(tmp, 'hub.git');
    git(tmp, 'init', '-q', '--bare', '-b', 'main', bare);

    const oldHome = path.join(tmp, 'old');
    const oldHub = path.join(oldHome, '.agenthub');
    const skills = path.join(oldHome, '.claude', 'skills');
    write(path.join(skills, 'mine', 'SKILL.md'), skillMd('mine'));
    write(path.join(skills, 'synced', 'org-uuid', 'licensed', 'SKILL.md'), skillMd('licensed'));
    write(path.join(oldHome, '.codex', 'skills', '.system', 'sys-skill', 'SKILL.md'), skillMd('sys-skill'));
    write(path.join(oldHome, '.codex', 'skills', 'codex-primary-runtime', 'rt', 'SKILL.md'), skillMd('rt'));
    const tool = path.join(oldHome, '.local', 'share', 'ripwire', 'skills', 'ripwire-find-bug');
    write(path.join(tool, 'SKILL.md'), skillMd('ripwire-find-bug'));
    fs.symlinkSync(tool, path.join(skills, 'ripwire-find-bug'));

    await runCli(['-H', oldHome, 'setup']);
    expect(process.exitCode).toBeUndefined();

    // the collections keep working where they are, through the link
    expect(fs.existsSync(path.join(skills, 'synced', 'org-uuid', 'licensed', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(oldHome, '.codex', 'skills', '.system', 'sys-skill', 'SKILL.md'))).toBe(true);

    // a check-only declaration (what adopt proposes) is valid
    const manifestPath = path.join(oldHub, 'agenthub.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    manifest.skills = {
      mine: 'local',
      'ripwire-find-bug': { check: `test -f "${path.join(tool, 'SKILL.md')}"`, path: tool },
    };
    write(manifestPath, JSON.stringify(manifest, null, 2));

    logs.length = 0;
    await runCli(['-H', oldHome, 'git', 'init', '--remote-url', bare]);
    await runCli(['-H', oldHome, 'push']);
    expect(process.exitCode).toBeUndefined();
    expect(logs.join('\n')).not.toContain('needs both');

    const tracked = git(oldHub, 'ls-files', '-s').stdout.split('\n').filter(Boolean);
    const names = tracked.map((l) => l.split('\t')[1]);
    expect(names).toContain('skills/mine/SKILL.md');
    expect(names.filter((n) => /synced|\.system|codex-primary-runtime|ripwire/.test(n))).toEqual([]);
    expect(tracked.filter((l) => l.startsWith('120000'))).toEqual([]);

    const ignore = fs.readFileSync(path.join(oldHub, '.gitignore'), 'utf-8');
    expect(ignore).toContain('/skills/synced');
    expect(ignore).toContain('/skills/.*/');
    expect(ignore).toContain('/skills/codex-primary-runtime');

    // a fresh clone has neither the collections nor a dangling link
    const clone = path.join(tmp, 'clone');
    git(tmp, 'clone', '-q', bare, clone);
    const cloned = fs.readdirSync(path.join(clone, 'skills')).sort();
    expect(cloned).toEqual(['mine']);

    // doctor: collections pass, nothing about them fails
    logs.length = 0;
    await runCli(['-H', oldHome, 'doctor', '--no-functional']);
    const out = logs.join('\n');
    expect(out).toContain('collection synced: 1 nested skills (managed by Claude)');
    expect(out).toContain('collection .system: 1 nested skills (managed by Codex)');
    expect(out).toContain('collection codex-primary-runtime: 1 nested skills (managed by Codex)');
    expect(out).not.toContain('SKILL.md is missing');
    expect(out).not.toMatch(/do not resolve/);
  });

  it('A: an entry with neither SKILL.md nor nested skills still fails; adopt skips collections', async () => {
    const home = path.join(tmp, 'home');
    const hub = path.join(tmp, 'hub');
    write(path.join(hub, 'skills', 'empty-dir', 'notes.txt'), 'x');
    write(path.join(hub, 'skills', 'synced', 'uuid', 's', 'SKILL.md'), skillMd('s'));
    write(path.join(hub, 'skills', '.system', 'x', 'SKILL.md'), skillMd('x'));
    write(path.join(hub, 'agenthub.json'), JSON.stringify({ name: 'h' }));
    fs.mkdirSync(home, { recursive: true });

    const items = skillItems(home, hub);
    expect(items.find((i) => i.name === 'skill empty-dir')).toMatchObject({ level: 'FAIL' });
    expect(items.find((i) => i.name === 'collection synced')).toMatchObject({ level: 'PASS', message: '1 nested skills (managed by Claude)' });
    expect(items.find((i) => i.name === 'collection .system')).toMatchObject({ level: 'PASS' });
    expect(items.some((i) => i.name === 'skill synced')).toBe(false);
    expect(scanAdoptable(home, hub).filter((i) => i.kind === 'skills')).toEqual([]);
  });

  it('C: a check-only source plans as manual, is a warning, never blocks, and adopt writes it without install', async () => {
    const hub = path.join(tmp, 'hub');
    write(path.join(hub, 'agenthub.json'), JSON.stringify({ name: 'h', mcp: { tool: { check: 'false' } } }));
    write(path.join(hub, 'mcp', 'servers.json'), JSON.stringify({ mcpServers: { tool: { command: 'tool' } } }));

    const plan = await planInstall(hub);
    expect(plan.errors).toEqual([]);
    expect(plan.actions[0]).toMatchObject({ reason: 'manual' });
    expect(plan.actions[0].commands.join('\n')).toContain('install it yourself, then re-run');
    expect(plan.actions[0].commands.join('\n')).toContain('check:   false');

    const shell = vi.spyOn(runtime, 'shell').mockImplementation(() => ({ status: 1, stdout: '', stderr: '' }));
    const result = runInstall(plan);
    shell.mockRestore();
    expect(result.failed).toEqual([]);
    expect(result.installed).toEqual([]);
    expect(result.manual).toEqual([{ item: 'mcp tool', message: 'install it yourself, then re-run (check: false)' }]);

    vi.spyOn(runtime, 'shell').mockImplementation(() => ({ status: 1, stdout: '', stderr: '' }));
    const items = await sourceItems(hub, true);
    expect(items.find((i) => i.name === 'mcp tool')).toMatchObject({ level: 'WARN' });
  });

  it('C: install is still run for a custom source that has one, and a check-only object round-trips through adopt', async () => {
    const home = path.join(tmp, 'home');
    const hub = path.join(tmp, 'hub');
    const bin = path.join(home, '.local', 'bin');
    write(path.join(bin, 'my-tool'), '#!/bin/sh\n');
    fs.chmodSync(path.join(bin, 'my-tool'), 0o755);
    write(path.join(hub, 'agenthub.json'), JSON.stringify({ name: 'h' }));
    write(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { mine: { command: path.join(bin, 'my-tool') } } }));

    const report = await runAdopt({ homeDir: home, hubDir: hub, prompter: { choose: async () => 'accept', ask: async () => '' } });
    expect(report.applied).toHaveLength(1);
    const declared = JSON.parse(fs.readFileSync(path.join(hub, 'agenthub.json'), 'utf-8')).mcp.mine;
    expect(declared).toEqual({ check: 'command -v my-tool' });
    expect('install' in declared).toBe(false);
    expect((await planInstall(hub)).errors).toEqual([]);
  });

  it('D: setup exits 0 when the user already has their own codegraph, and their entry wins', async () => {
    const home = path.join(tmp, 'home');
    const hub = path.join(home, '.agenthub');
    const wrapper = path.join(home, '.claude', 'hooks', 'codegraph-mcp.sh');
    write(wrapper, '#!/bin/sh\n');
    write(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { codegraph: { type: 'stdio', command: wrapper, args: [] } } }));

    await runCli(['-H', home, 'setup']);
    expect(logs.join('\n')).not.toContain('MCP registry out of sync');
    expect(process.exitCode).toBeUndefined();

    const servers = JSON.parse(fs.readFileSync(path.join(hub, 'mcp', 'servers.json'), 'utf-8')).mcpServers;
    expect(servers.codegraph.command).toBe('${HOME}/.claude/hooks/codegraph-mcp.sh');
    const origins = JSON.parse(fs.readFileSync(path.join(hub, 'mcp', 'origins.json'), 'utf-8'));
    expect(origins.codegraph.from).toEqual(['claude']);
    // the starter source declaration (npm install -g ...) is gone, so nothing was installed
    expect(JSON.parse(fs.readFileSync(path.join(hub, 'agenthub.json'), 'utf-8')).mcp).toBeUndefined();
    expect(logs.join('\n')).not.toContain('npm install -g');
  });

  it('D: a customised hub entry or declaration is left alone, and conflicts name a working fix', async () => {
    const home = path.join(tmp, 'home');
    const hub = path.join(home, '.agenthub');
    write(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { codegraph: { type: 'stdio', command: 'mine', args: [] } } }));
    await runCli(['-H', home, 'setup', '--scaffold-only']);
    write(path.join(hub, 'mcp', 'servers.json'), JSON.stringify({ mcpServers: { codegraph: { command: 'codegraph', args: ['serve', '--mcp', '--extra'] } } }));

    logs.length = 0;
    await runCli(['-H', home, 'setup']);
    expect(process.exitCode).toBe(1);
    const out = logs.join('\n');
    expect(out).toContain('agenthub mcp sync --force');
    expect(out).toContain('or rename one of them');
    expect(JSON.parse(fs.readFileSync(path.join(hub, 'mcp', 'servers.json'), 'utf-8')).mcpServers.codegraph.args).toContain('--extra');

    process.exitCode = undefined;
    await runCli(['-H', home, 'mcp', 'sync', '--force']);
    const claude = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf-8'));
    expect(claude.mcpServers.codegraph.command).toBe('codegraph');
  });

  it('G: custom items plan as [check]; a passing check reports already installed and counts nothing as new', async () => {
    const home = path.join(tmp, 'home');
    await runCli(['-H', home, 'setup', '--scaffold-only']);
    const file = path.join(home, '.agenthub', 'agenthub.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf-8'));
    manifest.mcp = { tool: { install: 'false', check: 'true' } };
    write(file, JSON.stringify(manifest));

    logs.length = 0;
    await runCli(['-H', home, 'install', '--yes']);
    const out = logs.join('\n');
    expect(out).toContain('mcp tool [check]');
    expect(out).not.toContain('[missing]');
    expect(out).toContain('tool: already installed (check passed)');
    expect(out).not.toContain('Installed mcp tool');
    expect(out).toContain('✓ Skills and MCP servers are installed');
    expect(out).not.toContain('new)');
    expect(process.exitCode).toBeUndefined();

    manifest.mcp = { tool: { install: 'touch "$X_MARK"', check: 'test -f "$X_MARK"' } };
    write(file, JSON.stringify(manifest));
    process.env.X_MARK = path.join(tmp, 'mark');
    logs.length = 0;
    await runCli(['-H', home, 'install', '--yes']);
    delete process.env.X_MARK;
    expect(logs.join('\n')).toContain('✓ Installed mcp tool');
    expect(logs.join('\n')).toContain('(1 new)');
  });

  it('the committed .gitignore is identical on every machine: both directions stay clean after pull, install, sync and setup', async () => {
    const mk = (name: string, withCollections: boolean) => {
      const home = path.join(tmp, name);
      write(path.join(home, '.claude', 'skills', 'mine', 'SKILL.md'), skillMd('mine'));
      if (withCollections) {
        write(path.join(home, '.claude', 'skills', 'synced', 'u', 's', 'SKILL.md'), skillMd('s'));
        write(path.join(home, '.codex', 'skills', '.system', 'x', 'SKILL.md'), skillMd('x'));
        write(path.join(home, '.codex', 'skills', 'codex-primary-runtime', 'r', 'SKILL.md'), skillMd('r'));
        const tool = path.join(home, '.local', 'share', 'ripwire', 'skills', 'ripwire-find-bug');
        write(path.join(tool, 'SKILL.md'), skillMd('ripwire-find-bug'));
        fs.symlinkSync(tool, path.join(home, '.claude', 'skills', 'ripwire-find-bug'));
      } else {
        fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
      }
      return home;
    };
    const status = (home: string) => git(path.join(home, '.agenthub'), 'status', '--porcelain').stdout.trim();

    for (const [pusher, puller] of [['a', 'b'], ['b', 'a']]) {
      logs.length = 0;
      const bare = path.join(tmp, `hub-${pusher}.git`);
      git(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
      const homes: Record<string, string> = { a: mk(`${pusher}-a`, true), b: mk(`${pusher}-b`, false) };
      const from = homes[pusher];
      const to = homes[puller];

      await runCli(['-H', from, 'setup']);
      const file = path.join(from, '.agenthub', 'agenthub.json');
      const manifest = JSON.parse(fs.readFileSync(file, 'utf-8'));
      manifest.skills = { mine: 'local', 'ripwire-find-bug': { check: 'true', path: '~/.local/share/ripwire/skills/ripwire-find-bug' } };
      write(file, JSON.stringify(manifest, null, 2));
      await runCli(['-H', from, 'install', '--yes']);
      await runCli(['-H', from, 'git', 'init', '--remote-url', bare]);
      await runCli(['-H', from, 'push']);
      expect(status(from)).toBe('');

      await runCli(['-H', to, 'setup']);
      await runCli(['-H', to, 'git', 'init', '--remote-url', bare]);
      await runCli(['-H', to, 'pull', '--yes']);
      expect(status(to)).toBe('');
      await runCli(['-H', to, 'install', '--yes']);
      await runCli(['-H', to, 'mcp', 'sync']);
      await runCli(['-H', to, 'setup']);
      expect(status(to)).toBe('');
      expect(status(from)).toBe('');
      await runCli(['-H', from, 'install', '--yes']);
      expect(status(from)).toBe('');

      const block = git(path.join(to, '.agenthub'), 'show', 'HEAD:.gitignore').stdout;
      expect(block).toContain('/skills/ripwire-find-bug');
      expect(block).not.toMatch(/\/skills\/(synced|\.system|codex-primary-runtime)\n/);
    }
  });

  it('a committed .gitignore block with machine-specific entries is rewritten to the declared ones', async () => {
    const home = path.join(tmp, 'migrate');
    const hub = path.join(home, '.agenthub');
    write(path.join(hub, 'agenthub.json'), JSON.stringify({ name: 'h', skills: { vend: 'github:acme/vend' } }));
    write(
      path.join(hub, '.gitignore'),
      ['backups/', '# >>> agenthub managed (do not edit)', '/skills/.system', '/skills/synced', '/skills/vend', '/skills/work', '# <<< agenthub managed', ''].join('\n')
    );
    finalizeInstall(hub);
    const lines = fs.readFileSync(path.join(hub, '.gitignore'), 'utf-8').split('\n');
    const block = lines.slice(lines.indexOf('# >>> agenthub managed (do not edit)') + 1, lines.indexOf('# <<< agenthub managed'));
    expect(block).toEqual(['/skills/vend']);
  });

  describe('H: machine-local ignore list', () => {
    const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf-8'));

    it('an ignored server in Claude is not ingested or touched; doctor lists it and does not probe it', async () => {
      const home = path.join(tmp, 'home');
      const hub = path.join(home, '.agenthub');
      const marker = path.join(tmp, 'probed');
      const own = { type: 'stdio', command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '1')`] };
      const claude = { mcpServers: { 'entain-gitlab': own, atlassian: { type: 'http', url: 'https://x.example/mcp' }, keep: { type: 'stdio', command: 'keep', args: [] } } };
      write(path.join(home, '.claude.json'), JSON.stringify(claude));
      await runCli(['-H', home, 'setup', '--scaffold-only']);
      await runCli(['-H', home, 'ignore', 'mcp', 'entain-gitlab', 'atlassian']);
      write(path.join(hub, 'agenthub.json'), JSON.stringify({ ...readJson(path.join(hub, 'agenthub.json')), mcp: undefined }));

      await runCli(['-H', home, 'mcp', 'sync']);
      const servers = readJson(path.join(hub, 'mcp', 'servers.json')).mcpServers;
      expect(Object.keys(servers)).toEqual(expect.arrayContaining(['keep']));
      expect(servers['entain-gitlab']).toBeUndefined();
      expect(servers.atlassian).toBeUndefined();
      expect(readJson(path.join(home, '.claude.json')).mcpServers['entain-gitlab']).toEqual(own);
      expect(Object.keys(readJson(path.join(home, '.claude.json')).mcpServers)).toContain('atlassian');

      logs.length = 0;
      await runCli(['-H', home, 'mcp', 'status']);
      expect(logs.join('\n')).not.toMatch(/untracked: [^;)]*(entain-gitlab|atlassian)/);

      logs.length = 0;
      await runCli(['-H', home, 'doctor']);
      const out = logs.join('\n');
      expect(out).toContain('[INFO]');
      expect(out).toContain('ignored (local): entain-gitlab, atlassian');
      expect(fs.existsSync(marker)).toBe(false);

      logs.length = 0;
      await runCli(['-H', home, 'ignore']);
      expect(logs.join('\n')).toContain('entain-gitlab, atlassian');

      await runCli(['-H', home, 'git', 'init']);
      git(hub, 'add', '-A');
      expect(git(hub, 'ls-files').stdout).not.toContain('local.json');
    });

    it('a server already in the hub is removed from the hub files but stays in the platform files', async () => {
      const home = path.join(tmp, 'home');
      const hub = path.join(home, '.agenthub');
      write(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { work: { type: 'stdio', command: 'work-mcp', args: [] } } }));
      await runCli(['-H', home, 'setup', '--scaffold-only']);
      await runCli(['-H', home, 'mcp', 'sync']);
      expect(readJson(path.join(hub, 'mcp', 'servers.json')).mcpServers.work).toBeDefined();
      expect(readJson(path.join(hub, 'mcp', 'origins.json')).work).toBeDefined();
      const manifest = readJson(path.join(hub, 'agenthub.json'));
      manifest.mcp = { ...manifest.mcp, work: { check: 'true' } };
      write(path.join(hub, 'agenthub.json'), JSON.stringify(manifest));

      await runCli(['-H', home, 'ignore', 'mcp', 'work']);
      expect(readJson(path.join(hub, 'mcp', 'servers.json')).mcpServers.work).toBeUndefined();
      expect(readJson(path.join(hub, 'mcp', 'origins.json')).work).toBeUndefined();
      expect(readJson(path.join(hub, 'agenthub.json')).mcp.work).toBeUndefined();
      expect(readJson(path.join(home, '.claude.json')).mcpServers.work).toEqual({ type: 'stdio', command: 'work-mcp', args: [] });

      await runCli(['-H', home, 'ignore', '--remove', 'mcp', 'work']);
      await runCli(['-H', home, 'mcp', 'sync']);
      expect(readJson(path.join(hub, 'mcp', 'servers.json')).mcpServers.work).toBeDefined();
    });

    it('an ignored skill still links but is not committed, and adopt skips it', async () => {
      const home = path.join(tmp, 'home');
      const hub = path.join(home, '.agenthub');
      write(path.join(home, '.claude', 'skills', 'work-only', 'SKILL.md'), skillMd('work-only'));
      write(path.join(home, '.claude', 'skills', 'mine', 'SKILL.md'), skillMd('mine'));
      await runCli(['-H', home, 'setup']);
      await runCli(['-H', home, 'ignore', 'skill', 'work-only']);
      expect(scanAdoptable(home, hub).map((i) => i.name)).not.toContain('work-only');
      expect(scanAdoptable(home, hub).map((i) => i.name)).toContain('mine');
      expect(fs.existsSync(path.join(home, '.claude', 'skills', 'work-only', 'SKILL.md'))).toBe(true);

      const bare = path.join(tmp, 'hub.git');
      git(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
      await runCli(['-H', home, 'git', 'init', '--remote-url', bare]);
      await runCli(['-H', home, 'push']);
      const tracked = git(hub, 'ls-files').stdout;
      expect(tracked).toContain('skills/mine/SKILL.md');
      expect(tracked).not.toContain('work-only');
      expect(tracked).not.toContain('local.json');
    });
  });
});

// These run on every platform: no POSIX shell is needed
describe('review follow-ups', () => {
  let tmp: string;
  let logs: string[];
  const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf-8'));

  beforeEach(() => {
    // deliberately not realpath'd: on macOS /var is a link to /private/var
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-follow-'));
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
    process.exitCode = undefined;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setCustomHome(null, null);
    process.exitCode = undefined;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('push untracks collections, ignored skills and outside links that were committed before, keeping the files', async () => {
    const hub = path.join(tmp, 'hub');
    write(path.join(hub, 'skills', 'mine', 'SKILL.md'), skillMd('mine'));
    write(path.join(hub, 'skills', 'synced', 'uuid', 's', 'SKILL.md'), skillMd('s'));
    write(path.join(hub, 'skills', 'work-only', 'SKILL.md'), skillMd('work-only'));
    write(path.join(tmp, 'outside', 'SKILL.md'), skillMd('ext'));
    createJunction(path.join(tmp, 'outside'), path.join(hub, 'skills', 'ext'));
    write(path.join(hub, 'local.json'), JSON.stringify({ ignore: { mcp: [], skills: ['work-only'] } }));
    expect(gitInitHub(hub).ok).toBe(true);
    git(hub, 'add', '-A', '-f');
    git(hub, 'commit', '-q', '-m', 'before');
    const before = git(hub, 'ls-files').stdout;
    expect(before).toContain('skills/synced/uuid/s/SKILL.md');
    expect(before).toContain('skills/work-only/SKILL.md');
    expect(before).toMatch(/skills\/ext/);

    const res = gitPush({ hubDir: hub, message: 'after' });
    expect(res.message).toContain('Stopped tracking');
    expect(res.message).toContain('files stay on disk');
    const after = git(hub, 'ls-files').stdout;
    expect(after).toContain('skills/mine/SKILL.md');
    expect(after).not.toMatch(/synced|work-only|skills\/ext/);
    expect(fs.existsSync(path.join(hub, 'skills', 'synced', 'uuid', 's', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(hub, 'skills', 'work-only', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(hub, 'skills', 'ext', 'SKILL.md'))).toBe(true);
    expect(git(hub, 'status', '--porcelain').stdout.trim()).toBe('');
  });

  it('links to an outside folder or into vendor/ are excluded, a link to a folder inside the hub is not', () => {
    const hub = path.join(tmp, 'hub');
    write(path.join(hub, 'vendor', 'skills', 'v', 'SKILL.md'), skillMd('v'));
    write(path.join(hub, 'elsewhere', 'inner', 'SKILL.md'), skillMd('inner'));
    write(path.join(tmp, 'outside', 'o', 'SKILL.md'), skillMd('o'));
    createJunction(path.join(hub, 'vendor', 'skills', 'v'), path.join(hub, 'skills', 'vendored'));
    createJunction(path.join(tmp, 'outside', 'o'), path.join(hub, 'skills', 'outer'));
    createJunction(path.join(hub, 'elsewhere', 'inner'), path.join(hub, 'skills', 'inner'));
    gitInitHub(hub);

    const paths = ignoreMachineSpecificSkills(hub);
    expect(paths).toEqual(['skills/outer', 'skills/vendored']);
    const exclude = fs.readFileSync(path.join(hub, '.git', 'info', 'exclude'), 'utf-8');
    expect(exclude).toContain('/skills/outer');
    expect(exclude).toContain('/skills/vendored');
    expect(exclude).not.toContain('/skills/inner');
  });

  it('push untracks a committed export/ folder and keeps the files on disk', () => {
    const hub = path.join(tmp, 'hub');
    write(path.join(hub, 'rules', 'common.md'), '# r\n');
    write(path.join(hub, 'export', 'chatgpt_custom_instructions.md'), 'generated\n');
    gitInitHub(hub);
    git(hub, 'add', '-A', '-f');
    git(hub, 'commit', '-q', '-m', 'before');
    expect(git(hub, 'ls-files').stdout).toContain('export/chatgpt_custom_instructions.md');

    const res = gitPush({ hubDir: hub, message: 'after' });
    expect(res.message).toContain('Stopped tracking export');
    expect(git(hub, 'ls-files').stdout).not.toContain('export/');
    expect(fs.existsSync(path.join(hub, 'export', 'chatgpt_custom_instructions.md'))).toBe(true);
    expect(git(hub, 'status', '--porcelain').stdout.trim()).toBe('');
    expect(fs.readFileSync(path.join(hub, '.gitignore'), 'utf-8')).toContain('/export/');
  });

  it('the registry payload skips ignored skills and collections', () => {
    const hub = path.join(tmp, 'hub');
    write(path.join(hub, 'skills', 'mine', 'SKILL.md'), skillMd('mine'));
    write(path.join(hub, 'skills', 'work-only', 'SKILL.md'), skillMd('w'));
    write(path.join(hub, 'skills', 'synced', 'u', 's', 'SKILL.md'), skillMd('s'));
    write(path.join(hub, 'skills', '.system', 'x', 'SKILL.md'), skillMd('x'));
    write(path.join(hub, 'local.json'), JSON.stringify({ ignore: { mcp: [], skills: ['work-only'] } }));
    const skills = buildPackagePayload(hub).skills as Array<{ name: string }>;
    expect(skills.map((s) => s.name)).toEqual(['mine']);
  });

  it('ignore validates names; adopt only trusts clean package names', async () => {
    const home = path.join(tmp, 'home');
    await runCli(['-H', home, 'setup', '--scaffold-only']);
    for (const bad of ['..', '.', '.hidden', 'a b', 'x;y']) {
      process.exitCode = undefined;
      logs.length = 0;
      await runCli(['-H', home, 'ignore', 'mcp', bad]);
      expect(process.exitCode).toBe(1);
      expect(logs.join('\n')).toContain('Invalid name');
    }
    process.exitCode = undefined;
    await runCli(['-H', home, 'ignore', 'skill', '_ok-1.x']);
    expect(process.exitCode).toBeUndefined();
    expect(readJson(path.join(home, '.agenthub', 'local.json')).ignore.skills).toEqual(['_ok-1.x']);

    const evil = path.join(home, '.local', 'pipx', 'venvs', '.hidden', 'bin', 'tool');
    write(evil, '#!/bin/sh\n');
    fs.chmodSync(evil, 0o755);
    const npmEvil = path.join(home, '.n', 'lib', 'node_modules', '_x', 'bin', 'tool2');
    write(npmEvil, '#!/bin/sh\n');
    fs.chmodSync(npmEvil, 0o755);
    write(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { a: { command: evil }, b: { command: npmEvil } } }));
    const items = scanAdoptable(home, path.join(home, '.agenthub'));
    for (const n of ['a', 'b']) {
      const spec = items.find((i) => i.name === n)?.proposal?.spec as Record<string, string>;
      expect(spec?.install).toBeUndefined();
    }
  });

  it('doctor: known collections PASS, dot-directories INFO, other nested-skill folders WARN and stay committed', () => {
    const home = path.join(tmp, 'home');
    const hub = path.join(tmp, 'hub');
    fs.mkdirSync(home, { recursive: true });
    write(path.join(hub, 'skills', 'synced', 'u', 's', 'SKILL.md'), skillMd('s'));
    write(path.join(hub, 'skills', '.cache', 'x', 'SKILL.md'), skillMd('x'));
    write(path.join(hub, 'skills', 'my-pack', 'a', 'SKILL.md'), skillMd('a'));
    const items = skillItems(home, hub);
    expect(items.find((i) => i.name === 'collection synced')).toMatchObject({ level: 'PASS' });
    expect(items.find((i) => i.name === 'collection .cache')).toMatchObject({ level: 'INFO', message: expect.stringContaining('not committed') });
    const unknown = items.find((i) => i.name === 'collection my-pack');
    expect(unknown?.level).toBe('WARN');
    expect(unknown?.message).toBe('looks like a skill collection; not managed by agenthub, will be committed');
    gitInitHub(hub);
    const paths = ignoreMachineSpecificSkills(hub);
    expect(paths).toEqual(['skills/.cache', 'skills/synced']);
  });

  it('H: after ignore, a pull that brings the entry back leaves the hub clean and does not project it', async () => {
    const bare = path.join(tmp, 'hub.git');
    git(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
    const home = path.join(tmp, 'home');
    const hub = path.join(home, '.agenthub');
    const claudeServers = { work: { type: 'stdio', command: 'work-mcp', args: [] }, keep: { type: 'stdio', command: 'keep-mcp', args: [] } };
    write(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: claudeServers }));
    await runCli(['-H', home, 'setup', '--scaffold-only']);
    await runCli(['-H', home, 'mcp', 'sync']);
    await runCli(['-H', home, 'git', 'init', '--remote-url', bare]);
    await runCli(['-H', home, 'push']);
    expect(git(hub, 'show', 'HEAD:mcp/servers.json').stdout).toContain('work-mcp');

    await runCli(['-H', home, 'ignore', 'mcp', 'work']);
    expect(logs.join('\n')).toContain('Removed locally ignored server(s) from the hub: work');
    await runCli(['-H', home, 'push']);
    expect(git(hub, 'show', 'HEAD:mcp/servers.json').stdout).not.toContain('work-mcp');

    // a collaborator puts it back
    const other = path.join(tmp, 'other');
    git(tmp, 'clone', '-q', bare, other);
    const file = path.join(other, 'mcp', 'servers.json');
    const data = readJson(file);
    data.mcpServers.work = { type: 'stdio', command: 'work-mcp', args: [] };
    write(file, JSON.stringify(data, null, 2) + '\n');
    git(other, 'commit', '-q', '-am', 'readd');
    git(other, 'push', '-q', 'origin', 'main');

    // a second assistant, so projection would be visible
    fs.mkdirSync(path.join(home, '.gemini', 'config'), { recursive: true });
    write(path.join(home, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: {} }));

    await runCli(['-H', home, 'pull']);
    expect(readJson(path.join(hub, 'mcp', 'servers.json')).mcpServers.work).toBeDefined();
    // (export/ is generated by pull's reprojection and is not related to MCP)
    const shared = ['--', 'mcp', 'agenthub.json', 'agenthub.lock.json', '.gitignore', 'skills'];
    expect(git(hub, 'status', '--porcelain', ...shared).stdout.trim()).toBe('');
    expect(readJson(path.join(home, '.claude.json')).mcpServers).toMatchObject(claudeServers);
    expect(readJson(path.join(home, '.gemini', 'config', 'mcp_config.json')).mcpServers.work).toBeUndefined();
    expect(readJson(path.join(home, '.gemini', 'config', 'mcp_config.json')).mcpServers.keep).toBeDefined();

    // sync again: still nothing rewritten
    await runCli(['-H', home, 'mcp', 'sync']);
    expect(git(hub, 'status', '--porcelain', ...shared).stdout.trim()).toBe('');
  });

  it('D: when several assistants have their own starter entry, the first wins and the others are reported as conflicts', async () => {
    const home = path.join(tmp, 'home');
    write(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { codegraph: { type: 'stdio', command: 'claude-cg', args: [] } } }));
    write(path.join(home, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: { codegraph: { type: 'stdio', command: 'gemini-cg', args: [] } } }));
    await runCli(['-H', home, 'setup', '--scaffold-only']);
    logs.length = 0;
    await runCli(['-H', home, 'mcp', 'sync']);
    const out = logs.join('\n');
    expect(readJson(path.join(home, '.agenthub', 'mcp', 'servers.json')).mcpServers.codegraph.command).toBe('claude-cg');
    expect(out).toContain('[CONFLICT]');
    expect(out).toContain('mcp sync --force');
    expect(readJson(path.join(home, '.gemini', 'config', 'mcp_config.json')).mcpServers.codegraph.command).toBe('gemini-cg');
  });
});
