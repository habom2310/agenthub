import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { setCustomHome } from '../src/core/detector.js';

const git = (cwd: string, ...args: string[]) =>
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@test', ...args], { cwd, encoding: 'utf-8' });

const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

// Posix shell commands in the custom install, so skip on Windows
describe.skipIf(process.platform === 'win32')('E2E: declared skills and MCP servers across machines', () => {
  let tmp: string;
  let logs: string[];
  const savedTools = process.env.E2E_TOOLS;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-e2e-src-'));
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setCustomHome(null, null);
    process.exitCode = undefined;
    if (savedTools === undefined) delete process.env.E2E_TOOLS;
    else process.env.E2E_TOOLS = savedTools;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('old machine pushes declarations only; new machine setup + pull --yes installs them', async () => {
    // A third-party skill repo, reachable through a file:// URL
    const skillRepo = path.join(tmp, 'skill-repo');
    write(path.join(skillRepo, 'skills', 'remote-skill', 'SKILL.md'), '---\nname: remote-skill\ndescription: Remote\n---\n# Remote');
    git(tmp, 'init', '-q', '-b', 'main', skillRepo);
    git(skillRepo, 'add', '-A');
    git(skillRepo, 'commit', '-q', '-m', 'init');
    const skillSha = git(skillRepo, 'rev-parse', 'HEAD').stdout.trim();

    const bare = path.join(tmp, 'hub.git');
    git(tmp, 'init', '-q', '--bare', '-b', 'main', bare);

    const customInstall = {
      install: 'mkdir -p "$E2E_TOOLS" && echo "// server" > "$E2E_TOOLS/server.js"',
      check: 'test -f "$E2E_TOOLS/server.js"',
    };

    // ---- old machine ----
    const oldHome = path.join(tmp, 'old');
    const oldHub = path.join(oldHome, '.agenthub');
    fs.mkdirSync(path.join(oldHome, '.claude'), { recursive: true });
    process.env.E2E_TOOLS = path.join(tmp, 'old-tools');

    await runCli(['-H', oldHome, 'setup']);
    write(path.join(oldHub, 'skills', 'mine', 'SKILL.md'), '---\nname: mine\ndescription: Mine\n---\n# Mine');
    const manifestPath = path.join(oldHub, 'agenthub.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    manifest.skills = { mine: 'local', 'remote-skill': `git:file://${skillRepo}#skills/remote-skill` };
    manifest.mcp = { tool: customInstall };
    write(manifestPath, JSON.stringify(manifest, null, 2));
    write(
      path.join(oldHub, 'mcp', 'servers.json'),
      JSON.stringify({ mcpServers: { tool: { command: 'node', args: ['${HOME}/tools/server.js'], env: { HUBDIR: '${HUB}' } } } })
    );

    await runCli(['-H', oldHome, 'install', '--yes']);
    expect(process.exitCode).toBeUndefined();
    expect(fs.existsSync(path.join(oldHub, 'vendor', 'skills', 'remote-skill', 'skills', 'remote-skill', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(process.env.E2E_TOOLS, 'server.js'))).toBe(true);

    await runCli(['-H', oldHome, 'git', 'init', '--remote-url', bare]);
    await runCli(['-H', oldHome, 'push']);
    expect(process.exitCode).toBeUndefined();

    const tracked = git(oldHub, 'ls-files').stdout.split('\n');
    expect(tracked).toContain('skills/mine/SKILL.md');
    expect(tracked).toContain('agenthub.lock.json');
    expect(tracked.filter((f) => f.startsWith('vendor/') || f.startsWith('skills/remote-skill'))).toEqual([]);
    const lock = JSON.parse(git(oldHub, 'show', 'HEAD:agenthub.lock.json').stdout);
    expect(lock.skills['remote-skill'].commit).toBe(skillSha);

    // ---- new machine ----
    const newHome = path.join(tmp, 'new');
    const newHub = path.join(newHome, '.agenthub');
    fs.mkdirSync(path.join(newHome, '.claude'), { recursive: true });
    process.env.E2E_TOOLS = path.join(tmp, 'new-tools');

    await runCli(['-H', newHome, 'setup']);
    await runCli(['-H', newHome, 'git', 'init', '--remote-url', bare]);
    logs.length = 0;
    await runCli(['-H', newHome, 'pull', '--yes']);
    const out = logs.join('\n');
    // the fixture server.js is not a real MCP server, so only the functional probe of it fails
    expect(out).toContain('[FAIL] tool: exited with code');
    process.exitCode = undefined;
    expect(out).toContain('Install plan (2)');
    expect(out).toContain('mkdir -p "$E2E_TOOLS"');

    // Skills resolve through ~/.claude/skills, the vendored one is not tracked
    const claudeSkills = path.join(newHome, '.claude', 'skills');
    expect(fs.readFileSync(path.join(claudeSkills, 'mine', 'SKILL.md'), 'utf-8')).toContain('# Mine');
    expect(fs.readFileSync(path.join(claudeSkills, 'remote-skill', 'SKILL.md'), 'utf-8')).toContain('# Remote');
    expect(git(newHub, 'ls-files').stdout).not.toMatch(/vendor\/|skills\/remote-skill/);
    expect(git(newHub, 'status', '--porcelain').stdout).not.toContain('remote-skill');

    // The lockfile pin was honored and the custom install ran on this machine
    expect(JSON.parse(fs.readFileSync(path.join(newHub, 'agenthub.lock.json'), 'utf-8')).skills['remote-skill'].commit).toBe(skillSha);
    expect(fs.readFileSync(path.join(process.env.E2E_TOOLS, 'server.js'), 'utf-8')).toContain('// server');

    // MCP server projected with paths expanded for this machine
    const claudeJson = JSON.parse(fs.readFileSync(path.join(newHome, '.claude.json'), 'utf-8'));
    expect(claudeJson.mcpServers.tool).toMatchObject({
      command: 'node',
      args: [path.join(newHome, 'tools', 'server.js')],
      env: { HUBDIR: newHub },
    });
    expect(JSON.stringify(claudeJson)).not.toContain('${');
    expect(JSON.parse(fs.readFileSync(path.join(newHub, 'mcp', 'servers.json'), 'utf-8')).mcpServers.tool.args).toEqual([
      '${HOME}/tools/server.js',
    ]);

    // A second install only lists the custom item, whose check runs after approval and passes
    logs.length = 0;
    await runCli(['-H', newHome, 'install', '--yes']);
    expect(logs.join('\n')).toContain('Install plan (1)');
    expect(logs.join('\n')).not.toContain('remote-skill [');
    expect(process.exitCode).toBeUndefined();
  });

  it('without --yes and no TTY, install reports pending items and exits non-zero', async () => {
    const home = path.join(tmp, 'h');
    process.env.E2E_TOOLS = path.join(tmp, 'tools');
    await runCli(['-H', home, 'setup', '--scaffold-only']);
    const file = path.join(home, '.agenthub', 'agenthub.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf-8'));
    manifest.mcp = { tool: { install: 'touch "$E2E_TOOLS-x"', check: 'false' } };
    write(file, JSON.stringify(manifest));

    await runCli(['-H', home, 'install']);
    expect(process.exitCode).toBe(1);
    expect(logs.join('\n')).toContain('1 install step(s) pending (no TTY, re-run with --yes)');
    expect(fs.existsSync(`${process.env.E2E_TOOLS}-x`)).toBe(false);
  });
});
