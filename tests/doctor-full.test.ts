import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { probeTargets, runFullDoctor, varItems, runFunctionalChecks, skillItems, sourceItems, type DoctorItem } from '../src/core/doctor-full.js';
import { createJunction, ensureDir, safeWriteFile } from '../src/utils/fs.js';

const fixture = path.resolve(__dirname, 'fixtures', 'mcp-stdio-server.cjs');

describe('functional doctor', () => {
  let tmp: string;
  let home: string;
  let hub: string;
  const find = (items: DoctorItem[], name: string) => items.find((i) => i.name === name);
  const writeServers = (servers: Record<string, unknown>) => safeWriteFile(path.join(hub, 'mcp', 'servers.json'), JSON.stringify({ mcpServers: servers }));
  const writeManifest = (extra: Record<string, unknown>) => safeWriteFile(path.join(hub, 'agenthub.json'), JSON.stringify({ name: 'h', ...extra }));
  const skill = (dir: string, name: string, desc = 'd') => safeWriteFile(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n`);

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-doctorfull-'));
    home = path.join(tmp, 'home');
    hub = path.join(tmp, 'hub');
    ensureDir(home);
    ensureDir(hub);
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  describe('MCP probes', () => {
    it('reports PASS with the tool count and FAIL with the reason, expanding ${HUB}', async () => {
      fs.copyFileSync(fixture, path.join(hub, 'server.cjs'));
      writeServers({
        good: { command: process.execPath, args: ['${HUB}/server.cjs', 'ok', '4'] },
        dying: { command: process.execPath, args: [fixture, 'exit'] },
        missing: { command: 'agenthub-nope-xyz' },
        needsvar: { command: process.execPath, args: [fixture], env: { K: '${AGENTHUB_UNSET_ZZZ}' } },
      });
      const items = await runFunctionalChecks({ homeDir: home, hubDir: hub, timeoutSec: 10 });
      expect(find(items, 'good')).toMatchObject({ group: 'mcp', level: 'PASS' });
      expect(find(items, 'good')?.message).toMatch(/^4 tools/);
      expect(find(items, 'dying')).toMatchObject({ level: 'FAIL' });
      expect(find(items, 'dying')?.message).toContain('exited with code 3');
      expect(find(items, 'missing')?.message).toContain('command not found');
      expect(find(items, 'needsvar')?.message).toContain('unresolved variable(s)');
    });

    it('starts nothing when functional is off', async () => {
      const marker = path.join(tmp, 'started');
      writeServers({ spy: { command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '1')`] } });
      const items = await runFunctionalChecks({ homeDir: home, hubDir: hub, functional: false });
      expect(items.filter((i) => i.group === 'mcp')).toEqual([]);
      await new Promise((r) => setTimeout(r, 300));
      expect(fs.existsSync(marker)).toBe(false);
    });
  });

  describe('skills', () => {
    it('validates hub skills, flags a broken link and checks resolution through the assistant paths', () => {
      skill(path.join(hub, 'skills'), 'good');
      skill(path.join(hub, 'skills'), 'bad-desc', '');
      fs.symlinkSync(path.join(tmp, 'gone'), path.join(hub, 'skills', 'dangling'));
      ensureDir(path.join(home, '.claude'));
      createJunction(path.join(hub, 'skills'), path.join(home, '.claude', 'skills'));
      ensureDir(path.join(home, '.codex', 'skills'));

      const items = skillItems(home, hub);
      expect(find(items, 'skill good')?.level).toBe('PASS');
      expect(find(items, 'skill bad-desc')).toMatchObject({ level: 'FAIL', message: 'frontmatter has no description' });
      expect(find(items, 'skill dangling')?.message).toContain('broken link');
      expect(find(items, 'Claude skills')?.level).toBe('PASS');
      expect(find(items, 'Codex skills')).toMatchObject({ level: 'FAIL' });
      expect(find(items, 'Codex skills')?.message).toContain('good');
    });

    it('warns when Cursor lists a skill twice or sees two different folders with one name', () => {
      skill(path.join(hub, 'skills'), 'shared');
      ensureDir(path.join(home, '.cursor'));
      createJunction(path.join(hub, 'skills'), path.join(home, '.cursor', 'skills'));
      createJunction(path.join(hub, 'skills'), path.join(home, '.claude', 'skills'));
      let items = skillItems(home, hub);
      expect(find(items, 'Cursor duplicate shared')?.message).toContain('is listed twice');

      fs.rmSync(path.join(home, '.cursor', 'skills'));
      skill(path.join(home, '.cursor', 'skills'), 'shared', 'different copy');
      items = skillItems(home, hub);
      expect(find(items, 'Cursor duplicate shared')?.message).toContain('comes from different folders');
    });
  });

  describe('declared sources', () => {
    it('fails a declared local item without a folder and passes one that exists', async () => {
      skill(path.join(hub, 'skills'), 'mine');
      writeManifest({ skills: { mine: 'local', ghost: 'local' } });
      const items = await sourceItems(hub, false);
      expect(find(items, 'skill mine')).toMatchObject({ level: 'PASS' });
      expect(find(items, 'skill ghost')).toMatchObject({ level: 'FAIL' });
    });

    it('runs custom check commands only when functional', async () => {
      const marker = path.join(tmp, 'check-ran');
      writeServers({ tool: { command: 'x' } });
      writeManifest({ mcp: { tool: { install: 'exit 0', check: `touch ${JSON.stringify(marker)} && test -f ${JSON.stringify(path.join(tmp, 'absent'))}` } } });

      expect(await sourceItems(hub, false)).toEqual([]);
      expect(fs.existsSync(marker)).toBe(false);

      const items = await sourceItems(hub, true);
      expect(fs.existsSync(marker)).toBe(true);
      expect(find(items, 'mcp tool')).toMatchObject({ level: 'FAIL' });
      expect(find(items, 'mcp tool')?.message).toContain('check failed (exit 1)');

      fs.writeFileSync(path.join(tmp, 'absent'), '');
      expect(find(await sourceItems(hub, true), 'mcp tool')?.level).toBe('PASS');
    });
  });

  it('runFullDoctor combines structural and functional items and fails on any FAIL', async () => {
    writeServers({ dying: { command: process.execPath, args: [fixture, 'exit'] } });
    const res = await runFullDoctor({ homeDir: home, hubDir: hub, timeoutSec: 10 });
    expect(res.ok).toBe(false);
    expect(res.items.some((i) => i.group === 'setup')).toBe(true);
    expect(res.items.some((i) => i.group === 'mcp' && i.level === 'FAIL')).toBe(true);
    expect(res.counts.FAIL).toBeGreaterThan(0);

    const skipped = await runFullDoctor({ homeDir: home, hubDir: hub, functional: false });
    expect(skipped.items.some((i) => i.group === 'mcp')).toBe(false);
    expect(skipped.notes.join(' ')).toContain('--no-functional');
  });

  it('doctor --fix reports a conflicting MCP entry and leaves it alone; only mcp sync --force overwrites', async () => {
    const cursor = path.join(home, '.cursor', 'mcp.json');
    safeWriteFile(cursor, JSON.stringify({ mcpServers: { app: { command: 'mine' } } }));
    writeServers({ app: { command: 'hub-app' } });
    const res = await runFullDoctor({ homeDir: home, hubDir: hub, fix: true, functional: false });
    expect(JSON.parse(fs.readFileSync(cursor, 'utf-8')).mcpServers.app.command).toBe('mine');
    expect(res.ok).toBe(false);
    expect(res.items.some((i) => i.level === 'FAIL' && i.message.includes('conflict in Cursor'))).toBe(true);
    expect(res.repairs.some((r) => r.startsWith('[CONFLICT]'))).toBe(true);
    expect(fs.existsSync(path.join(hub, 'backups'))).toBe(false);
  });

  it('probe consent text shows the full url with its query, header names and every substituted variable', () => {
    writeServers({
      api: { url: 'https://api.example/mcp?key=${API_KEY}&v=2', headers: { Authorization: 'Bearer ${TOKEN}', 'X-Plain': 'x' } },
      local: { command: 'node', args: ['server.js', '--db', '${DB_URL}'], env: { AWS_SECRET_ACCESS_KEY: '${AWS_SECRET_ACCESS_KEY}', MODE: 'dev' } },
      plain: { command: 'node', args: ['a.js'] },
    });
    const lines = probeTargets(home, hub);
    expect(lines[0]).toBe('api: connect to https://api.example/mcp?key=${API_KEY}&v=2; headers: Authorization, X-Plain; will substitute env: API_KEY, TOKEN');
    expect(lines[1]).toBe('local: node server.js --db ${DB_URL}; env: AWS_SECRET_ACCESS_KEY, MODE; will substitute env: AWS_SECRET_ACCESS_KEY, DB_URL');
    expect(lines[2]).toBe('plain: node a.js');
  });

  it('warns, naming the assistant and the variable, where an installed assistant does not expand ${VAR}', () => {
    for (const d of ['.claude', '.cursor', '.codex', path.join('.codeium', 'windsurf'), '.gemini']) fs.mkdirSync(path.join(home, d), { recursive: true });
    writeServers({ srv: { command: 'node', args: ['--k', '${API_KEY}'], env: { T: '${TOKEN}' } } });
    const items = varItems(home, hub);
    const labels = items.map((i) => i.name).sort();
    expect(labels).toEqual(['srv variables in Codex', 'srv variables in Gemini', 'srv variables in Windsurf']);
    expect(items.every((i) => i.level === 'WARN' && i.group === 'mcp')).toBe(true);
    expect(find(items, 'srv variables in Windsurf')?.message).toContain('${API_KEY} (args), ${TOKEN} (env)');
    // Gemini expands the env block, so only args is reported there
    expect(find(items, 'srv variables in Gemini')?.message).toContain('${API_KEY} (args)');
    expect(find(items, 'srv variables in Gemini')?.message).not.toContain('TOKEN');
  });
});
