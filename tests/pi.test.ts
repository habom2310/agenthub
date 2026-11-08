import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectPlatforms, piInstalled, setCustomHome } from '../src/core/detector.js';
import { runDoctor } from '../src/core/doctor.js';
import { unsupportedItems } from '../src/core/doctor-full.js';
import { linkSkillsForAllAssistants } from '../src/core/linker.js';
import { MCP_PLATFORMS } from '../src/core/mcp-platforms.js';
import { getMcpStatus, readOrigins, syncMcpServers } from '../src/core/mcp-sync.js';
import { HEADER_GUARD, projectCodexRules, projectPiRules, projectRules } from '../src/core/projector.js';
import { backupExistingConfigs } from '../src/core/scaffold.js';
import { uninstallHub } from '../src/core/uninstaller.js';
import { ensureDir, safeWriteFile } from '../src/utils/fs.js';

const read = (p: string) => fs.readFileSync(p, 'utf-8');
const readJson = (p: string) => JSON.parse(read(p));

describe('Pi', () => {
  let tmp: string;
  let home: string;
  let hub: string;
  let savedPath: string | undefined;
  const mcpFile = () => path.join(home, '.pi', 'agent', 'mcp.json');
  const rulesFile = () => path.join(home, '.pi', 'agent', 'AGENTS.md');
  const hubFile = () => path.join(hub, 'mcp', 'servers.json');
  const writeHub = (servers: Record<string, unknown>) => safeWriteFile(hubFile(), JSON.stringify({ mcpServers: servers }, null, 2));
  const stdio = { command: 'node', args: ['${HUB}/mcp/servers/x/index.js'], env: { TOKEN: 'abc' } };
  const remote = { url: 'https://example.com/mcp', headers: { 'X-Key': 'k' } };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-pi-'));
    home = path.join(tmp, 'home');
    hub = path.join(tmp, 'hub');
    ensureDir(path.join(home, '.pi', 'agent'));
    ensureDir(hub);
    setCustomHome(home, hub);
    savedPath = process.env.PATH;
  });
  afterEach(() => {
    process.env.PATH = savedPath;
    setCustomHome(null, null);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('detection', () => {
    it('is detected by ~/.pi/agent', () => {
      expect(piInstalled(home)).toBe(true);
      expect(detectPlatforms().platforms.pi).toMatchObject({ detected: true, path: path.join(home, '.pi', 'agent') });
    });

    it('a bare pi binary on PATH is reported by detect but never causes a write', () => {
      fs.rmSync(path.join(home, '.pi'), { recursive: true });
      expect(piInstalled(home)).toBe(false);
      expect(detectPlatforms().platforms.pi).toMatchObject({ detected: false, bin_path: '' });

      const bin = path.join(tmp, 'bin');
      const exe = path.join(bin, process.platform === 'win32' ? 'pi.cmd' : 'pi');
      safeWriteFile(exe, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n');
      fs.chmodSync(exe, 0o755);
      process.env.PATH = bin; // only pi: a codex binary here would count as Codex and create ~/.codex
      expect(piInstalled(home)).toBe(false);
      const pi = detectPlatforms().platforms.pi;
      expect(pi.detected).toBe(false);
      // Windows resolves via PATHEXT, which is upper case (pi.CMD)
      const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
      expect(norm(pi.bin_path)).toBe(norm(exe));

      // a real ~/.agents/skills folder must not be migrated, and nothing is created for Pi
      safeWriteFile(path.join(home, '.agents', 'skills', 'keep', 'SKILL.md'), '# keep');
      safeWriteFile(path.join(hub, 'rules', 'common.md'), '# Common');
      writeHub({ srv: { command: 'node' } });
      const res = linkSkillsForAllAssistants({ homeDir: home, hubDir: hub });
      expect(res.pi).toBeUndefined();
      expect(res.agents).toBeUndefined();
      expect(projectPiRules(home, hub).message).toBe('Pi not detected; skipped projection');
      syncMcpServers(home, hub);
      runDoctor({ fix: true, homeDir: home, hubDir: hub });
      expect(fs.existsSync(path.join(home, '.pi'))).toBe(false);
      expect(fs.lstatSync(path.join(home, '.agents', 'skills')).isSymbolicLink()).toBe(false);
      expect(fs.existsSync(path.join(home, '.agents', 'skills.old'))).toBe(false);
      expect(fs.existsSync(path.join(hub, 'skills', 'keep'))).toBe(false);
    });
  });

  describe('MCP adapter', () => {
    it('writes stdio and http entries without a type, keeping platform-only keys', () => {
      const p = MCP_PLATFORMS.pi;
      expect(p.toNative({ ...stdio, type: 'stdio' })).toEqual(stdio);
      expect(p.toNative({ ...remote, type: 'http' })).toEqual(remote);
      expect(p.fromNative({ ...remote, oauth: { clientId: 'x' } })).toEqual(remote);
    });

    it('syncs a hub server with paths expanded, then reports in sync', () => {
      writeHub({ srv: stdio, rem: remote });
      expect(syncMcpServers(home, hub).success).toBe(true);
      const expanded = { command: 'node', args: [path.join(hub, 'mcp/servers/x/index.js')], env: { TOKEN: 'abc' } };
      expect(readJson(mcpFile()).mcpServers).toEqual({ srv: expanded, rem: remote });
      expect(getMcpStatus(home, hub).platforms.pi).toMatchObject({ installed: true, valid: true, missing: [], drifted: [] });
      expect(getMcpStatus(home, hub).in_sync).toBe(true);
      expect(readOrigins(hub).srv.to).toContain('pi');
      expect(syncMcpServers(home, hub).actions).toEqual(['All MCP configurations are already synchronized.']);
    });

    it('detects drift and keeps oauth and other Pi-only keys when it rewrites the entry', () => {
      writeHub({ rem: remote });
      syncMcpServers(home, hub);
      const cfg = readJson(mcpFile());
      cfg.mcpServers.rem = { url: 'https://other.example/mcp', headers: remote.headers, oauth: { clientId: 'abc' } };
      safeWriteFile(mcpFile(), JSON.stringify(cfg));
      expect(getMcpStatus(home, hub).platforms.pi).toMatchObject({ drifted: ['rem'], conflicted: [] });
      syncMcpServers(home, hub);
      expect(readJson(mcpFile()).mcpServers.rem).toEqual({ ...remote, oauth: { clientId: 'abc' } });
    });

    it('ingests a Pi-only server into the hub with paths contracted, and never writes oauth into the hub', () => {
      safeWriteFile(
        mcpFile(),
        JSON.stringify({ theme: 'x', mcpServers: { mine: { command: path.join(home, 'bin', 'mine') }, web: { ...remote, oauth: { clientId: 'x' } } } })
      );
      const res = syncMcpServers(home, hub);
      expect(res.actions).toContain('Ingested server "mine" from Pi into hub');
      const servers = readJson(hubFile()).mcpServers;
      expect(servers.mine).toEqual({ command: '${HOME}/bin/mine' });
      expect(servers.web).toEqual(remote);
      expect(readOrigins(hub).mine.from).toEqual(['pi']);
      expect(readJson(mcpFile()).theme).toBe('x');
    });

    it('leaves a same-name entry the hub never wrote alone (conflict) until forced', () => {
      writeHub({ docs: { command: 'hub-docs' } });
      safeWriteFile(mcpFile(), JSON.stringify({ mcpServers: { docs: { command: 'mine' } } }));
      expect(getMcpStatus(home, hub).platforms.pi.conflicted).toEqual(['docs']);
      expect(syncMcpServers(home, hub).actions.some((a) => a.startsWith('[CONFLICT] Pi has its own "docs"'))).toBe(true);
      expect(readJson(mcpFile()).mcpServers.docs).toEqual({ command: 'mine' });
      syncMcpServers({ homeDir: home, hubDir: hub, force: true });
      expect(readJson(mcpFile()).mcpServers.docs).toEqual({ command: 'hub-docs' });
    });

    it('refuses to overwrite a corrupt mcp.json', () => {
      writeHub({ a: { command: 'node' } });
      safeWriteFile(mcpFile(), '{ not json');
      const res = syncMcpServers(home, hub);
      expect(res.actions.some((a) => a.startsWith('[SKIP] Refusing to overwrite mcp.json'))).toBe(true);
      expect(read(mcpFile())).toBe('{ not json');
      expect(getMcpStatus(home, hub).platforms.pi.valid).toBe(false);
    });

    it('does not ingest a disabled server or a locally ignored one', () => {
      safeWriteFile(mcpFile(), JSON.stringify({ mcpServers: { off: { command: 'x', disabled: true }, work: { command: 'w' } } }));
      safeWriteFile(path.join(hub, 'local.json'), JSON.stringify({ ignore: { mcp: ['work'] } }));
      syncMcpServers(home, hub);
      const servers = fs.existsSync(hubFile()) ? readJson(hubFile()).mcpServers : {};
      expect(servers.off).toBeUndefined();
      expect(servers.work).toBeUndefined();
      expect(readJson(mcpFile()).mcpServers.work).toEqual({ command: 'w' });
    });

    it('skips sse servers and invalid names, reports them, and does not count them as missing', () => {
      writeHub({ ok: { command: 'ok' }, legacy: { url: 'https://x.example/sse', type: 'sse' }, 'bad name': { command: 'b' }, 'dots.not.ok': { command: 'd' } });
      const res = syncMcpServers(home, hub);
      expect(res.actions.some((a) => a.startsWith('[SKIP] Pi cannot take "legacy": Pi does not support sse'))).toBe(true);
      expect(res.actions.some((a) => a.startsWith('[SKIP] Pi cannot take "bad name"'))).toBe(true);
      expect(res.actions.some((a) => a.startsWith('[SKIP] Pi cannot take "dots.not.ok"'))).toBe(true);
      expect(Object.keys(readJson(mcpFile()).mcpServers)).toEqual(['ok']);
      expect(getMcpStatus(home, hub).platforms.pi.missing).toEqual([]);
      expect(getMcpStatus(home, hub).in_sync).toBe(true);
      expect(readOrigins(hub).legacy?.to ?? []).not.toContain('pi');

      const warns = unsupportedItems(home, hub);
      expect(warns.map((w) => w.name).sort()).toEqual(['bad name in Pi', 'dots.not.ok in Pi', 'legacy in Pi']);
      expect(warns.every((w) => w.level === 'WARN' && w.group === 'mcp')).toBe(true);
    });

    it('uninstall removes what the hub wrote and keeps what was there before', () => {
      safeWriteFile(mcpFile(), JSON.stringify({ mcpServers: { theirs: { command: 'theirs' } } }));
      writeHub({ mine: { command: 'mine' } });
      syncMcpServers(home, hub);
      expect(Object.keys(readJson(mcpFile()).mcpServers).sort()).toEqual(['mine', 'theirs']);

      const res = uninstallHub({ home, hub });
      expect(res.removedMcpServers).toContain('pi:mine');
      expect(res.keptMcpServers.some((k) => k.startsWith('pi:theirs'))).toBe(true);
      expect(readJson(mcpFile()).mcpServers).toEqual({ theirs: { command: 'theirs' } });
    });

    it('setup backs up an existing mcp.json and AGENTS.md', () => {
      safeWriteFile(mcpFile(), '{"mcpServers":{}}');
      safeWriteFile(rulesFile(), 'my rules');
      const backup = path.join(tmp, 'backup');
      const files = backupExistingConfigs(backup, home);
      expect(files).toEqual(expect.arrayContaining(['.pi/agent/mcp.json', '.pi/agent/AGENTS.md']));
      expect(read(path.join(backup, '.pi', 'agent', 'AGENTS.md'))).toBe('my rules');
    });
  });

  describe('rules', () => {
    beforeEach(() => {
      safeWriteFile(path.join(hub, 'rules', 'common.md'), '# Common\nBe kind.');
      safeWriteFile(path.join(hub, 'rules', 'overrides', 'pi.md'), '# Pi\nPi only.');
    });

    it('projects the rules with the header guard to ~/.pi/agent/AGENTS.md', () => {
      const res = projectPiRules(home, hub);
      expect(res.success).toBe(true);
      const text = read(rulesFile());
      expect(text.startsWith(HEADER_GUARD)).toBe(true);
      expect(text).toContain('Be kind.');
      expect(text).toContain('Pi only.');
    });

    it('backs up a hand-written AGENTS.md once, before the first overwrite, and says so', () => {
      safeWriteFile(rulesFile(), 'my own pi rules');
      const first = projectPiRules(home, hub);
      expect(first.message).toContain('backed up your AGENTS.md to');
      const dir = fs.readdirSync(path.join(hub, 'backups')).find((d) => d.startsWith('pi-rules-')) as string;
      expect(read(path.join(hub, 'backups', dir, 'AGENTS.md'))).toBe('my own pi rules');
      expect(read(rulesFile())).toContain(HEADER_GUARD);
      // the generated file is not backed up again
      expect(projectPiRules(home, hub).message).not.toContain('backed up');
      expect(fs.readdirSync(path.join(hub, 'backups')).filter((d) => d.startsWith('pi-rules-'))).toHaveLength(1);
    });

    it('does the same for Codex AGENTS.md', () => {
      safeWriteFile(path.join(home, '.codex', 'AGENTS.md'), 'my own codex rules');
      const first = projectCodexRules(home, hub);
      expect(first.message).toContain('backed up your AGENTS.md to');
      const dir = fs.readdirSync(path.join(hub, 'backups')).find((d) => d.startsWith('codex-rules-')) as string;
      expect(read(path.join(hub, 'backups', dir, 'AGENTS.md'))).toBe('my own codex rules');
      expect(projectCodexRules(home, hub).message).not.toContain('backed up');
    });

    it('is part of projectRules, and skipped when Pi is not detected', () => {
      expect(projectRules({ homeDir: home, hubDir: hub }).success).toBe(true);
      expect(fs.existsSync(rulesFile())).toBe(true);

      fs.rmSync(path.join(home, '.pi'), { recursive: true });
      const res = projectPiRules(home, hub);
      expect(res).toEqual({ success: true, message: 'Pi not detected; skipped projection' });
      expect(fs.existsSync(path.join(home, '.pi'))).toBe(false);
    });

    it('uninstall removes the generated AGENTS.md but not a hand-written one', () => {
      projectPiRules(home, hub);
      const res = uninstallHub({ home, hub });
      expect(res.removedFiles).toContain(rulesFile());
      expect(fs.existsSync(rulesFile())).toBe(false);

      safeWriteFile(rulesFile(), 'hand written');
      uninstallHub({ home, hub });
      expect(read(rulesFile())).toBe('hand written');
    });
  });

  it('doctor flags a Pi AGENTS.md without the header guard', () => {
    safeWriteFile(path.join(hub, 'agenthub.json'), '{"version":"0.1.0","platforms":{}}');
    safeWriteFile(rulesFile(), 'hand written');
    expect(runDoctor({ homeDir: home, hubDir: hub }).issues.some((m) => m.startsWith('Pi rules missing header guard'))).toBe(true);
    safeWriteFile(path.join(hub, 'rules', 'common.md'), '# Common');
    projectPiRules(home, hub);
    expect(runDoctor({ homeDir: home, hubDir: hub }).passed_checks).toContain('Pi rules verified');
  });
});
