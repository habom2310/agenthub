import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCli, runCli } from '../src/cli.js';
import { setCustomHome } from '../src/core/detector.js';
import { initHub } from '../src/core/scaffold.js';
import { createJunction, ensureDir, isJunctionOrSymlink, safeWriteFile } from '../src/utils/fs.js';

function stripAnsi(str: string): string {
  return str.replace(/\u001b\[[0-9;]*m/g, '');
}

describe('CLI Integration', () => {
  let sandbox: string;
  let logs: string[] = [];
  let errors: string[] = [];
  let stdoutData = '';

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-cli-test-'));
    logs = [];
    errors = [];
    stdoutData = '';

    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdoutData += String(chunk);
      return true;
    });

    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setCustomHome(null, null);
    process.exitCode = undefined;
    try {
      fs.rmSync(sandbox, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('init scaffolds hub and prints success banner', async () => {
    const cli = buildCli();
    cli.exitOverride();
    await cli.parseAsync(['-H', sandbox, 'init'], { from: 'user' });

    const hubManifest = path.join(sandbox, '.agenthub', 'agenthub.json');
    expect(fs.existsSync(hubManifest)).toBe(true);

    const fullLog = stripAnsi(logs.join('\n'));
    expect(fullLog).toContain('agenthub initialized successfully!');
    expect(fullLog).toContain('Manifest:');
    expect(fullLog).toContain('Configured / detected platforms:');
    expect(fullLog).toContain('All health checks passed');
  });

  it('setup completes full setup, auto-wires platforms, and passes all health checks', async () => {
    await runCli(['-H', sandbox, 'setup']);

    const hubManifest = path.join(sandbox, '.agenthub', 'agenthub.json');
    expect(fs.existsSync(hubManifest)).toBe(true);
    expect(fs.existsSync(path.join(sandbox, '.claude', 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(sandbox, '.gemini', 'GEMINI.md'))).toBe(true);

    const fullLog = stripAnsi(logs.join('\n'));
    expect(fullLog).toContain('✓ agenthub setup completed successfully!');
    expect(fullLog).toContain('Manifest:');
    expect(fullLog).toContain('Configured / detected platforms:');
    expect(fullLog).toContain('All health checks passed');
    expect(process.exitCode).toBeFalsy();
  });

  it('init with --scaffold-only skips auto-wiring assistants', async () => {
    await runCli(['-H', sandbox, 'init', '--scaffold-only']);

    const hubManifest = path.join(sandbox, '.agenthub', 'agenthub.json');
    expect(fs.existsSync(hubManifest)).toBe(true);
    expect(fs.existsSync(path.join(sandbox, '.claude', 'CLAUDE.md'))).toBe(false);

    const fullLog = stripAnsi(logs.join('\n'));
    expect(fullLog).toContain('agenthub initialized successfully!');
    expect(fullLog).toContain('Manifest:');
    expect(fullLog).not.toContain('Configured / detected platforms:');
    expect(process.exitCode).toBeFalsy();
  });

  it('setup with --scaffold-only skips auto-wiring assistants', async () => {
    await runCli(['-H', sandbox, 'setup', '--scaffold-only']);

    const hubManifest = path.join(sandbox, '.agenthub', 'agenthub.json');
    expect(fs.existsSync(hubManifest)).toBe(true);
    expect(fs.existsSync(path.join(sandbox, '.claude', 'CLAUDE.md'))).toBe(false);

    const fullLog = stripAnsi(logs.join('\n'));
    expect(fullLog).toContain('✓ agenthub setup completed successfully!');
    expect(fullLog).toContain('Manifest:');
    expect(fullLog).not.toContain('Configured / detected platforms:');
    expect(process.exitCode).toBeFalsy();
  });

  it('setup reports blockers, directs user to resolve and advise doctor --fix, and sets exitCode = 1', async () => {
    const doctor = await import('../src/core/doctor.js');
    const index = await import('../src/index.js');
    const mockedResult = {
      status: 'WARN' as const,
      passed_checks: ['Hub manifest exists'],
      issues: [
        'Permission denied: cannot write to .claude/skills',
        'Broken path in ~/.gemini/config/skills.json',
      ],
      repairs: [],
    };
    const doctorSpy = vi.spyOn(doctor, 'runDoctor').mockReturnValue(mockedResult);
    const indexSpy = vi.spyOn(index, 'runDoctor').mockReturnValue(mockedResult);

    await runCli(['-H', sandbox, 'setup']);

    const fullLog = stripAnsi(logs.join('\n'));
    expect(fullLog).toContain('Hub scaffolded:');
    expect(fullLog).toContain('blocker(s) that could not be automatically repaired:');
    expect(fullLog).toContain('Permission denied: cannot write to .claude/skills');
    expect(fullLog).toContain('Broken path in ~/.gemini/config/skills.json');
    expect(fullLog).toContain('Please resolve the blocker(s) above');
    expect(fullLog).toContain('agenthub doctor --fix');
    expect(process.exitCode).toBe(1);

    doctorSpy.mockRestore();
    indexSpy.mockRestore();
  });

  it('detect reports hub status and platform presence', async () => {
    // 1. Initialize hub
    initHub({ templateDir: undefined });
    // In sandbox, create dummy .gemini folder to test [FOUND]
    ensureDir(path.join(sandbox, '.gemini'));

    const cli = buildCli();
    cli.exitOverride();
    await cli.parseAsync(['-H', sandbox, 'detect'], { from: 'user' });

    const fullLog = stripAnsi(logs.join('\n'));
    expect(fullLog).toContain('agenthub status:');
    expect(fullLog).toContain('Platforms:');
    expect(fullLog).toContain('[FOUND] Antigravity');
    expect(fullLog).toContain('[NOT FOUND]');
  });

  it('project generates platform rule files and subagent manifests', async () => {
    // Scaffold hub first
    const hubDir = path.join(sandbox, '.agenthub');
    ensureDir(path.join(hubDir, 'rules'));
    safeWriteFile(path.join(hubDir, 'rules', 'common.md'), '# Common Rules\nSome content');
    safeWriteFile(path.join(hubDir, 'agenthub.json'), JSON.stringify({ version: '0.1.0' }));

    const cli = buildCli();
    cli.exitOverride();
    await cli.parseAsync(['-H', sandbox, 'project'], { from: 'user' });

    const fullLog = stripAnsi(logs.join('\n'));
    expect(fullLog).toContain('Projected GEMINI.md');
    expect(fullLog).toContain('Projected CLAUDE.md');
    expect(fs.existsSync(path.join(sandbox, '.gemini', 'GEMINI.md'))).toBe(true);
    expect(fs.existsSync(path.join(sandbox, '.claude', 'CLAUDE.md'))).toBe(true);
  });

  it('project respects --no-imports flag', async () => {
    const hubDir = path.join(sandbox, '.agenthub');
    ensureDir(path.join(hubDir, 'rules'));
    safeWriteFile(path.join(hubDir, 'rules', 'common.md'), '# Common Rules\nDirect content here');

    const cli = buildCli();
    cli.exitOverride();
    await cli.parseAsync(['-H', sandbox, 'project', '--no-imports'], { from: 'user' });

    const claudeMd = fs.readFileSync(path.join(sandbox, '.claude', 'CLAUDE.md'), 'utf-8');
    expect(claudeMd).not.toContain('@common.md');
    expect(claudeMd).toContain('Direct content here');
  });

  it('doctor detects issues and exits with code 1 when --fix is omitted', async () => {
    // Scaffold minimal broken environment
    const cli = buildCli();
    cli.exitOverride();
    await cli.parseAsync(['-H', sandbox, 'doctor'], { from: 'user' });

    const fullLog = stripAnsi(logs.join('\n'));
    expect(fullLog).toContain('[WARN]');
    expect(process.exitCode).toBe(1);
  });

  it('doctor --fix attempts automatic repairs', async () => {
    // Run init first so templates exist
    const hubDir = path.join(sandbox, '.agenthub');
    ensureDir(path.join(hubDir, 'rules'));
    safeWriteFile(path.join(hubDir, 'rules', 'common.md'), '# Common Rules');
    safeWriteFile(
      path.join(hubDir, 'agenthub.json'),
      JSON.stringify({
        version: '0.1.0',
        platforms: {
          claude: { enabled: true },
          antigravity: { enabled: true },
          codex: { enabled: true },
        },
      })
    );

    const cli = buildCli();
    cli.exitOverride();
    await cli.parseAsync(['-H', sandbox, 'doctor', '--fix'], { from: 'user' });

    const fullLog = stripAnsi(logs.join('\n'));
    expect(fullLog).toContain('[PASS]');
    // With --fix, exitCode should not be forced to 1 by doctor
    expect(process.exitCode).toBeFalsy();
  });

  it('budget audits token overhead against boot target', async () => {
    const hubDir = path.join(sandbox, '.agenthub');
    ensureDir(path.join(hubDir, 'rules'));
    safeWriteFile(path.join(hubDir, 'rules', 'common.md'), '# Rules\nShort rule text');

    const cli = buildCli();
    cli.exitOverride();
    await cli.parseAsync(['-H', sandbox, 'budget'], { from: 'user' });

    const fullLog = stripAnsi(logs.join('\n'));
    expect(fullLog).toContain('Token Budget Audit:');
    expect(fullLog).toContain('Core rules tokens:');
    expect(fullLog).toContain('Target budget:');
    expect(fullLog).toContain('PASS (LEAN)');
  });

  it('budget displays addon rules tokens when addons are present', async () => {
    const hubDir = path.join(sandbox, '.agenthub');
    ensureDir(path.join(hubDir, 'rules'));
    safeWriteFile(path.join(hubDir, 'rules', 'common.md'), '# Rules\nShort rule text');
    safeWriteFile(path.join(hubDir, 'rules', 'addons', 'security.md'), '# Security\nAdditional addon rules');

    const cli = buildCli();
    cli.exitOverride();
    await cli.parseAsync(['-H', sandbox, 'budget'], { from: 'user' });

    const fullLog = stripAnsi(logs.join('\n'));
    expect(fullLog).toContain('Addon rules tokens:');
  });

  it('mcp status and mcp sync report and sync servers', async () => {
    // Create .claude dir so platform is detected as installed
    ensureDir(path.join(sandbox, '.claude'));

    const hubDir = path.join(sandbox, '.agenthub');
    ensureDir(path.join(hubDir, 'mcp'));
    safeWriteFile(
      path.join(hubDir, 'mcp', 'servers.json'),
      JSON.stringify({
        mcpServers: {
          testserver: { command: 'node', args: ['server.js'] },
        },
      })
    );

    // MCP status
    const cli1 = buildCli();
    cli1.exitOverride();
    await cli1.parseAsync(['-H', sandbox, 'mcp', 'status'], { from: 'user' });

    let fullLog = stripAnsi(logs.join('\n'));
    expect(fullLog).toContain('MCP Status:');
    expect(fullLog).toContain('Hub servers:');
    expect(fullLog).toContain('testserver');

    logs = [];

    // MCP sync
    const cli2 = buildCli();
    cli2.exitOverride();
    await cli2.parseAsync(['-H', sandbox, 'mcp', 'sync'], { from: 'user' });

    fullLog = stripAnsi(logs.join('\n'));
    expect(fullLog).toContain('MCP Sync:');
    expect(fullLog).toContain('Updated Claude MCP configuration in .claude.json');

    // Verify Claude settings updated
    const claudeJson = path.join(sandbox, '.claude.json');
    expect(fs.existsSync(claudeJson)).toBe(true);
  });

  it('export chatgpt --stdout outputs rules directly to stdout', async () => {
    const hubDir = path.join(sandbox, '.agenthub');
    ensureDir(path.join(hubDir, 'rules', 'overrides'));
    safeWriteFile(path.join(hubDir, 'rules', 'common.md'), '# Common Export Guidelines');

    const cli = buildCli();
    cli.exitOverride();
    await cli.parseAsync(['-H', sandbox, 'export', 'chatgpt', '--stdout'], { from: 'user' });

    expect(stdoutData).toContain('# Multi-Agent Guidelines & Operational Heuristics');
    expect(stdoutData).toContain('# Common Export Guidelines');
  });

  it('export saves to file when --stdout is not passed', async () => {
    const hubDir = path.join(sandbox, '.agenthub');
    ensureDir(path.join(hubDir, 'rules', 'overrides'));
    safeWriteFile(path.join(hubDir, 'rules', 'common.md'), '# Export Test Content');

    const cli = buildCli();
    cli.exitOverride();
    await cli.parseAsync(['-H', sandbox, 'export', 'claude'], { from: 'user' });

    const fullLog = stripAnsi(logs.join('\n'));
    expect(fullLog).toContain('Exported claude rules to:');
    const exportFile = path.join(hubDir, 'export', 'claude_project_instructions.md');
    expect(fs.existsSync(exportFile)).toBe(true);
  });

  it('connect cursor links skills and projects rules', async () => {
    const hubDir = path.join(sandbox, '.agenthub');
    ensureDir(path.join(hubDir, 'skills'));
    ensureDir(path.join(hubDir, 'rules'));
    safeWriteFile(path.join(hubDir, 'agenthub.json'), JSON.stringify({ version: '0.1.0' }));
    safeWriteFile(path.join(hubDir, 'rules', 'common.md'), '# Cursor Rules');

    const cli = buildCli();
    cli.exitOverride();
    await cli.parseAsync(['-H', sandbox, 'connect', 'cursor'], { from: 'user' });

    const fullLog = stripAnsi(logs.join('\n'));
    expect(fullLog).toContain('Connected Cursor');
    expect(fs.existsSync(path.join(sandbox, '.cursor', 'rules', 'agenthub.mdc'))).toBe(true);
  });

  it('connect rejects --target-dir for unsupported platforms', async () => {
    const cli = buildCli();
    cli.exitOverride();
    await cli.parseAsync(
      ['-H', sandbox, 'connect', 'claude', '--target-dir', path.join(sandbox, 'custom-claude')],
      { from: 'user' }
    );

    const fullError = stripAnsi(errors.join('\n'));
    expect(fullError).toContain("Custom --target-dir is not supported for 'claude'");
    expect(process.exitCode).toBe(1);
  });

  it('git status reports uninitialized status, then reports branch after git init', async () => {
    const hubDir = path.join(sandbox, '.agenthub');
    ensureDir(hubDir);

    // Initial git status on non-repo
    const cli1 = buildCli();
    cli1.exitOverride();
    await cli1.parseAsync(['-H', sandbox, 'git', 'status'], { from: 'user' });

    let fullLog = stripAnsi(logs.join('\n'));
    expect(fullLog).toContain('Hub directory is not a git repository');

    logs = [];

    // Git init
    const cli2 = buildCli();
    cli2.exitOverride();
    await cli2.parseAsync(['-H', sandbox, 'git', 'init'], { from: 'user' });

    fullLog = stripAnsi(logs.join('\n'));
    expect(fullLog).toContain('Initialized git repository in hub');

    logs = [];

    // Git status after init (contains untracked .gitignore)
    const cli3 = buildCli();
    cli3.exitOverride();
    await cli3.parseAsync(['-H', sandbox, 'git', 'status'], { from: 'user' });

    fullLog = stripAnsi(logs.join('\n'));
    expect(fullLog).toContain('Git Status:');
    expect(fullLog).toContain('Branch:');
    expect(fullLog).toContain('dirty');
    expect(fullLog).toContain('.gitignore');

    logs = [];

    // Git push to commit locally
    const cli4 = buildCli();
    cli4.exitOverride();
    await cli4.parseAsync(['-H', sandbox, 'push', '-m', 'Initial commit'], { from: 'user' });

    fullLog = stripAnsi(logs.join('\n'));
    expect(fullLog).toContain('Changes committed locally');

    logs = [];

    // Git status after push should be clean
    const cli5 = buildCli();
    cli5.exitOverride();
    await cli5.parseAsync(['-H', sandbox, 'git', 'status'], { from: 'user' });

    fullLog = stripAnsi(logs.join('\n'));
    expect(fullLog).toContain('clean');
  });

  it('diff and promote detect and promote rule drift', async () => {
    const hubDir = path.join(sandbox, '.agenthub');
    ensureDir(path.join(hubDir, 'rules'));
    safeWriteFile(path.join(hubDir, 'rules', 'common.md'), '# Section 1\nOriginal text\n');
    safeWriteFile(path.join(hubDir, 'agenthub.json'), JSON.stringify({ version: '0.1.0' }));

    // Project rules to gemini
    const cliProj = buildCli();
    cliProj.exitOverride();
    await cliProj.parseAsync(['-H', sandbox, 'project'], { from: 'user' });

    // Introduce downstream drift in GEMINI.md
    const geminiMd = path.join(sandbox, '.gemini', 'GEMINI.md');
    fs.appendFileSync(geminiMd, '\n## New Feature Rule\nThis is a newly discovered rule downstream.\n');

    // Check diff
    logs = [];
    const cliDiff = buildCli();
    cliDiff.exitOverride();
    await cliDiff.parseAsync(['-H', sandbox, 'diff', '-p', 'gemini'], { from: 'user' });

    let fullLog = stripAnsi(logs.join('\n'));
    expect(fullLog).toContain('Drift detected');
    expect(fullLog).toContain('New Feature Rule');

    // Promote the drifted chunk
    logs = [];
    const cliPromote = buildCli();
    cliPromote.exitOverride();
    await cliPromote.parseAsync(
      ['-H', sandbox, 'promote', 'common.md', '-f', 'gemini', '--header', 'New Feature Rule'],
      { from: 'user' }
    );

    fullLog = stripAnsi(logs.join('\n'));
    expect(fullLog).toContain("Promoted rule 'New Feature Rule' into common.md");

    // Verify common.md now contains the promoted chunk
    const updatedCommon = fs.readFileSync(path.join(hubDir, 'rules', 'common.md'), 'utf-8');
    expect(updatedCommon).toContain('## New Feature Rule');
  });

  it('runCli helper executes commands successfully', async () => {
    await runCli(['-H', sandbox, 'detect']);
    const fullLog = stripAnsi(logs.join('\n'));
    expect(fullLog).toContain('agenthub status:');
  });

  it('runCli executes link command successfully', async () => {
    const hubDir = path.join(sandbox, '.agenthub');
    ensureDir(path.join(hubDir, 'skills', 'my-skill'));
    safeWriteFile(
      path.join(hubDir, 'skills', 'my-skill', 'SKILL.md'),
      '---\nname: my-skill\ndescription: test\n---\n# My Skill'
    );

    await runCli(['-H', sandbox, 'link']);
    const fullLog = stripAnsi(logs.join('\n'));
    expect(fullLog).toContain('Linked Claude skills');
    expect(fullLog).toContain('Linked Gemini skills');
    expect(process.exitCode).toBeFalsy();
  });

  it('link command sets process.exitCode = 1 on linking failure', async () => {
    const linker = await import('../src/core/linker.js');
    const spy = vi.spyOn(linker, 'linkSkillsForClaude').mockReturnValueOnce({
      success: false,
      message: 'Failed to create junction',
    });

    await runCli(['-H', sandbox, 'link']);
    const fullLog = stripAnsi(logs.join('\n'));
    expect(fullLog).toContain('Failed to create junction');
    expect(process.exitCode).toBe(1);

    spy.mockRestore();
  });

  it('runCli executes pull command with remote and branch', async () => {
    const remoteDir = path.join(sandbox, 'remote.git');
    ensureDir(remoteDir);
    spawnSync('git', ['init', '--bare', '-b', 'main'], { cwd: remoteDir });

    const feederDir = path.join(sandbox, 'feeder');
    ensureDir(feederDir);
    spawnSync('git', ['init', '-b', 'main'], { cwd: feederDir });
    spawnSync('git', ['remote', 'add', 'origin', remoteDir], { cwd: feederDir });

    safeWriteFile(path.join(feederDir, 'rules', 'common.md'), '# Feeder Rules');
    spawnSync('git', ['add', '-A'], { cwd: feederDir });
    spawnSync(
      'git',
      ['-c', 'user.name=feeder', '-c', 'user.email=feeder@test', 'commit', '-m', 'Initial pull test'],
      { cwd: feederDir }
    );
    spawnSync('git', ['push', '-u', 'origin', 'main'], { cwd: feederDir });

    // Initialize sandbox hub with the remote
    const hubDir = path.join(sandbox, '.agenthub');
    ensureDir(hubDir);
    spawnSync('git', ['init', '-b', 'main'], { cwd: hubDir });
    spawnSync('git', ['remote', 'add', 'origin', remoteDir], { cwd: hubDir });

    logs = [];
    await runCli(['-H', sandbox, 'pull', '-r', 'origin', '-b', 'main']);

    const fullLog = stripAnsi(logs.join('\n'));
    expect(fullLog).toContain('Successfully pulled from origin/main');
    expect(fs.existsSync(path.join(hubDir, 'rules', 'common.md'))).toBe(true);
  });

  it('agenthub info prints package summary, token footprint, and security assessment', async () => {
    const pkgDir = path.join(sandbox, 'test-package');
    ensureDir(pkgDir);

    safeWriteFile(
      path.join(pkgDir, 'agenthub.json'),
      JSON.stringify({
        name: 'test-package',
        version: '2.1.0',
        type: 'addon',
        description: 'A test CLI package',
        platforms: ['claude', 'gemini'],
      })
    );
    safeWriteFile(path.join(pkgDir, 'rules', 'common.md'), '# Test Rules\nDo not break things.');
    safeWriteFile(
      path.join(pkgDir, 'mcp', 'servers.json'),
      JSON.stringify({
        mcpServers: {
          test_cli_server: {
            command: 'npx',
            args: ['-y', 'mcp-server'],
          },
        },
      })
    );

    logs = [];
    await runCli(['-H', sandbox, 'info', pkgDir]);

    const fullLog = stripAnsi(logs.join('\n'));
    expect(fullLog).toContain('Package: test-package');
    expect(fullLog).toContain('Version:       2.1.0');
    expect(fullLog).toContain('Type:          addon');
    expect(fullLog).toContain('Description:   A test CLI package');
    expect(fullLog).toContain('Platforms:     claude, gemini');
    expect(fullLog).toContain('Token Footprint:');
    expect(fullLog).toContain('Security Assessment:');
    expect(fullLog).toContain('Risk level:');
    expect(fullLog).toContain('test_cli_server');
  });

  it('agenthub add installs package cleanly with -y', async () => {
    initHub({ force: true, customHome: sandbox });

    const pkgDir = path.join(sandbox, 'cli-addon');
    ensureDir(pkgDir);

    safeWriteFile(
      path.join(pkgDir, 'agenthub.json'),
      JSON.stringify({
        name: 'cli-addon',
        version: '1.0.0',
        type: 'addon',
      })
    );
    safeWriteFile(path.join(pkgDir, 'rules', 'common.md'), '# Addon CLI Rule');
    safeWriteFile(
      path.join(pkgDir, 'skills', 'cli-skill', 'SKILL.md'),
      '---\nname: cli-skill\ndescription: A CLI skill\n---\nSkill content.'
    );
    safeWriteFile(
      path.join(pkgDir, 'mcp', 'servers.json'),
      JSON.stringify({
        mcpServers: {
          cli_server: {
            command: 'npx',
            args: ['cli-mcp'],
          },
        },
      })
    );

    logs = [];
    await runCli(['-H', sandbox, 'add', pkgDir, '-y']);

    const fullLog = stripAnsi(logs.join('\n'));
    expect(fullLog).toContain('Successfully installed package "cli-addon"');
    expect(fullLog).toContain('Rules:       Installed to rules/addons/cli-addon.md');
    expect(fullLog).toContain('Skills:      cli-skill');
    expect(fullLog).toContain('MCP Servers: cli_server');

    const hubAddonRule = path.join(sandbox, '.agenthub', 'rules', 'addons', 'cli-addon.md');
    expect(fs.existsSync(hubAddonRule)).toBe(true);
    expect(fs.existsSync(path.join(sandbox, '.agenthub', 'skills', 'cli-skill'))).toBe(true);
  });

  it('profile list, create, and use manage profiles via CLI', async () => {
    // 1. Scaffold hub first
    const cli = buildCli();
    cli.exitOverride();
    await cli.parseAsync(['-H', sandbox, 'init'], { from: 'user' });

    // 2. profile list defaults to default profile
    logs = [];
    await runCli(['-H', sandbox, 'profile', 'list']);
    let output = stripAnsi(logs.join('\n'));
    expect(output).toContain('AgentHub Profiles:');
    expect(output).toContain('default (active)');

    // 3. profile create <name>
    logs = [];
    await runCli(['-H', sandbox, 'profile', 'create', 'work']);
    output = stripAnsi(logs.join('\n'));
    expect(output).toContain('Profile "work" created successfully');
    expect(fs.existsSync(path.join(sandbox, '.agenthub', 'profiles', 'work'))).toBe(true);

    // 4. profile list now lists work
    logs = [];
    await runCli(['-H', sandbox, 'profile']);
    output = stripAnsi(logs.join('\n'));
    expect(output).toContain('work');

    // 5. profile use <name>
    logs = [];
    await runCli(['-H', sandbox, 'profile', 'use', 'work', '-y']);
    output = stripAnsi(logs.join('\n'));
    expect(output).toContain('Switched to profile "work"');
    expect(output).toContain('Active Profile: work');
  });

  it('share audits and pushes setup via CLI', async () => {
    // 1. Initialize hub
    const cli = buildCli();
    cli.exitOverride();
    await cli.parseAsync(['-H', sandbox, 'init'], { from: 'user' });

    // 2. Run share without git remote -> reports error
    errors = [];
    await runCli(['-H', sandbox, 'share']);
    let errOutput = stripAnsi(errors.join('\n'));
    expect(errOutput).toContain('Git remote not configured');

    // 3. Configure a bare remote
    const bareRemote = path.join(sandbox, 'remote.git');
    spawnSync('git', ['init', '--bare', bareRemote]);

    const hubDir = path.join(sandbox, '.agenthub');
    spawnSync('git', ['init', '-b', 'main'], { cwd: hubDir });
    spawnSync('git', ['remote', 'add', 'origin', bareRemote], { cwd: hubDir });

    logs = [];
    errors = [];
    await runCli(['-H', sandbox, 'share', '-m', 'CLI share test']);
    const output = stripAnsi(logs.join('\n'));
    expect(output).toContain('Ready to share');
    expect(output).toContain('Share Commands:');
    expect(output).toContain(`agenthub add ${bareRemote}`);
    expect(output).toContain(`agenthub profile use ${bareRemote}`);
  });

  it('uninstall rolls back assistants and removes generated files', async () => {
    // 1. Setup pre-existing config before init
    const claudeDir = path.join(sandbox, '.claude');
    ensureDir(claudeDir);
    safeWriteFile(path.join(claudeDir, 'CLAUDE.md'), '# Original Claude Rules');

    const geminiDir = path.join(sandbox, '.gemini');
    ensureDir(geminiDir);
    safeWriteFile(path.join(geminiDir, 'GEMINI.md'), '# Original Gemini Rules');

    // 2. Initialize hub (creates pre-agenthub backup)
    await runCli(['-H', sandbox, 'init']);

    // 3. Project rules (updates CLAUDE.md and GEMINI.md to agenthub)
    await runCli(['-H', sandbox, 'project']);
    expect(fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf-8')).not.toBe('# Original Claude Rules');
    expect(fs.readFileSync(path.join(geminiDir, 'GEMINI.md'), 'utf-8')).not.toBe('# Original Gemini Rules');

    // Create a skills junction pointing to .agenthub/skills
    const claudeSkills = path.join(claudeDir, 'skills');
    const hubSkills = path.join(sandbox, '.agenthub', 'skills');
    ensureDir(hubSkills);
    createJunction(hubSkills, claudeSkills);
    expect(isJunctionOrSymlink(claudeSkills)).toBe(true);

    // 4. Run uninstall in dry-run mode
    logs = [];
    await runCli(['-H', sandbox, 'uninstall', '--dry-run', '-y']);
    let output = stripAnsi(logs.join('\n'));
    expect(output).toContain('dry-run mode');
    expect(output).toContain('Rollback completed successfully');
    // Still not reverted because dryRun
    expect(fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf-8')).not.toBe('# Original Claude Rules');
    expect(fs.readFileSync(path.join(geminiDir, 'GEMINI.md'), 'utf-8')).not.toBe('# Original Gemini Rules');
    expect(isJunctionOrSymlink(claudeSkills)).toBe(true);

    // 5. Run uninstall with -y (without purge)
    logs = [];
    await runCli(['-H', sandbox, 'uninstall', '-y']);
    output = stripAnsi(logs.join('\n'));
    expect(output).toContain('Rollback completed successfully');
    expect(output).toContain('Restored from backup');
    expect(output).toContain('Unlinked junctions');
    expect(output).toContain('Hub directory preserved');

    // Verify CLAUDE.md and GEMINI.md were rolled back to original
    expect(fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf-8')).toBe('# Original Claude Rules');
    expect(fs.readFileSync(path.join(geminiDir, 'GEMINI.md'), 'utf-8')).toBe('# Original Gemini Rules');
    // Junction was unlinked
    expect(isJunctionOrSymlink(claudeSkills)).toBe(false);
    // Hub directory still exists
    expect(fs.existsSync(path.join(sandbox, '.agenthub'))).toBe(true);

    // 6. Run uninstall with --purge
    logs = [];
    await runCli(['-H', sandbox, 'uninstall', '-y', '--purge']);
    output = stripAnsi(logs.join('\n'));
    expect(output).toContain('Purged hub directory');
    expect(fs.existsSync(path.join(sandbox, '.agenthub'))).toBe(false);
  });

  it('search displays formatted package list with install commands', async () => {
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          total: 2,
          packages: [
            {
              id: 'alice/nextjs-agent',
              name: 'nextjs-agent',
              version: '1.0.0',
              description: 'Next.js agent profile with Prisma and Tailwind',
              type: 'profile',
              platforms: ['gemini', 'claude'],
              stars: 42,
              tokenFootprint: { totalTokens: 850, rulesTokens: 850, skillsTokens: 0 },
            },
            {
              id: 'bob/tailwind-addon',
              name: 'tailwind-addon',
              version: '0.2.0',
              description: 'Tailwind styling addon',
              type: 'addon',
              platforms: ['claude', 'cursor'],
              stars: 15,
              tokenFootprint: { totalTokens: 120, rulesTokens: 120, skillsTokens: 0 },
            },
          ],
        }),
      } as Response);

      logs = [];
      await runCli(['search', 'react', '-p', 'claude']);
      const output = stripAnsi(logs.join('\n'));

      expect(output).toContain('Found 2 packages matching "react":');
      expect(output).toContain('alice/nextjs-agent@1.0.0 [profile]');
      expect(output).toContain('Next.js agent profile with Prisma and Tailwind');
      expect(output).toContain('Platforms: gemini, claude | ★ 42 | ~850 tokens');
      expect(output).toContain('Install: agenthub profile use alice/nextjs-agent');

      expect(output).toContain('bob/tailwind-addon@0.2.0 [addon]');
      expect(output).toContain('Tailwind styling addon');
      expect(output).toContain('Platforms: claude, cursor | ★ 15 | ~120 tokens');
      expect(output).toContain('Install: agenthub add bob/tailwind-addon');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('search prints friendly message when no packages are found', async () => {
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ total: 0, packages: [] }),
      } as Response);

      logs = [];
      await runCli(['search', 'nonexistent-package']);
      const output = stripAnsi(logs.join('\n'));

      expect(output).toContain('No packages found matching "nonexistent-package".');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('search prints error message and sets exitCode when registry fails', async () => {
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        text: async () => JSON.stringify({ error: 'Registry undergoing maintenance' }),
      } as Response);

      errors = [];
      await runCli(['search', 'react']);
      const errOutput = stripAnsi(errors.join('\n'));

      expect(errOutput).toContain('Failed to search registry: Registry undergoing maintenance');
      expect(process.exitCode).toBe(1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('share with --publish indexes package in registry', async () => {
    // 1. Initialize hub
    const cli = buildCli();
    cli.exitOverride();
    await cli.parseAsync(['-H', sandbox, 'init'], { from: 'user' });

    // 2. Configure a bare remote
    const bareRemote = path.join(sandbox, 'publish-remote.git');
    spawnSync('git', ['init', '--bare', bareRemote]);

    const hubDir = path.join(sandbox, '.agenthub');
    spawnSync('git', ['init', '-b', 'main'], { cwd: hubDir });
    spawnSync('git', ['remote', 'add', 'origin', bareRemote], { cwd: hubDir });

    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({
          message: 'Package indexed successfully',
          package: { id: 'alice/my-agent' },
        }),
      } as Response);

      logs = [];
      errors = [];
      await runCli(['-H', sandbox, 'share', '--publish', '-m', 'Publish test']);
      const output = stripAnsi(logs.join('\n'));

      expect(output).toContain('Ready to share');
      expect(output).toContain('Publishing to registry...');
      expect(output).toContain('Successfully published and indexed "alice/my-agent" in registry!');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
