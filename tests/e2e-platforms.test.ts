import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { setCustomHome } from '../src/core/detector.js';

const fixture = path.resolve(__dirname, 'fixtures', 'mcp-stdio-server.cjs');
const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

describe('E2E: one hub, six assistants', () => {
  let tmp: string;
  let home: string;
  let hub: string;
  let logs: string[];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-e2e-plat-'));
    home = path.join(tmp, 'home');
    hub = path.join(home, '.agenthub');
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(strip(a.map(String).join(' '))));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(strip(a.map(String).join(' '))));
    process.exitCode = undefined;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setCustomHome(null, null);
    process.exitCode = undefined;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('setup --yes wires skills and MCP into every platform, and doctor proves the server works then catches it breaking', async () => {
    for (const d of ['.claude', '.gemini', '.codex', '.cursor', path.join('.codeium', 'windsurf'), '.copilot']) {
      fs.mkdirSync(path.join(home, d), { recursive: true });
    }
    // the hub: one local skill and one local MCP server (a real stdio server)
    write(path.join(hub, 'skills', 'mine', 'SKILL.md'), '---\nname: mine\ndescription: My skill\n---\n# Mine');
    fs.mkdirSync(path.join(hub, 'mcp', 'servers', 'fixture'), { recursive: true });
    fs.copyFileSync(fixture, path.join(hub, 'mcp', 'servers', 'fixture', 'server.cjs'));
    write(
      path.join(hub, 'mcp', 'servers.json'),
      JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: ['${HUB}/mcp/servers/fixture/server.cjs', 'ok', '3'] } } })
    );
    write(path.join(hub, 'agenthub.json'), JSON.stringify({ name: 'e2e', skills: { mine: 'local' }, mcp: { fixture: 'local' } }));

    await runCli(['-H', home, 'setup', '--yes']);
    expect(process.exitCode).toBeUndefined();

    // skills: Claude, Codex, Windsurf, Copilot link to the hub; Cursor already gets them through Claude/Codex
    const realHubSkills = fs.realpathSync(path.join(hub, 'skills'));
    for (const rel of ['.claude/skills', '.codex/skills', '.codeium/windsurf/skills', '.copilot/skills']) {
      expect(fs.realpathSync(path.join(home, rel))).toBe(realHubSkills);
      expect(fs.readFileSync(path.join(home, rel, 'mine', 'SKILL.md'), 'utf-8')).toContain('# Mine');
    }
    expect(fs.existsSync(path.join(home, '.cursor', 'skills'))).toBe(false);
    const geminiSkills = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'config', 'skills.json'), 'utf-8'));
    expect(JSON.stringify(geminiSkills)).toContain('.agenthub');

    // MCP: every platform's own format
    const server = path.join(hub, 'mcp', 'servers', 'fixture', 'server.cjs');
    const entry = { command: process.execPath, args: [server, 'ok', '3'] };
    const json = (rel: string) => JSON.parse(fs.readFileSync(path.join(home, rel), 'utf-8'));
    expect(json('.claude.json').mcpServers.fixture).toMatchObject(entry);
    expect(json('.cursor/mcp.json').mcpServers.fixture).toEqual(entry);
    expect(json('.codeium/windsurf/mcp_config.json').mcpServers.fixture).toEqual(entry);
    expect(json('.copilot/mcp-config.json').mcpServers.fixture).toEqual({ ...entry, type: 'local', tools: ['*'] });
    expect((parseToml(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf-8')) as any).mcp_servers.fixture).toEqual(entry);
    expect(JSON.stringify(json('.cursor/mcp.json'))).not.toContain('${');

    // setup --yes already probed it
    expect(logs.join('\n')).toContain('[PASS] fixture: 3 tools');

    // doctor: PASS with the tool count
    logs.length = 0;
    await runCli(['-H', home, 'doctor', '--timeout', '15']);
    let out = logs.join('\n');
    expect(out).toContain('[PASS] fixture: 3 tools');
    expect(out).toContain('[PASS] skill mine: SKILL.md valid');
    expect(out).toContain('[PASS] Windsurf skills: 1 hub skill(s) resolve');
    expect(out).not.toContain('[FAIL]');
    expect(process.exitCode).toBeUndefined();

    // break the server: doctor FAILs with the reason and exits 1
    write(path.join(hub, 'mcp', 'servers', 'fixture', 'server.cjs'), 'console.error("db unreachable"); process.exit(1);\n');
    logs.length = 0;
    await runCli(['-H', home, 'doctor', '--timeout', '15']);
    out = logs.join('\n');
    expect(out).toMatch(/\[FAIL\] fixture: exited with code 1 .*db unreachable/);
    expect(process.exitCode).toBe(1);

    // --json is machine readable and --no-functional starts nothing
    process.exitCode = undefined;
    logs.length = 0;
    await runCli(['-H', home, 'doctor', '--json', '--timeout', '15']);
    const report = JSON.parse(logs.join('\n'));
    expect(report.ok).toBe(false);
    expect(report.items.find((i: any) => i.name === 'fixture')).toMatchObject({ group: 'mcp', level: 'FAIL' });
    process.exitCode = undefined;
    logs.length = 0;
    await runCli(['-H', home, 'doctor', '--no-functional']);
    expect(logs.join('\n')).not.toContain('MCP servers:');
    expect(process.exitCode).toBeUndefined();
  }, 60000);

  it('setup without --yes and without a TTY does not start MCP servers', async () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const marker = path.join(tmp, 'started');
    write(path.join(hub, 'mcp', 'servers.json'), JSON.stringify({ mcpServers: { spy: { command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`] } } }));
    await runCli(['-H', home, 'setup']);
    await new Promise((r) => setTimeout(r, 400));
    expect(fs.existsSync(marker)).toBe(false);
    expect(logs.join('\n')).toContain('MCP servers were not started');
  });

  it('adopt --dry-run and adopt without a TTY print proposals and change nothing', async () => {
    const claudeJson = path.join(home, '.claude.json');
    write(claudeJson, JSON.stringify({ mcpServers: { docs: { command: 'npx', args: ['-y', 'some-pkg@1.2.3'] } } }));
    write(path.join(home, '.claude', 'skills', 'plain', 'SKILL.md'), '---\nname: plain\ndescription: d\n---\n');
    write(path.join(hub, 'agenthub.json'), JSON.stringify({ name: 'e2e' }));
    const manifest = () => fs.readFileSync(path.join(hub, 'agenthub.json'), 'utf-8');
    const before = manifest();

    for (const argv of [['adopt', '--dry-run'], ['adopt']]) {
      logs.length = 0;
      await runCli(['-H', home, ...argv]);
      const out = logs.join('\n');
      expect(out).toContain('mcp docs  npm:some-pkg@1.2.3 (confident)');
      expect(out).toContain('skill plain  local (needs your input)');
      expect(out).toContain('"docs": "npm:some-pkg@1.2.3"');
      expect(out).toMatch(/nothing was changed/i);
    }
    expect(manifest()).toBe(before);
    expect(fs.existsSync(path.join(home, '.claude', 'skills', 'plain.old'))).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });

  it('setup --yes lists every MCP command it will start, even ones that are in no install plan', async () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const marker = path.join(tmp, 'started');
    write(path.join(hub, 'mcp', 'servers.json'), JSON.stringify({ mcpServers: { spy: { command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`] } } }));
    write(path.join(hub, 'agenthub.json'), JSON.stringify({ name: 'e2e' }));
    await runCli(['-H', home, 'setup', '--yes']);
    const out = logs.join('\n');
    expect(out).toContain('Will start to verify (1):');
    expect(out).toContain(`spy: ${process.execPath} -e require('fs').writeFileSync(`);
    expect(out.indexOf('Will start to verify')).toBeLessThan(out.indexOf('Functional checks'));
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('fresh setup offers the starter codegraph install, and declining it starts nothing and does not fail', async () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    await runCli(['-H', home, 'setup']);
    const out = logs.join('\n');
    expect(out).toContain('Install plan (1):');
    expect(out).toContain('mcp codegraph');
    expect(out).toContain('install: npm install -g @colbymchenry/codegraph');
    expect(out).toContain('check:   command -v codegraph');
    expect(out).toContain('MCP servers were not started');
    expect(out).not.toContain('[FAIL]');
    expect(out).toContain('agenthub setup completed successfully');
    expect(process.exitCode).toBeUndefined();
  });
});
