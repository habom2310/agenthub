import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runFullDoctor, runFunctionalChecks, skillItems, sourceItems, type DoctorItem } from '../src/core/doctor-full.js';
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
});
