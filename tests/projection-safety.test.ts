import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { setCustomHome } from '../src/core/detector.js';
import { finalizeInstall, planInstall, runInstall } from '../src/core/installer.js';
import { MCP_PLATFORMS, MCP_PLATFORM_IDS, readPlatform } from '../src/core/mcp-platforms.js';
import { syncMcpServers } from '../src/core/mcp-sync.js';
import { runtime, saveLock } from '../src/core/sources.js';
import { createJunction, safeWriteFile } from '../src/utils/fs.js';

describe('projection safety in isolated homes', () => {
  let home: string;
  let hub: string;
  let logs: string[];
  const write = (file: string, data: unknown) => safeWriteFile(file, JSON.stringify(data));

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-projection-'));
    hub = path.join(home, '.agenthub');
    setCustomHome(home, hub);
    for (const dir of ['.claude', '.codex', '.gemini', '.cursor', '.codeium/windsurf', '.copilot', '.pi/agent']) {
      fs.mkdirSync(path.join(home, dir), { recursive: true });
    }
    safeWriteFile(path.join(hub, 'skills', 'mine', 'SKILL.md'), '---\nname: mine\ndescription: Local skill\n---\n');
    write(path.join(hub, 'agenthub.json'), { skills: { mine: 'local' } });
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => void logs.push(args.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...args) => void logs.push(args.join(' ')));
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    setCustomHome(null, null);
    process.exitCode = undefined;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('skips missing commands on every assistant and preserves undeclared skills', async () => {
    safeWriteFile(path.join(hub, 'skills', 'undeclared', 'SKILL.md'), '---\nname: undeclared\ndescription: Existing local skill\n---\n');
    const servers = { missing: { command: 'agenthub-test-no-such-command-987654' }, good: { command: process.execPath } };
    write(path.join(hub, 'mcp', 'servers.json'), { mcpServers: servers });

    await runCli(['--home', home, 'install', '--yes']);

    expect(process.exitCode).toBeUndefined();
    expect(logs.join('\n')).toMatch(/\[SKIP\].*missing.*executable not found/);
    expect(JSON.parse(fs.readFileSync(path.join(hub, 'mcp', 'servers.json'), 'utf-8')).mcpServers).toEqual(servers);
    for (const id of MCP_PLATFORM_IDS) {
      const state = readPlatform(MCP_PLATFORMS[id], home);
      expect(state.servers.missing, id).toBeUndefined();
      expect(state.servers.good, id).toBeDefined();
    }
    expect(fs.existsSync(path.join(home, '.agents', 'skills', 'undeclared', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.claude', 'skills', 'undeclared', 'SKILL.md'))).toBe(true);
  });

  it('checks server PATH and cwd without executing commands and preserves remote configurations', () => {
    const bin = path.join(home, 'bin');
    const executable = path.join(bin, process.platform === 'win32' ? 'sandbox-tool.cmd' : 'sandbox-tool');
    safeWriteFile(executable, 'this must never be executed');
    fs.chmodSync(executable, 0o755);
    write(path.join(hub, 'mcp', 'servers.json'), { mcpServers: {
      fromPath: { command: 'sandbox-tool', env: { PATH: bin } },
      relative: { command: `./${path.basename(executable)}`, cwd: bin },
      remote: { url: 'https://example.test/mcp', headers: { Authorization: '${env:UNSET_TOKEN}' } },
      unresolved: { command: '${env:AGENTHUB_TEST_UNSET_COMMAND}' },
      fromVariable: { command: '${env:AGENTHUB_TEST_COMMAND}' },
    } });
    vi.stubEnv('AGENTHUB_TEST_UNSET_COMMAND', undefined);
    vi.stubEnv('AGENTHUB_TEST_COMMAND', executable);

    const result = syncMcpServers({ homeDir: home, hubDir: hub });

    const state = readPlatform(MCP_PLATFORMS.claude, home);
    expect(Object.keys(state.servers).sort()).toEqual(['fromPath', 'fromVariable', 'relative', 'remote']);
    expect(result.actions.join('\n')).toMatch(/\[SKIP\].*unresolved/);
  });

  it('reports malformed MCP entries and still projects valid servers', () => {
    write(path.join(hub, 'mcp', 'servers.json'), { mcpServers: {
      invalid: null, missing: {}, badCommand: { command: 42 }, good: { command: process.execPath },
    } });

    const result = syncMcpServers({ homeDir: home, hubDir: hub });

    expect(result.actions.filter((a) => a.startsWith('[SKIP]'))).toHaveLength(3);
    for (const id of MCP_PLATFORM_IDS) expect(Object.keys(readPlatform(MCP_PLATFORMS[id], home).servers), id).toEqual(['good']);
  });

  it('retains successful custom items and leaves the lock unchanged on a frozen reinstall', async () => {
    write(path.join(hub, 'agenthub.json'), { skills: { mine: 'local' }, mcp: { good: { check: 'sandbox-check' } } });
    write(path.join(hub, 'mcp', 'servers.json'), { mcpServers: { good: { command: process.execPath } } });
    vi.spyOn(runtime, 'shell').mockReturnValue({ status: 0, stdout: '', stderr: '' });
    await runCli(['--home', home, 'install', '--yes']);
    const lock = fs.readFileSync(path.join(hub, 'agenthub.lock.json'), 'utf-8');
    const config = fs.readFileSync(path.join(home, '.claude.json'), 'utf-8');

    await runCli(['--home', home, 'install', '--frozen-lockfile']);

    expect(process.exitCode).toBeUndefined();
    expect(fs.readFileSync(path.join(hub, 'agenthub.lock.json'), 'utf-8')).toBe(lock);
    expect(fs.readFileSync(path.join(home, '.claude.json'), 'utf-8')).toBe(config);
    expect(logs.join('\n')).toContain('approved before');
  });

  it('keeps an existing client entry when the replacement command is missing, even with force', () => {
    const existing = { command: process.execPath, args: ['working.js'], type: 'stdio' };
    write(path.join(home, '.claude.json'), { mcpServers: { server: existing }, other: true });
    write(path.join(hub, 'mcp', 'servers.json'), { mcpServers: { server: { command: 'agenthub-test-missing-987654' } } });

    syncMcpServers({ homeDir: home, hubDir: hub, force: true });

    expect(JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf-8'))).toEqual({ mcpServers: { server: existing }, other: true });
    expect(readPlatform(MCP_PLATFORMS.codex, home).servers.server).toBeUndefined();
  });

  it.each(['failed', 'manual', 'declined'] as const)('does not project %s custom items with otherwise available targets', async (outcome) => {
    const target = path.join(home, 'tools', 'skill');
    safeWriteFile(path.join(target, 'SKILL.md'), '---\nname: blocked\ndescription: Pending skill\n---\n');
    const custom = { check: 'sandbox-check', ...(outcome === 'manual' ? {} : { install: 'sandbox-install' }) };
    write(path.join(hub, 'agenthub.json'), { skills: { mine: 'local', blocked: { ...custom, path: target } }, mcp: { blocked: custom } });
    write(path.join(hub, 'mcp', 'servers.json'), { mcpServers: { blocked: { command: process.execPath } } });
    const shell = vi.spyOn(runtime, 'shell').mockReturnValue({ status: 1, stdout: '', stderr: 'fixture failure' });

    await runCli(['--home', home, 'install', ...(outcome === 'declined' ? [] : ['--yes'])]);

    expect(fs.existsSync(path.join(hub, 'skills', 'blocked'))).toBe(false);
    for (const id of MCP_PLATFORM_IDS) expect(readPlatform(MCP_PLATFORMS[id], home).servers.blocked, id).toBeUndefined();
    if (outcome === 'declined') expect(shell).not.toHaveBeenCalled();
  });

  it('preserves an existing skill link and working MCP entry after a failed update', async () => {
    const old = path.join(home, 'old-skill');
    const replacement = path.join(home, 'new-skill');
    safeWriteFile(path.join(old, 'SKILL.md'), 'old working skill');
    safeWriteFile(path.join(replacement, 'SKILL.md'), 'replacement');
    expect(createJunction(old, path.join(hub, 'skills', 'kept'))).toBe(true);
    const custom = { check: 'sandbox-check', install: 'sandbox-install' };
    write(path.join(hub, 'agenthub.json'), { skills: { kept: { ...custom, path: replacement } }, mcp: { kept: custom } });
    const existing = { command: process.execPath, args: ['working.js'], type: 'stdio' };
    write(path.join(hub, 'mcp', 'servers.json'), { mcpServers: { kept: existing } });
    syncMcpServers({ homeDir: home, hubDir: hub });
    const before = MCP_PLATFORM_IDS.map((id) => readPlatform(MCP_PLATFORMS[id], home).servers.kept);
    write(path.join(hub, 'mcp', 'servers.json'), { mcpServers: { kept: { command: process.execPath, args: ['replacement.js'] } } });
    vi.spyOn(runtime, 'shell').mockReturnValue({ status: 1, stdout: '', stderr: 'update failed' });

    await runCli(['--home', home, 'install', '--yes']);

    expect(fs.realpathSync(path.join(hub, 'skills', 'kept'))).toBe(fs.realpathSync(old));
    expect(MCP_PLATFORM_IDS.map((id) => readPlatform(MCP_PLATFORMS[id], home).servers.kept)).toEqual(before);
  });

  it.each(['setup', 'doctor'] as const)('keeps failed items excluded during %s repair syncs', async (command) => {
    write(path.join(hub, 'agenthub.json'), { skills: { mine: 'local' }, mcp: { blocked: { check: 'sandbox-check', install: 'sandbox-install' } } });
    write(path.join(hub, 'mcp', 'servers.json'), { mcpServers: { blocked: { command: process.execPath } } });
    vi.spyOn(runtime, 'shell').mockReturnValue({ status: 1, stdout: '', stderr: 'fixture failure' });

    await runCli(['--home', home, command, '--yes', ...(command === 'doctor' ? ['--fix', '--no-functional'] : [])]);

    for (const id of MCP_PLATFORM_IDS) expect(readPlatform(MCP_PLATFORMS[id], home).servers.blocked, id).toBeUndefined();
  });

  it('does not link a planning failure even when a vendor directory already exists', async () => {
    write(path.join(hub, 'agenthub.json'), { skills: { broken: 'github:owner/repo' } });
    safeWriteFile(path.join(hub, 'vendor', 'skills', 'broken', 'SKILL.md'), 'old content');
    write(path.join(hub, 'agenthub.lock.json'), { version: 1, skills: { broken: { source: 'github:owner/repo', commit: '--invalid' } }, mcp: {} });
    const plan = await planInstall(hub);
    expect(plan.errors).toHaveLength(1);

    runInstall(plan);

    expect(fs.existsSync(path.join(hub, 'skills', 'broken'))).toBe(false);
    expect(fs.readFileSync(path.join(hub, 'vendor', 'skills', 'broken', 'SKILL.md'), 'utf-8')).toBe('old content');
  });

  it('does not generate entries for skipped npm or PyPI sources', () => {
    write(path.join(hub, 'agenthub.json'), { mcp: { npm: 'npm:fixture@1.0.0', pypi: 'pypi:fixture@1.0.0' } });
    saveLock(hub, { version: 1, skills: {}, mcp: {
      npm: { source: 'npm:fixture@1.0.0', version: '1.0.0' },
      pypi: { source: 'pypi:fixture@1.0.0', version: '1.0.0' },
    } });

    finalizeInstall(hub, ['mcp npm', 'mcp pypi']);

    expect(fs.existsSync(path.join(hub, 'mcp', 'servers.json'))).toBe(false);
  });
});
