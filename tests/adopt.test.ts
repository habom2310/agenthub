import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isDedicatedDir, isToolBinPath, pluginOfPath, readRemoteUrl, runAdopt, scanAdoptable, sourceFromRemote, type AdoptChoice, type AdoptItem, type AdoptPrompter } from '../src/core/adopt.js';
import { loadManifest } from '../src/core/manifest.js';
import { createJunction, ensureDir, safeWriteFile } from '../src/utils/fs.js';

describe('adopt', () => {
  let tmp: string;
  let home: string;
  let hub: string;
  const skillMd = (name: string) => `---\nname: ${name}\ndescription: d\n---\n`;
  const mkSkill = (dir: string, name: string) => safeWriteFile(path.join(dir, 'SKILL.md'), skillMd(name));
  const find = (items: AdoptItem[], kind: string, name: string) => items.find((i) => i.kind === kind && i.name === name) as AdoptItem;
  // mode: 'fetched' = one commit that origin was last seen at, 'ahead' = a newer local commit, 'none' = no commit yet
  const gitInit = (dir: string, remote?: string, mode: 'fetched' | 'ahead' | 'none' = 'fetched'): string | undefined => {
    ensureDir(dir);
    const git = (...a: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf-8' });
    git('init', '-q');
    if (remote) git('remote', 'add', 'origin', remote);
    if (mode === 'none') return undefined;
    git('commit', '-q', '--allow-empty', '-m', 'one');
    const first = git('rev-parse', 'HEAD').stdout.trim();
    safeWriteFile(path.join(dir, '.git', 'refs', 'remotes', 'origin', 'main'), first + '\n');
    safeWriteFile(path.join(dir, '.git', 'refs', 'remotes', 'origin', 'HEAD'), 'ref: refs/remotes/origin/main\n');
    if (mode === 'ahead') git('commit', '-q', '--allow-empty', '-m', 'two');
    return git('rev-parse', 'HEAD').stdout.trim();
  };
  const hubServers = () => JSON.parse(fs.readFileSync(path.join(hub, 'mcp', 'servers.json'), 'utf-8')).mcpServers;
  const claudeJson = (servers: Record<string, unknown>) => safeWriteFile(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: servers }));

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-adopt-'));
    tmp = fs.realpathSync(tmp);
    home = path.join(tmp, 'home');
    hub = path.join(tmp, 'hub');
    ensureDir(path.join(home, '.claude', 'skills'));
    ensureDir(path.join(hub, 'skills'));
    safeWriteFile(path.join(hub, 'agenthub.json'), JSON.stringify({ name: 'h' }));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  describe('remote URLs', () => {
    it('maps GitHub remotes to github: and strips credentials from other hosts', () => {
      expect(sourceFromRemote('https://github.com/acme/skills.git')?.base).toBe('github:acme/skills');
      expect(sourceFromRemote('https://ghp_secret:x-oauth@github.com/acme/skills')?.base).toBe('github:acme/skills');
      expect(sourceFromRemote('git@github.com:acme/skills.git')?.base).toBe('github:acme/skills');
      expect(sourceFromRemote('https://user:pw@gitlab.com/g/p.git')?.base).toBe('git:https://gitlab.com/g/p.git');
      expect(sourceFromRemote('https://TOKEN@gitlab.com/g/p.git')?.base).toBe('git:https://gitlab.com/g/p.git');
      expect(sourceFromRemote('git@gitlab.com:g/p.git')?.base).toBe('git:ssh://git@gitlab.com/g/p.git');
      expect(sourceFromRemote('/srv/local/repo')).toBeNull();
    });

    it('reads origin from .git/config without running git', () => {
      const repo = path.join(tmp, 'r');
      ensureDir(path.join(repo, '.git'));
      fs.writeFileSync(path.join(repo, '.git', 'config'), '[remote "up"]\n\turl = https://a/b\n[remote "origin"]\n\turl = https://c/d.git\n');
      expect(readRemoteUrl(repo)).toBe('https://c/d.git');
    });

    it('parses plugin and marketplace from plugin paths', () => {
      const p = (...s: string[]) => path.join(home, '.claude', 'plugins', ...s);
      expect(pluginOfPath(p('cache', 'mkt', 'plug', '1.0', 'skills', 'x'), home)).toBe('plug@mkt');
      expect(pluginOfPath(p('marketplaces', 'mkt', 'plugins', 'plug', 'skills', 'x'), home)).toBe('plug@mkt');
    });
  });

  describe('skill inference', () => {
    it('symlink into a git checkout with a GitHub remote -> github:owner/repo#subpath', () => {
      const repo = path.join(tmp, 'code', 'skill-repo');
      const sha = gitInit(repo, 'https://tok@github.com/acme/skill-repo.git');
      mkSkill(path.join(repo, 'skills', 'alpha'), 'alpha');
      fs.symlinkSync(path.join(repo, 'skills', 'alpha'), path.join(home, '.claude', 'skills', 'alpha'));
      const item = find(scanAdoptable(home, hub), 'skills', 'alpha');
      expect(item.proposal).toMatchObject({ spec: { source: 'github:acme/skill-repo#skills/alpha', ref: sha }, confident: true });
      expect(item.proposal?.note).toContain('pinned to it; local edits not checked');
      expect(JSON.stringify(item)).not.toContain('tok');
    });

    it('a checkout ahead of the remote, or never fetched, or without a readable commit, is not confident', () => {
      const ahead = path.join(tmp, 'code', 'ahead');
      const aheadSha = gitInit(ahead, 'https://github.com/acme/ahead.git', 'ahead');
      mkSkill(ahead, 'ahead');
      fs.symlinkSync(ahead, path.join(home, '.claude', 'skills', 'ahead'));
      const fresh = path.join(tmp, 'code', 'fresh');
      gitInit(fresh, 'https://github.com/acme/fresh.git', 'none');
      mkSkill(fresh, 'fresh');
      fs.symlinkSync(fresh, path.join(home, '.claude', 'skills', 'fresh'));

      const items = scanAdoptable(home, hub);
      const a = find(items, 'skills', 'ahead').proposal;
      expect(a).toMatchObject({ confident: false, spec: { source: 'github:acme/ahead', ref: aheadSha } });
      expect(a?.note).toContain('differs from origin');
      expect(a?.note).toContain('may not exist on the remote');
      const f = find(items, 'skills', 'fresh').proposal;
      expect(f).toMatchObject({ confident: false, spec: 'github:acme/fresh' });
      expect(f?.note).toContain('could not be read');
    });

    it('a checkout at another host -> git:<url>, subpath omitted at the repo root', () => {
      const repo = path.join(tmp, 'code', 'beta');
      const sha = gitInit(repo, 'https://u:pw@gitlab.example/g/beta.git');
      mkSkill(repo, 'beta');
      fs.symlinkSync(repo, path.join(home, '.claude', 'skills', 'beta'));
      expect(find(scanAdoptable(home, hub), 'skills', 'beta').proposal).toMatchObject({
        spec: { source: 'git:https://gitlab.example/g/beta.git', ref: sha },
        confident: true,
      });
    });

    it('symlink into a tool-managed dir -> custom with a check and a question for the install command', () => {
      const tool = path.join(home, '.local', 'share', 'ripwire', 'skills');
      for (const n of ['one', 'two']) {
        mkSkill(path.join(tool, n), n);
        fs.symlinkSync(path.join(tool, n), path.join(home, '.claude', 'skills', n));
      }
      const items = scanAdoptable(home, hub);
      const p = find(items, 'skills', 'one').proposal;
      expect(p).toMatchObject({
        confident: false,
        needs: 'install',
        spec: { install: '', check: 'test -f "$HOME/.local/share/ripwire/skills/one/SKILL.md"', path: '~/.local/share/ripwire/skills/one' },
      });
      expect(find(items, 'skills', 'two')).toBeDefined();
    });

    it('plain folder with no git -> self-built, with the move into the hub', () => {
      mkSkill(path.join(home, '.claude', 'skills', 'plain'), 'plain');
      const item = find(scanAdoptable(home, hub), 'skills', 'plain');
      expect(item.proposal).toBeUndefined();
      expect(item.selfBuilt).toMatchObject({
        spec: 'local',
        move: { from: path.join(home, '.claude', 'skills', 'plain'), to: path.join(hub, 'skills', 'plain') },
      });
    });

    it('a hub skill in a hub that is itself a git repo is self-built, not a checkout of the hub', () => {
      gitInit(hub, 'https://github.com/me/hub.git');
      mkSkill(path.join(hub, 'skills', 'inhub'), 'inhub');
      const item = find(scanAdoptable(home, hub), 'skills', 'inhub');
      expect(item.proposal).toBeUndefined();
      expect(item.selfBuilt?.move).toBeUndefined();
    });

    it('Claude plugin skills are report-only, with an optional custom source', () => {
      const real = path.join(home, '.claude', 'plugins', 'cache', 'mkt', 'plug', '1.0', 'skills', 'pskill');
      mkSkill(real, 'pskill');
      fs.symlinkSync(real, path.join(home, '.claude', 'skills', 'pskill'));
      const item = find(scanAdoptable(home, hub), 'skills', 'pskill');
      expect(item.report).toContain('plugin');
      expect(item.proposal).toMatchObject({
        confident: false,
        spec: { install: 'claude plugin install plug@mkt', path: expect.stringContaining('.claude/plugins/cache/mkt/plug/1.0/skills/pskill') },
      });
    });

    it('skips declared skills, dot entries, .old backups and folders without SKILL.md', () => {
      mkSkill(path.join(hub, 'skills', 'declared'), 'declared');
      safeWriteFile(path.join(hub, 'agenthub.json'), JSON.stringify({ name: 'h', skills: { declared: 'local' } }));
      mkSkill(path.join(home, '.claude', 'skills', 'x.old'), 'x');
      mkSkill(path.join(home, '.claude', 'skills', '.system'), 'sys');
      ensureDir(path.join(home, '.claude', 'skills', 'noskill'));
      expect(scanAdoptable(home, hub).filter((i) => i.kind === 'skills')).toEqual([]);
    });

    it('lists a skill once with every place it was seen, and does not scan a hub link twice', () => {
      mkSkill(path.join(hub, 'skills', 'shared'), 'shared');
      fs.rmSync(path.join(home, '.claude', 'skills'), { recursive: true });
      createJunction(path.join(hub, 'skills'), path.join(home, '.claude', 'skills'));
      ensureDir(path.join(home, '.copilot', 'skills'));
      createJunction(path.join(hub, 'skills'), path.join(home, '.copilot', 'skills'));
      const skills = scanAdoptable(home, hub).filter((i) => i.kind === 'skills');
      expect(skills).toHaveLength(1);
      expect(skills[0].found).toHaveLength(1);
    });
  });

  describe('MCP inference', () => {
    it('npx -> npm:, uvx -> pypi:', () => {
      claudeJson({
        a: { command: 'npx', args: ['-y', '@acme/mcp@1.2.3', '--flag'] },
        b: { command: 'npx', args: ['plain-pkg'] },
        c: { command: 'uvx', args: ['my-server==0.4.1'] },
        d: { command: 'uvx', args: ['my-server'] },
        e: { command: 'npx', args: ['-p', 'x', 'y'] },
      });
      const items = scanAdoptable(home, hub);
      expect(find(items, 'mcp', 'a').proposal).toMatchObject({ spec: 'npm:@acme/mcp@1.2.3', confident: true });
      expect(find(items, 'mcp', 'b').proposal).toMatchObject({ spec: 'npm:plain-pkg', confident: true });
      expect(find(items, 'mcp', 'c').proposal).toMatchObject({ spec: 'pypi:my-server@0.4.1', confident: true });
      expect(find(items, 'mcp', 'd').proposal).toMatchObject({ spec: 'pypi:my-server', confident: true });
      expect(find(items, 'mcp', 'e').proposal?.confident).toBe(false);
    });

    it('uvx with a flag before the package is not inferred, except flags that take no value', () => {
      claudeJson({
        withflag: { command: 'uvx', args: ['--python', '3.12', 'mcp-x'] },
        withfrom: { command: 'uvx', args: ['--from', 'git+https://x/y', 'mcp-y'] },
        quiet: { command: 'uvx', args: ['--quiet', 'mcp-z==1.0'] },
      });
      const items = scanAdoptable(home, hub);
      expect(find(items, 'mcp', 'withflag').proposal).toMatchObject({ confident: false, needs: 'install' });
      expect(JSON.stringify(find(items, 'mcp', 'withflag').proposal)).not.toContain('pypi:');
      expect(JSON.stringify(find(items, 'mcp', 'withfrom').proposal)).not.toContain('pypi:');
      expect(find(items, 'mcp', 'quiet').proposal).toMatchObject({ spec: 'pypi:mcp-z@1.0', confident: true });
    });

    it('a directory name with shell syntax stays text in the generated check command', () => {
      const dir = path.join(home, '.local', 'share', 'tool', 'skills', '$(touch pwned)');
      mkSkill(dir, 'evil');
      fs.symlinkSync(dir, path.join(home, '.claude', 'skills', 'evil'));
      const p = find(scanAdoptable(home, hub), 'skills', 'evil').proposal;
      expect((p?.spec as any).check).toBe('test -f "$HOME/.local/share/tool/skills/\\$(touch pwned)/SKILL.md"');
    });

    it('a command inside a git checkout -> git: with the paths rewritten into vendor/', () => {
      const repo = path.join(tmp, 'code', 'srv');
      const sha = gitInit(repo, 'git@gitlab.example:g/srv.git');
      safeWriteFile(path.join(repo, 'server.py'), 'print(1)');
      safeWriteFile(path.join(repo, 'dist', 'main.js'), '');
      claudeJson({ py: { command: 'python3', args: [path.join(repo, 'server.py')] }, built: { command: 'node', args: [path.join(repo, 'dist', 'main.js')] } });
      const items = scanAdoptable(home, hub);
      expect(find(items, 'mcp', 'py').proposal).toMatchObject({
        spec: { source: 'git:ssh://git@gitlab.example/g/srv.git', ref: sha },
        confident: true,
        rewrite: { from: repo, to: '${HUB}/vendor/mcp/py' },
      });
      expect(find(items, 'mcp', 'built').proposal).toMatchObject({ confident: false, needs: 'build' });
    });

    it('a command on PATH -> custom with command -v and a question for install', () => {
      claudeJson({ tool: { command: 'agenthub-fake-tool', args: ['serve'] } });
      expect(find(scanAdoptable(home, hub), 'mcp', 'tool').proposal).toMatchObject({
        confident: false,
        needs: 'install',
        spec: { install: '', check: 'command -v agenthub-fake-tool' },
      });
    });

    it('a script in a dedicated folder under home -> move the whole folder into hub/mcp/servers/<name>', () => {
      const dir = path.join(home, 'tools', 'hook-server');
      safeWriteFile(path.join(dir, 'my-mcp.sh'), '#!/bin/sh\n');
      safeWriteFile(path.join(dir, 'lib.sh'), '# helper\n');
      claudeJson({ hook: { command: path.join(dir, 'my-mcp.sh') } });
      const p = find(scanAdoptable(home, hub), 'mcp', 'hook').proposal;
      expect(p).toMatchObject({
        spec: 'local',
        confident: false,
        move: { from: dir, to: path.join(hub, 'mcp', 'servers', 'hook') },
        rewrite: { from: dir, to: '${HUB}/mcp/servers/hook' },
      });
    });

    it('a folder with its own package.json or pyproject.toml is dedicated; a shared hooks folder is not', () => {
      const pkg = path.join(home, 'x', 'whatever');
      safeWriteFile(path.join(pkg, 'package.json'), '{}');
      expect(isDedicatedDir(pkg, 'srv', home)).toBe(true);
      const py = path.join(home, 'y', 'else');
      safeWriteFile(path.join(py, 'pyproject.toml'), '');
      expect(isDedicatedDir(py, 'srv', home)).toBe(true);
      expect(isDedicatedDir(path.join(home, '.claude', 'hooks'), 'hooks', home)).toBe(false);
      expect(isDedicatedDir(path.join(home, 'misc'), 'srv', home)).toBe(false);
      expect(isDedicatedDir(home, 'srv', home)).toBe(false);
    });

    it('a lone script in a shared folder is not moved: custom with the reason', () => {
      const script = path.join(home, '.claude', 'hooks', 'my-mcp.sh');
      safeWriteFile(script, '#!/bin/sh\n');
      claudeJson({ hook: { command: script } });
      const p = find(scanAdoptable(home, hub), 'mcp', 'hook').proposal;
      expect(p?.move).toBeUndefined();
      expect(p).toMatchObject({ confident: false, needs: 'install', spec: { install: '', check: 'test -e "$HOME/.claude/hooks/my-mcp.sh"' } });
      expect(p?.note).toContain('holds other files too');
    });

    it('never proposes moving a binary from a PATH or tool bin directory', () => {
      for (const rel of ['.local/bin', '.cargo/bin', '.bun/bin', '.npm-global/lib/node_modules/x/bin']) {
        const bin = path.join(home, rel, 'tool');
        safeWriteFile(bin, '#!/bin/sh\n');
        expect(isToolBinPath(bin, home)).toBe(true);
      }
      expect(isToolBinPath(path.join(home, 'proj', 'node_modules', '.bin', 'x'), home)).toBe(true);
      expect(isToolBinPath(path.join(home, '.venv', 'bin', 'x'), home)).toBe(true);
      expect(isToolBinPath('/opt/homebrew/bin/x', home)).toBe(true);
      expect(isToolBinPath(path.join(home, 'mine', 'x.sh'), home)).toBe(false);

      const bin = path.join(home, '.local', 'bin', 'my-server');
      safeWriteFile(bin, '#!/bin/sh\n');
      claudeJson({ srv: { command: bin } });
      const p = find(scanAdoptable(home, hub), 'mcp', 'srv').proposal;
      expect(p?.move).toBeUndefined();
      expect(p).toMatchObject({ spec: { install: '', check: 'command -v my-server' }, needs: 'install' });
      expect(p?.note).toContain('managed by a tool');
    });

    it('a remote server has nothing to adopt, and a declared one is skipped', () => {
      claudeJson({ remote: { url: 'https://x.example/mcp' }, done: { command: 'npx', args: ['y'] } });
      safeWriteFile(path.join(hub, 'agenthub.json'), JSON.stringify({ name: 'h', mcp: { done: 'npm:y' } }));
      const items = scanAdoptable(home, hub).filter((i) => i.kind === 'mcp');
      expect(items.map((i) => i.name)).toEqual(['remote']);
      expect(items[0].report).toContain('remote');
    });
  });

  describe('modes', () => {
    let sha: string | undefined;
    const setupMixed = () => {
      claudeJson({ npmsrv: { command: 'npx', args: ['-y', 'some-pkg@1.0.0'] }, pathsrv: { command: 'agenthub-fake-tool' } });
      mkSkill(path.join(home, '.claude', 'skills', 'plain'), 'plain');
      const repo = path.join(tmp, 'code', 'sr');
      sha = gitInit(repo, 'https://github.com/acme/sr.git');
      mkSkill(repo, 'gitskill');
      fs.symlinkSync(repo, path.join(home, '.claude', 'skills', 'gitskill'));
    };
    const before = () => fs.readFileSync(path.join(hub, 'agenthub.json'), 'utf-8');

    it('--dry-run and non-TTY preview change nothing', async () => {
      setupMixed();
      const orig = before();
      for (const opts of [{ dryRun: true, yes: true }, {}]) {
        const report = await runAdopt({ homeDir: home, hubDir: hub, ...opts });
        expect(report.mode).toBe(opts.dryRun ? 'dry-run' : 'preview');
        expect(report.items.length).toBe(4);
        expect(report.applied).toEqual([]);
      }
      expect(before()).toBe(orig);
      expect(fs.existsSync(path.join(home, '.claude', 'skills', 'plain.old'))).toBe(false);
    });

    it('--yes applies confident inferences only and skips the rest', async () => {
      setupMixed();
      const report = await runAdopt({ homeDir: home, hubDir: hub, yes: true });
      expect(report.mode).toBe('auto');
      expect(report.applied.map((a) => a.item).sort()).toEqual(['mcp npmsrv', 'skill gitskill']);
      expect(report.skipped.map((s) => s.item).sort()).toEqual(['mcp pathsrv', 'skill plain']);
      const manifest = loadManifest(hub) as any;
      expect(manifest.skills).toEqual({ gitskill: { source: 'github:acme/sr', ref: sha } });
      expect(manifest.mcp).toEqual({ npmsrv: 'npm:some-pkg@1.0.0' });
      expect(hubServers().npmsrv).toEqual({ command: 'npx', args: ['-y', 'some-pkg@1.0.0'] });
      expect(fs.existsSync(path.join(home, '.claude', 'skills', 'plain', 'SKILL.md'))).toBe(true);
    });
  });

  describe('interactive', () => {
    const prompter = (choices: Record<string, AdoptChoice>, answers: string[] = []): AdoptPrompter => ({
      async choose(item) {
        return choices[`${item.kind}:${item.name}`] ?? 'skip';
      },
      async ask() {
        return answers.shift() ?? '';
      },
    });

    it('self-built moves the folder into the hub, keeps the original in backups/ and declares local', async () => {
      mkSkill(path.join(home, '.claude', 'skills', 'plain'), 'plain');
      const report = await runAdopt({ homeDir: home, hubDir: hub, prompter: prompter({ 'skills:plain': 'self-built' }) });
      expect(report.applied).toHaveLength(1);
      expect(fs.existsSync(path.join(hub, 'skills', 'plain', 'SKILL.md'))).toBe(true);
      const backups = fs.readdirSync(path.join(hub, 'backups')).filter((d) => d.startsWith('adopt-'));
      expect(fs.existsSync(path.join(hub, 'backups', backups[0], 'skills', 'plain', 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(home, '.claude', 'skills', 'plain'))).toBe(false);
      expect(fs.existsSync(path.join(home, '.claude', 'skills', 'plain.old'))).toBe(false);
      expect((loadManifest(hub) as any).skills).toEqual({ plain: 'local' });
    });

    it('accept with an install command declares the custom source; an empty one skips', async () => {
      const tool = path.join(home, '.local', 'share', 't', 'skills', 'ts');
      mkSkill(tool, 'ts');
      fs.symlinkSync(tool, path.join(home, '.claude', 'skills', 'ts'));
      const skipped = await runAdopt({ homeDir: home, hubDir: hub, prompter: prompter({ 'skills:ts': 'accept' }, ['']) });
      expect(skipped.applied).toEqual([]);

      const report = await runAdopt({ homeDir: home, hubDir: hub, prompter: prompter({ 'skills:ts': 'accept' }, ['tool install ts']) });
      expect(report.applied).toHaveLength(1);
      expect((loadManifest(hub) as any).skills.ts).toEqual({
        install: 'tool install ts',
        check: 'test -f "$HOME/.local/share/t/skills/ts/SKILL.md"',
        path: '~/.local/share/t/skills/ts',
      });
    });

    it('enter source validates the text; a bad one is skipped with the reason', async () => {
      mkSkill(path.join(home, '.claude', 'skills', 'plain'), 'plain');
      const bad = await runAdopt({ homeDir: home, hubDir: hub, prompter: prompter({ 'skills:plain': 'source' }, ['bogus:thing']) });
      expect(bad.skipped[0].reason).toContain('unknown source');
      const good = await runAdopt({ homeDir: home, hubDir: hub, prompter: prompter({ 'skills:plain': 'source' }, ['github:acme/plain']) });
      expect(good.applied[0].declared).toBe('github:acme/plain');
    });

    it('moves a dedicated MCP folder into the hub and keeps the original in backups/, not beside it', async () => {
      const dir = path.join(home, 'tools', 'hook-server');
      safeWriteFile(path.join(dir, 'my-mcp.sh'), '#!/bin/sh\necho hi\n');
      safeWriteFile(path.join(home, 'tools', 'hook-server-extra'), 'neighbour');
      claudeJson({ hook: { command: path.join(dir, 'my-mcp.sh'), args: ['--x', `${dir}-other`] } });
      const report = await runAdopt({ homeDir: home, hubDir: hub, prompter: prompter({ 'mcp:hook': 'accept' }) });
      expect(report.applied).toHaveLength(1);
      expect(fs.readFileSync(path.join(hub, 'mcp', 'servers', 'hook', 'my-mcp.sh'), 'utf-8')).toContain('echo hi');
      expect(fs.existsSync(dir)).toBe(false);
      expect(fs.existsSync(`${dir}.old`)).toBe(false);
      const backups = fs.readdirSync(path.join(hub, 'backups')).filter((d) => d.startsWith('adopt-'));
      expect(fs.existsSync(path.join(hub, 'backups', backups[0], 'mcp', 'hook', 'my-mcp.sh'))).toBe(true);
      // /path/hook-server-other is a different path: not rewritten
      expect(hubServers().hook).toEqual({ command: '${HUB}/mcp/servers/hook/my-mcp.sh', args: ['--x', `${dir}-other`.replace(home, '${HOME}')] });
      expect((loadManifest(hub) as any).mcp).toEqual({ hook: 'local' });
    });

    it('a failed copy leaves no partial destination and the original untouched', async () => {
      const dir = path.join(home, 'tools', 'hook-server');
      safeWriteFile(path.join(dir, 'my-mcp.sh'), 'x');
      fs.symlinkSync(path.join(tmp, 'missing-target'), path.join(dir, 'dangling'));
      claudeJson({ hook: { command: path.join(dir, 'my-mcp.sh') } });
      const spy = vi.spyOn(fs, 'cpSync').mockImplementation((_a, b) => {
        fs.mkdirSync(String(b), { recursive: true });
        throw new Error('disk full');
      });
      const report = await runAdopt({ homeDir: home, hubDir: hub, prompter: prompter({ 'mcp:hook': 'accept' }) });
      spy.mockRestore();
      expect(report.skipped[0].reason).toContain('disk full');
      expect(fs.existsSync(path.join(hub, 'mcp', 'servers', 'hook'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'my-mcp.sh'))).toBe(true);
    });

    it('git MCP: a build command from the user becomes the source object', async () => {
      const repo = path.join(tmp, 'code', 'built');
      const sha = gitInit(repo, 'https://github.com/acme/built.git');
      safeWriteFile(path.join(repo, 'dist', 'main.js'), '');
      claudeJson({ built: { command: 'node', args: [path.join(repo, 'dist', 'main.js')] } });
      await runAdopt({ homeDir: home, hubDir: hub, prompter: prompter({ 'mcp:built': 'accept' }, ['npm ci && npm run build']) });
      expect((loadManifest(hub) as any).mcp.built).toEqual({ source: 'github:acme/built', ref: sha, build: 'npm ci && npm run build' });
      expect(hubServers().built.args).toEqual(['${HUB}/vendor/mcp/built/dist/main.js']);
    });

    it('never replaces an existing destination', async () => {
      mkSkill(path.join(home, '.claude', 'skills', 'plain'), 'plain');
      mkSkill(path.join(hub, 'skills', 'plain'), 'plain');
      const report = await runAdopt({ homeDir: home, hubDir: hub, prompter: prompter({ 'skills:plain': 'self-built' }) });
      expect(report.applied).toEqual([]);
      expect(report.skipped[0].reason).toContain('already exists, not replacing it');
      expect(fs.existsSync(path.join(home, '.claude', 'skills', 'plain', 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(home, '.claude', 'skills', 'plain.old'))).toBe(false);
    });
  });
});
