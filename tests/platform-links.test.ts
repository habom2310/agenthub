import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cursorSkillsProvider,
  linkSkillsForAllAssistants,
  linkSkillsForCopilot,
  linkSkillsForCursor,
  linkSkillsForWindsurf,
} from '../src/core/linker.js';
import { syncMcpServers } from '../src/core/mcp-sync.js';
import { uninstallHub } from '../src/core/uninstaller.js';
import { backupExistingConfigs } from '../src/core/scaffold.js';
import { createJunction, ensureDir, isJunctionOrSymlink, safeWriteFile } from '../src/utils/fs.js';

describe('skills links for Cursor, Windsurf and Copilot', () => {
  let tmp: string;
  let home: string;
  let hub: string;
  const skill = (dir: string, name: string) => safeWriteFile(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n`);
  const real = (p: string) => fs.realpathSync(p);

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-links-'));
    home = path.join(tmp, 'home');
    hub = path.join(tmp, 'hub');
    ensureDir(home);
    skill(path.join(hub, 'skills'), 'hub-skill');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('Copilot: links ~/.copilot/skills, migrating a real folder and keeping skills.old', () => {
    skill(path.join(home, '.copilot', 'skills'), 'mine');
    fs.mkdirSync(path.join(home, '.copilot', 'skills', 'mine.old'));
    const res = linkSkillsForCopilot(home, hub);
    expect(res.success).toBe(true);
    expect(isJunctionOrSymlink(path.join(home, '.copilot', 'skills'))).toBe(true);
    expect(real(path.join(home, '.copilot', 'skills'))).toBe(real(path.join(hub, 'skills')));
    expect(fs.existsSync(path.join(hub, 'skills', 'mine', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(hub, 'skills', 'mine.old'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.copilot', 'skills.old', 'mine', 'SKILL.md'))).toBe(true);
  });

  it('Windsurf: links ~/.codeium/windsurf/skills', () => {
    ensureDir(path.join(home, '.codeium', 'windsurf'));
    expect(linkSkillsForWindsurf(home, hub).success).toBe(true);
    expect(real(path.join(home, '.codeium', 'windsurf', 'skills'))).toBe(real(path.join(hub, 'skills')));
  });

  it('Cursor: links itself when nothing else provides the hub skills', () => {
    ensureDir(path.join(home, '.cursor'));
    expect(cursorSkillsProvider(home, hub)).toBeNull();
    expect(linkSkillsForCursor(home, hub).success).toBe(true);
    expect(real(path.join(home, '.cursor', 'skills'))).toBe(real(path.join(hub, 'skills')));
  });

  it('Cursor: skips its own link when ~/.claude/skills or ~/.codex/skills already provides the skills', () => {
    ensureDir(path.join(home, '.cursor'));
    for (const dir of ['.claude', '.codex']) {
      fs.rmSync(path.join(home, '.cursor', 'skills'), { recursive: true, force: true });
      fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
      fs.rmSync(path.join(home, '.codex'), { recursive: true, force: true });
      createJunction(path.join(hub, 'skills'), path.join(home, dir, 'skills'));
      const res = linkSkillsForCursor(home, hub);
      expect(res.success).toBe(true);
      expect(res.message).toContain('twice');
      expect(fs.existsSync(path.join(home, '.cursor', 'skills'))).toBe(false);
      expect(cursorSkillsProvider(home, hub)).toBe(path.join(home, dir, 'skills'));
    }
  });

  it('Cursor: removes an earlier hub link when it became redundant, and leaves a real folder alone', () => {
    ensureDir(path.join(home, '.cursor'));
    createJunction(path.join(hub, 'skills'), path.join(home, '.cursor', 'skills'));
    createJunction(path.join(hub, 'skills'), path.join(home, '.claude', 'skills'));
    linkSkillsForCursor(home, hub);
    expect(fs.existsSync(path.join(home, '.cursor', 'skills'))).toBe(false);

    skill(path.join(home, '.cursor', 'skills'), 'cursor-only');
    linkSkillsForCursor(home, hub);
    expect(fs.existsSync(path.join(home, '.cursor', 'skills', 'cursor-only', 'SKILL.md'))).toBe(true);
    expect(isJunctionOrSymlink(path.join(home, '.cursor', 'skills'))).toBe(false);
  });

  it('linkSkillsForAllAssistants links only detected platforms, Cursor after Claude', () => {
    for (const d of ['.cursor', path.join('.codeium', 'windsurf'), '.copilot']) ensureDir(path.join(home, d));
    const res = linkSkillsForAllAssistants({ homeDir: home, hubDir: hub });
    expect(res.codex).toBeUndefined();
    expect(res.cursor?.message).toContain('twice');
    expect(res.windsurf?.success).toBe(true);
    expect(res.copilot?.success).toBe(true);
    expect(isJunctionOrSymlink(path.join(home, '.claude', 'skills'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.cursor', 'skills'))).toBe(false);
  });
});

describe('uninstall rolls back the new platforms', () => {
  let tmp: string;
  let home: string;
  let hub: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-uninstall-new-'));
    home = path.join(tmp, 'home');
    hub = path.join(tmp, 'hub');
    ensureDir(path.join(hub, 'skills'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('unlinks Copilot skills and restores skills.old', () => {
    const skills = path.join(home, '.copilot', 'skills');
    safeWriteFile(path.join(skills, 'mine', 'SKILL.md'), 'x');
    linkSkillsForCopilot(home, hub);
    expect(fs.existsSync(path.join(home, '.copilot', 'skills.old'))).toBe(true);

    const res = uninstallHub({ home, hub });
    expect(res.unlinkedJunctions).toContain(skills);
    expect(isJunctionOrSymlink(skills)).toBe(false);
    expect(fs.existsSync(path.join(skills, 'mine', 'SKILL.md'))).toBe(true);
  });

  it('removes only what agenthub wrote, keeping servers that were there before it', () => {
    for (const d of ['.codex', '.cursor', path.join('.codeium', 'windsurf'), '.copilot']) ensureDir(path.join(home, d));
    safeWriteFile(path.join(home, '.codex', 'config.toml'), 'model = "x"\n\n[mcp_servers.theirs]\ncommand = "theirs"\n');
    safeWriteFile(path.join(hub, 'mcp', 'servers.json'), JSON.stringify({ mcpServers: { mine: { command: 'mine' } } }));
    syncMcpServers(home, hub);
    expect(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf-8')).toContain('mine');
    expect(JSON.parse(fs.readFileSync(path.join(hub, 'mcp', 'origins.json'), 'utf-8')).theirs.from).toEqual(['codex']);

    // the user edits one of the copies agenthub wrote
    const cursor = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf-8'));
    cursor.mcpServers.mine.command = 'edited';
    safeWriteFile(path.join(home, '.cursor', 'mcp.json'), JSON.stringify(cursor));

    const dry = uninstallHub({ home, hub, dryRun: true });
    expect(dry.removedMcpServers).toEqual(expect.arrayContaining(['codex:mine', 'windsurf:mine', 'copilot:mine', 'cursor:theirs']));
    expect(dry.removedMcpServers).not.toContain('codex:theirs');
    expect(JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf-8')).mcpServers.mine.command).toBe('edited');

    const res = uninstallHub({ home, hub });
    expect(res.keptMcpServers).toEqual(
      expect.arrayContaining(['codex:theirs (it was there before agenthub)', 'cursor:mine (changed since)'])
    );
    const toml: any = parseToml(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf-8'));
    expect(toml.model).toBe('x');
    expect(toml.mcp_servers).toEqual({ theirs: { command: 'theirs' } });
    expect(JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf-8')).mcpServers).toEqual({ mine: { command: 'edited' } });
    expect(JSON.parse(fs.readFileSync(path.join(home, '.copilot', 'mcp-config.json'), 'utf-8')).mcpServers).toEqual({});
    expect(fs.readFileSync(path.join(hub, 'mcp', 'servers.json'), 'utf-8')).toContain('theirs');
  });

  it('with --purge keeps a server that would exist nowhere else', () => {
    ensureDir(path.join(home, '.cursor'));
    ensureDir(path.join(home, '.copilot'));
    safeWriteFile(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { solo: { command: 'solo' } } }));
    safeWriteFile(path.join(hub, 'mcp', 'servers.json'), JSON.stringify({ mcpServers: { shared: { command: 'shared' } } }));
    syncMcpServers(home, hub); // solo is ingested from Cursor, projected to Copilot; shared goes to both
    const res = uninstallHub({ home, hub, purge: true });
    // Cursor still has solo (its origin) so Copilot's copy may go; shared exists in no kept place and stays once
    expect(res.removedMcpServers).toContain('copilot:solo');
    expect(res.keptMcpServers.some((k) => k.startsWith('cursor:shared') || k.startsWith('copilot:shared'))).toBe(true);
    const left = [JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf-8')), JSON.parse(fs.readFileSync(path.join(home, '.copilot', 'mcp-config.json'), 'utf-8'))];
    expect(left.some((c) => 'shared' in c.mcpServers)).toBe(true);
    expect(fs.existsSync(hub)).toBe(false);
  });

  it('restores ~/.cursor/skills.old when the Cursor link was removed on purpose', () => {
    safeWriteFile(path.join(home, '.cursor', 'skills.old', 'mine', 'SKILL.md'), 'x');
    const res = uninstallHub({ home, hub });
    expect(res.restoredJunctions).toContain(path.join(home, '.cursor', 'skills'));
    expect(fs.existsSync(path.join(home, '.cursor', 'skills', 'mine', 'SKILL.md'))).toBe(true);
  });

  it('restores the pre-agenthub config from the backup instead', () => {
    ensureDir(path.join(home, '.cursor'));
    const original = JSON.stringify({ mcpServers: { orig: { command: 'orig' } } });
    safeWriteFile(path.join(home, '.cursor', 'mcp.json'), original);
    const backup = path.join(hub, 'backups', 'pre-agenthub-20240101_000000Z');
    expect(backupExistingConfigs(backup, home)).toContain('.cursor/mcp.json');

    safeWriteFile(path.join(hub, 'mcp', 'servers.json'), JSON.stringify({ mcpServers: { orig: { command: 'orig' }, mine: { command: 'mine' } } }));
    syncMcpServers(home, hub);
    const res = uninstallHub({ home, hub });
    expect(res.restoredFiles).toContain('.cursor/mcp.json');
    expect(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf-8')).toBe(original);
    expect(res.removedMcpServers.filter((s) => s.startsWith('cursor:'))).toEqual([]);
  });
});
