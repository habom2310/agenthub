import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setCustomHome } from '../src/core/detector.js';
import {
  adaptServerForClaude,
  adaptServerForGemini,
  contractPaths,
  expandPathPlaceholders,
  getMcpStatus,
  normalizeServerForHub,
  readJsonSafely,
  syncMcpServers,
} from '../src/core/mcp-sync.js';
import { ensureDir, safeWriteFile } from '../src/utils/fs.js';

describe('mcp-sync', () => {
  let tmpDir: string;
  let homeDir: string;
  let hubDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-mcp-test-'));
    homeDir = path.join(tmpDir, 'home');
    hubDir = path.join(tmpDir, 'hub');
    ensureDir(homeDir);
    ensureDir(hubDir);
    setCustomHome(homeDir, hubDir);
  });

  afterEach(() => {
    setCustomHome(null, null);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe('readJsonSafely', () => {
    it('returns empty object and success=true for nonexistent file', () => {
      const nonExistent = path.join(tmpDir, 'does-not-exist.json');
      const res = readJsonSafely(nonExistent);
      expect(res.success).toBe(true);
      expect(res.data).toEqual({});
    });

    it('returns parsed data and success=true for valid JSON object', () => {
      const file = path.join(tmpDir, 'valid.json');
      safeWriteFile(file, JSON.stringify({ a: 1, b: 'two' }));
      const res = readJsonSafely(file);
      expect(res.success).toBe(true);
      expect(res.data).toEqual({ a: 1, b: 'two' });
    });

    it('returns empty object and success=false for malformed JSON', () => {
      const file = path.join(tmpDir, 'malformed.json');
      safeWriteFile(file, '{ not valid json');
      const res = readJsonSafely(file);
      expect(res.success).toBe(false);
      expect(res.data).toEqual({});
    });

    it('returns empty object and success=false for JSON array or primitive', () => {
      const arrFile = path.join(tmpDir, 'array.json');
      safeWriteFile(arrFile, '[1, 2, 3]');
      expect(readJsonSafely(arrFile).success).toBe(false);

      const primFile = path.join(tmpDir, 'prim.json');
      safeWriteFile(primFile, '"just a string"');
      expect(readJsonSafely(primFile).success).toBe(false);

      const nullFile = path.join(tmpDir, 'null.json');
      safeWriteFile(nullFile, 'null');
      expect(readJsonSafely(nullFile).success).toBe(false);
    });

    it('supports custom generic type parameter', () => {
      interface CustomConfig {
        host: string;
        port: number;
      }
      const file = path.join(tmpDir, 'custom.json');
      safeWriteFile(file, JSON.stringify({ host: 'localhost', port: 8080 }));
      const res = readJsonSafely<CustomConfig>(file);
      expect(res.success).toBe(true);
      expect(res.data.host).toBe('localhost');
      expect(res.data.port).toBe(8080);
    });
  });

  describe('normalizeServerForHub', () => {
    it('removes ephemeral/client keys like alwaysLoad', () => {
      const raw = {
        command: 'node',
        args: ['server.js'],
        alwaysLoad: true,
        env: { PORT: '3000' },
      };
      const normalized = normalizeServerForHub('test', raw);
      expect(normalized.alwaysLoad).toBeUndefined();
      expect(normalized.command).toBe('node');
      expect(normalized.args).toEqual(['server.js']);
      expect(normalized.env).toEqual({ PORT: '3000' });
    });
  });

  describe('adaptServerForClaude & adaptServerForGemini', () => {
    it('infers type=stdio when command is present and type is absent', () => {
      const cfg = { command: 'codegraph', args: ['serve'] };
      const adaptedClaude = adaptServerForClaude('codegraph', cfg);
      expect(adaptedClaude.type).toBe('stdio');

      const adaptedGemini = adaptServerForGemini('codegraph', cfg);
      expect(adaptedGemini.type).toBe('stdio');
    });

    it('infers type=http when url is present and type is absent', () => {
      const cfg = { url: 'http://localhost:8080/mcp' };
      const adaptedClaude = adaptServerForClaude('remote', cfg);
      expect(adaptedClaude.type).toBe('http');

      const adaptedGemini = adaptServerForGemini('remote', cfg);
      expect(adaptedGemini.type).toBe('http');
    });

    it('preserves existing type if already defined', () => {
      const cfg = { command: 'node', type: 'stdio' as const };
      const adapted = adaptServerForClaude('existing', cfg);
      expect(adapted.type).toBe('stdio');
    });
  });

  describe('syncMcpServers bidirectional ingestion', () => {
    it('creates servers.json in hub when hub mcp/servers.json does not exist', () => {
      const hubServersFile = path.join(hubDir, 'mcp', 'servers.json');
      expect(fs.existsSync(hubServersFile)).toBe(false);

      const syncResult = syncMcpServers(homeDir, hubDir);
      expect(syncResult.success).toBe(true);
      expect(fs.existsSync(hubServersFile)).toBe(true);
      const data = JSON.parse(fs.readFileSync(hubServersFile, 'utf-8'));
      expect(data.mcpServers).toEqual({});
    });

    it('ingests untracked servers from Claude and Gemini into hub and updates all platforms', () => {
      // Hub has serverHub
      safeWriteFile(
        path.join(hubDir, 'mcp', 'servers.json'),
        JSON.stringify({
          mcpServers: {
            serverHub: { command: 'node', args: ['hub.js'] },
          },
        })
      );

      // Claude has serverClaude with alwaysLoad
      safeWriteFile(
        path.join(homeDir, '.claude.json'),
        JSON.stringify({
          mcpServers: {
            serverClaude: {
              command: 'claude-srv',
              args: ['run'],
              alwaysLoad: true,
            },
          },
        })
      );

      // Gemini has serverGemini
      safeWriteFile(
        path.join(homeDir, '.gemini', 'config', 'mcp_config.json'),
        JSON.stringify({
          mcpServers: {
            serverGemini: { url: 'http://localhost:8000/sse' },
          },
        })
      );

      const syncResult = syncMcpServers(homeDir, hubDir);
      expect(syncResult.success).toBe(true);

      // Verify hub servers.json has all 3 servers and alwaysLoad stripped
      const hubData = JSON.parse(
        fs.readFileSync(path.join(hubDir, 'mcp', 'servers.json'), 'utf-8')
      );
      expect(Object.keys(hubData.mcpServers).sort()).toEqual([
        'serverClaude',
        'serverGemini',
        'serverHub',
      ]);
      expect(hubData.mcpServers.serverClaude.alwaysLoad).toBeUndefined();

      // Verify Claude has all 3 servers with adapted types
      const claudeData = JSON.parse(
        fs.readFileSync(path.join(homeDir, '.claude.json'), 'utf-8')
      );
      expect(Object.keys(claudeData.mcpServers).sort()).toEqual([
        'serverClaude',
        'serverGemini',
        'serverHub',
      ]);
      expect(claudeData.mcpServers.serverHub.type).toBe('stdio');
      expect(claudeData.mcpServers.serverGemini.type).toBe('http');

      // Verify Gemini has all 3 servers with adapted types
      const geminiData = JSON.parse(
        fs.readFileSync(
          path.join(homeDir, '.gemini', 'config', 'mcp_config.json'),
          'utf-8'
        )
      );
      expect(Object.keys(geminiData.mcpServers).sort()).toEqual([
        'serverClaude',
        'serverGemini',
        'serverHub',
      ]);
      expect(geminiData.mcpServers.serverHub.type).toBe('stdio');
      expect(geminiData.mcpServers.serverGemini.type).toBe('http');
    });
  });

  describe('downstream projection preserving non-MCP keys', () => {
    it('preserves oauthAccount, machineID in Claude and customGeminiKey in Gemini', () => {
      safeWriteFile(
        path.join(hubDir, 'mcp', 'servers.json'),
        JSON.stringify({
          mcpServers: {
            codegraph: { command: 'codegraph', args: ['serve'] },
          },
        })
      );

      safeWriteFile(
        path.join(homeDir, '.claude.json'),
        JSON.stringify({
          oauthAccount: { email: 'user@example.com', id: '12345' },
          machineID: 'mid-abcdef-9876',
          theme: 'dark',
        })
      );

      safeWriteFile(
        path.join(homeDir, '.gemini', 'settings.json'),
        JSON.stringify({
          customGeminiKey: 'gemini-key-xyz-789',
          ide: { autoSave: true },
        })
      );

      const syncResult = syncMcpServers(homeDir, hubDir);
      expect(syncResult.success).toBe(true);

      const claudeData = JSON.parse(
        fs.readFileSync(path.join(homeDir, '.claude.json'), 'utf-8')
      );
      expect(claudeData.oauthAccount).toEqual({
        email: 'user@example.com',
        id: '12345',
      });
      expect(claudeData.machineID).toBe('mid-abcdef-9876');
      expect(claudeData.theme).toBe('dark');
      expect(claudeData.mcpServers.codegraph).toBeDefined();

      const geminiData = JSON.parse(
        fs.readFileSync(path.join(homeDir, '.gemini', 'settings.json'), 'utf-8')
      );
      expect(geminiData.customGeminiKey).toBe('gemini-key-xyz-789');
      expect(geminiData.ide).toEqual({ autoSave: true });
      expect(geminiData.mcpServers.codegraph).toBeDefined();
    });
  });

  describe('idempotence on repeated sync', () => {
    it('reports all configurations already synchronized on second run', () => {
      safeWriteFile(
        path.join(hubDir, 'mcp', 'servers.json'),
        JSON.stringify({
          mcpServers: {
            shared: { command: 'shared-srv' },
          },
        })
      );

      safeWriteFile(
        path.join(homeDir, '.claude.json'),
        JSON.stringify({ mcpServers: {} })
      );

      const run1 = syncMcpServers(homeDir, hubDir);
      expect(run1.success).toBe(true);
      expect(run1.actions).not.toContain(
        'All MCP configurations are already synchronized.'
      );

      const run2 = syncMcpServers(homeDir, hubDir);
      expect(run2.success).toBe(true);
      expect(run2.actions).toEqual([
        'All MCP configurations are already synchronized.',
      ]);
    });
  });

  describe('corrupt JSON protection', () => {
    it('aborts when hub servers.json is corrupt', () => {
      safeWriteFile(
        path.join(hubDir, 'mcp', 'servers.json'),
        '{ corrupted json'
      );
      safeWriteFile(
        path.join(homeDir, '.claude.json'),
        JSON.stringify({ mcpServers: {} })
      );

      const res = syncMcpServers(homeDir, hubDir);
      expect(res.success).toBe(false);
      expect(res.actions).toContain(
        'Aborting MCP sync: servers.json is corrupt or unparseable'
      );
    });

    it('skips corrupt .claude.json without overwriting it', () => {
      safeWriteFile(
        path.join(hubDir, 'mcp', 'servers.json'),
        JSON.stringify({
          mcpServers: { myServer: { command: 'node' } },
        })
      );
      const corruptClaudeContent = '{ broken claude json';
      safeWriteFile(path.join(homeDir, '.claude.json'), corruptClaudeContent);

      const res = syncMcpServers(homeDir, hubDir);
      expect(res.success).toBe(true);
      expect(res.actions).toContain(
        '[SKIP] Refusing to overwrite .claude.json: file is corrupt or unparseable'
      );

      // Verify file wasn't altered
      expect(
        fs.readFileSync(path.join(homeDir, '.claude.json'), 'utf-8')
      ).toBe(corruptClaudeContent);
    });

    it('skips corrupt gemini config without overwriting it', () => {
      safeWriteFile(
        path.join(hubDir, 'mcp', 'servers.json'),
        JSON.stringify({
          mcpServers: { myServer: { command: 'node' } },
        })
      );
      const corruptMcp = '{ broken gemini mcp';
      safeWriteFile(
        path.join(homeDir, '.gemini', 'config', 'mcp_config.json'),
        corruptMcp
      );

      const res = syncMcpServers(homeDir, hubDir);
      expect(res.success).toBe(true);
      expect(res.actions).toContain(
        '[SKIP] Refusing to overwrite mcp_config.json: file is corrupt or unparseable'
      );

      expect(
        fs.readFileSync(
          path.join(homeDir, '.gemini', 'config', 'mcp_config.json'),
          'utf-8'
        )
      ).toBe(corruptMcp);
    });
  });

  describe('drift detection', () => {
    it('detects drift when server arguments or command change, and fixes on sync', () => {
      safeWriteFile(
        path.join(hubDir, 'mcp', 'servers.json'),
        JSON.stringify({
          mcpServers: {
            app: { command: 'node', args: ['server.js', '--port', '3000'] },
          },
        })
      );

      safeWriteFile(
        path.join(homeDir, '.claude.json'),
        JSON.stringify({
          mcpServers: {
            app: {
              command: 'node',
              args: ['server.js', '--port', '5000'],
              type: 'stdio',
            },
          },
        })
      );

      const statusBefore = getMcpStatus(homeDir, hubDir);
      expect(statusBefore.in_sync).toBe(false);
      expect(statusBefore.drifted_in_claude).toEqual(['app']);
      expect(statusBefore.missing_in_claude).toEqual([]);

      const syncRes = syncMcpServers({ homeDir, hubDir, force: true });
      expect(syncRes.success).toBe(true);

      const statusAfter = getMcpStatus(homeDir, hubDir);
      expect(statusAfter.in_sync).toBe(true);
      expect(statusAfter.drifted_in_claude).toEqual([]);

      const claudeData = JSON.parse(
        fs.readFileSync(path.join(homeDir, '.claude.json'), 'utf-8')
      );
      expect(claudeData.mcpServers.app.args).toEqual([
        'server.js',
        '--port',
        '3000',
      ]);
    });

    it('treats a missing type as stdio and ignores alwaysLoad', () => {
      safeWriteFile(
        path.join(hubDir, 'mcp', 'servers.json'),
        JSON.stringify({
          mcpServers: {
            codegraph: { command: 'codegraph', args: ['serve', '--mcp'] },
            typed: { type: 'stdio', command: 'typed-srv' },
          },
        })
      );
      const claudeServers = {
        codegraph: {
          type: 'stdio',
          command: 'codegraph',
          args: ['serve', '--mcp'],
          alwaysLoad: true,
        },
        typed: { command: 'typed-srv' },
      };
      safeWriteFile(
        path.join(homeDir, '.claude.json'),
        JSON.stringify({ mcpServers: claudeServers })
      );
      const geminiServers = {
        codegraph: { command: 'codegraph', args: ['serve', '--mcp'] },
        typed: { command: 'typed-srv' },
      };
      safeWriteFile(
        path.join(homeDir, '.gemini', 'config', 'mcp_config.json'),
        JSON.stringify({ mcpServers: geminiServers })
      );

      const status = getMcpStatus(homeDir, hubDir);
      expect(status.drifted_in_claude).toEqual([]);
      expect(status.drifted_in_gemini).toEqual([]);
      expect(status.in_sync).toBe(true);

      // Sync fills in the missing type but keeps client keys like alwaysLoad.
      syncMcpServers(homeDir, hubDir);
      const claudeData = JSON.parse(
        fs.readFileSync(path.join(homeDir, '.claude.json'), 'utf-8')
      );
      expect(claudeData.mcpServers.codegraph).toEqual(claudeServers.codegraph);
      expect(claudeData.mcpServers.typed).toEqual({ type: 'stdio', command: 'typed-srv' });
      const geminiData = JSON.parse(
        fs.readFileSync(
          path.join(homeDir, '.gemini', 'config', 'mcp_config.json'),
          'utf-8'
        )
      );
      expect(geminiData.mcpServers.codegraph.type).toBe('stdio');
      expect(getMcpStatus(homeDir, hubDir).in_sync).toBe(true);
      expect(syncMcpServers(homeDir, hubDir).actions).toEqual([
        'All MCP configurations are already synchronized.',
      ]);
    });

    it.each(['sse', 'http'])(
      'detects drift between stdio and %s, and fixes it on sync',
      (otherType) => {
        safeWriteFile(
          path.join(hubDir, 'mcp', 'servers.json'),
          JSON.stringify({
            mcpServers: {
              implicit: { command: 'srv' },
              explicit: { type: 'stdio', command: 'srv' },
            },
          })
        );
        safeWriteFile(
          path.join(homeDir, '.claude.json'),
          JSON.stringify({
            mcpServers: {
              implicit: { type: otherType, command: 'srv' },
              explicit: { type: otherType, command: 'srv' },
            },
          })
        );

        const status = getMcpStatus(homeDir, hubDir);
        expect(status.drifted_in_claude.sort()).toEqual(['explicit', 'implicit']);
        expect(status.in_sync).toBe(false);

        syncMcpServers({ homeDir, hubDir, force: true });
        const after = getMcpStatus(homeDir, hubDir);
        expect(after.in_sync).toBe(true);
        const claudeData = JSON.parse(
          fs.readFileSync(path.join(homeDir, '.claude.json'), 'utf-8')
        );
        expect(claudeData.mcpServers.implicit.type).toBe('stdio');
        expect(claudeData.mcpServers.explicit.type).toBe('stdio');
      }
    );

    it('leaves a Claude or Gemini entry the hub never wrote alone, and --force overwrites it after a backup', () => {
      safeWriteFile(path.join(hubDir, 'mcp', 'servers.json'), JSON.stringify({ mcpServers: { app: { command: 'hub-app' } } }));
      safeWriteFile(path.join(homeDir, '.claude.json'), JSON.stringify({ mcpServers: { app: { command: 'mine' } } }));
      safeWriteFile(path.join(homeDir, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: { app: { command: 'mine-g' } } }));

      expect(getMcpStatus(homeDir, hubDir).platforms.claude.conflicted).toEqual(['app']);
      const res = syncMcpServers(homeDir, hubDir);
      expect(res.actions.filter((a) => a.startsWith('[CONFLICT]')).map((a) => a.split(' ')[1])).toEqual(['Claude', 'Gemini']);
      expect(JSON.parse(fs.readFileSync(path.join(homeDir, '.claude.json'), 'utf-8')).mcpServers.app.command).toBe('mine');

      const forced = syncMcpServers({ homeDir, hubDir, force: true });
      expect(forced.actions.some((a) => a.startsWith('Backed up .claude.json to '))).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(homeDir, '.claude.json'), 'utf-8')).mcpServers.app.command).toBe('hub-app');
      const backups = fs.readdirSync(path.join(hubDir, 'backups')).filter((d) => d.startsWith('mcp-sync-'));
      const saved = JSON.parse(fs.readFileSync(path.join(hubDir, 'backups', backups[0], '.claude.json'), 'utf-8'));
      expect(saved.mcpServers.app.command).toBe('mine');
      expect(getMcpStatus(homeDir, hubDir).in_sync).toBe(true);
    });

    it('detects drift for a url server with sse type when the hub has no type', () => {
      safeWriteFile(
        path.join(hubDir, 'mcp', 'servers.json'),
        JSON.stringify({ mcpServers: { remote: { url: 'https://example.test/mcp' } } })
      );
      safeWriteFile(
        path.join(homeDir, '.claude.json'),
        JSON.stringify({
          mcpServers: { remote: { type: 'sse', url: 'https://example.test/mcp' } },
        })
      );

      expect(getMcpStatus(homeDir, hubDir).drifted_in_claude).toEqual(['remote']);
      syncMcpServers({ homeDir, hubDir, force: true });
      const claudeData = JSON.parse(
        fs.readFileSync(path.join(homeDir, '.claude.json'), 'utf-8')
      );
      expect(claudeData.mcpServers.remote.type).toBe('http');
    });

    it('still detects env and url differences', () => {
      safeWriteFile(
        path.join(hubDir, 'mcp', 'servers.json'),
        JSON.stringify({
          mcpServers: {
            withEnv: { command: 'srv', env: { TOKEN_NAME: 'a' } },
            remote: { url: 'https://example.test/mcp' },
          },
        })
      );
      safeWriteFile(
        path.join(homeDir, '.claude.json'),
        JSON.stringify({
          mcpServers: {
            withEnv: { type: 'stdio', command: 'srv', env: { OTHER_NAME: 'a' } },
            remote: { type: 'http', url: 'https://other.test/mcp' },
          },
        })
      );

      const status = getMcpStatus(homeDir, hubDir);
      expect(status.drifted_in_claude.sort()).toEqual(['remote', 'withEnv']);
    });
  });

  describe('uninstalled platform handling', () => {
    it('skips uninstalled platforms and avoids creating ghost files/dirs', () => {
      // Hub has servers
      safeWriteFile(
        path.join(hubDir, 'mcp', 'servers.json'),
        JSON.stringify({
          mcpServers: {
            standalone: { command: 'standalone' },
          },
        })
      );

      // Home has neither .claude nor .gemini
      const status = getMcpStatus(homeDir, hubDir);
      expect(status.missing_in_claude).toEqual([]);
      expect(status.missing_in_gemini).toEqual([]);
      expect(status.in_sync).toBe(true);

      const syncRes = syncMcpServers({ homeDir, hubDir, force: true });
      expect(syncRes.success).toBe(true);

      // Verify no ghost files or directories created
      expect(fs.existsSync(path.join(homeDir, '.claude.json'))).toBe(false);
      expect(fs.existsSync(path.join(homeDir, '.claude'))).toBe(false);
      expect(fs.existsSync(path.join(homeDir, '.gemini'))).toBe(false);
    });
  });

  describe('portable paths', () => {
    it('expands ${HUB}, ${HOME} and a leading ~', () => {
      expect(expandPathPlaceholders('${HUB}/mcp/s/run.js', '/h', '/h/.agenthub')).toBe('/h/.agenthub/mcp/s/run.js');
      expect(expandPathPlaceholders('${HOME}/bin/x', '/h', '/hub')).toBe('/h/bin/x');
      expect(expandPathPlaceholders('~/bin/x', '/h', '/hub')).toBe('/h/bin/x');
      expect(expandPathPlaceholders('~', '/h', '/hub')).toBe('/h');
      expect(expandPathPlaceholders('a~/b', '/h', '/hub')).toBe('a~/b');
      expect(expandPathPlaceholders('~user/x', '/h', '/hub')).toBe('~user/x');
      expect(expandPathPlaceholders('~\\x', '/h', '/hub')).toBe('~\\x');
      // args and env values: only when the whole value is a path
      expect(expandPathPlaceholders('~/a b', '/h', '/hub', 'value')).toBe('~/a b');
      expect(expandPathPlaceholders('~/data', '/h', '/hub', 'value')).toBe('/h/data');
      expect(expandPathPlaceholders('~', '/h', '/hub', 'value')).toBe('/h');
      // never in urls, but placeholders still expand
      expect(expandPathPlaceholders('~/x', '/h', '/hub', 'url')).toBe('~/x');
      expect(expandPathPlaceholders('file://${HUB}/x', '/h', '/hub', 'url')).toBe('file:///hub/x');
      expect(expandPathPlaceholders('npx', '/h', '/hub')).toBe('npx');
    });

    it('contracts hub and home paths, hub first, only on path boundaries', () => {
      const home = '/Users/me';
      const hub = '/Users/me/.agenthub';
      expect(contractPaths('/Users/me/.agenthub/mcp/x.js', home, hub)).toBe('${HUB}/mcp/x.js');
      expect(contractPaths('/Users/me/bin/x', home, hub)).toBe('${HOME}/bin/x');
      expect(contractPaths('--dir=/Users/me/data', home, hub)).toBe('--dir=${HOME}/data');
      expect(contractPaths('/Users/me', home, hub)).toBe('${HOME}');
      expect(contractPaths('/Users/menace/x', home, hub)).toBe('/Users/menace/x');
      expect(contractPaths('/opt/other', home, hub)).toBe('/opt/other');
      expect(contractPaths('file:///Users/me/x.sock', home, hub)).toBe('file://${HOME}/x.sock');
      // separators inside a contracted value become forward slashes
      expect(contractPaths('C:\\Users\\me\\bin\\x', 'C:\\Users\\me', 'C:\\Users\\me\\.agenthub')).toBe('${HOME}/bin/x');
    });

    it('projects expanded paths to Claude and Gemini but keeps the hub form', () => {
      ensureDir(path.join(homeDir, '.claude'));
      ensureDir(path.join(homeDir, '.gemini'));
      const hubServer = {
        command: '${HOME}/bin/tool',
        args: ['${HUB}/mcp/servers/t/run.js', '~/data'],
        env: { ROOT: '${HUB}' },
      };
      safeWriteFile(path.join(hubDir, 'mcp', 'servers.json'), JSON.stringify({ mcpServers: { t: hubServer } }));

      syncMcpServers(homeDir, hubDir);

      const claude = JSON.parse(fs.readFileSync(path.join(homeDir, '.claude.json'), 'utf-8'));
      expect(claude.mcpServers.t).toMatchObject({
        command: path.join(homeDir, 'bin', 'tool'),
        args: [path.join(hubDir, 'mcp', 'servers', 't', 'run.js'), path.join(homeDir, 'data')],
        env: { ROOT: hubDir },
      });
      const gemini = JSON.parse(fs.readFileSync(path.join(homeDir, '.gemini', 'config', 'mcp_config.json'), 'utf-8'));
      expect(gemini.mcpServers.t.command).toBe(path.join(homeDir, 'bin', 'tool'));

      const hubAfter = JSON.parse(fs.readFileSync(path.join(hubDir, 'mcp', 'servers.json'), 'utf-8'));
      expect(hubAfter.mcpServers.t).toEqual(hubServer);

      // Expanded forms are compared, so the placeholders do not show up as drift
      const status = getMcpStatus(homeDir, hubDir);
      expect(status.drifted_in_claude).toEqual([]);
      expect(status.drifted_in_gemini).toEqual([]);
      expect(status.in_sync).toBe(true);
    });

    it('expands and contracts cwd and url too', () => {
      ensureDir(path.join(homeDir, '.claude'));
      const hubServer = { command: 'node', cwd: '${HUB}/mcp/servers/c', url: 'http://localhost/${HOME}/x' };
      safeWriteFile(path.join(hubDir, 'mcp', 'servers.json'), JSON.stringify({ mcpServers: { c: hubServer } }));
      syncMcpServers(homeDir, hubDir);
      const claude = JSON.parse(fs.readFileSync(path.join(homeDir, '.claude.json'), 'utf-8'));
      expect(claude.mcpServers.c.cwd).toBe(path.join(hubDir, 'mcp', 'servers', 'c'));
      expect(claude.mcpServers.c.url).toBe(`http://localhost/${homeDir}/x`);
      expect(getMcpStatus(homeDir, hubDir).in_sync).toBe(true);
    });

    it('contracts absolute paths when ingesting from Claude', () => {
      safeWriteFile(
        path.join(homeDir, '.claude.json'),
        JSON.stringify({
          mcpServers: {
            mine: { command: 'node', args: [path.join(hubDir, 'mcp', 'servers', 'mine', 'i.js')], env: { D: path.join(homeDir, 'd') } },
          },
        })
      );
      syncMcpServers(homeDir, hubDir);
      const hubAfter = JSON.parse(fs.readFileSync(path.join(hubDir, 'mcp', 'servers.json'), 'utf-8'));
      expect(hubAfter.mcpServers.mine.args).toEqual(['${HUB}/mcp/servers/mine/i.js']);
      expect(hubAfter.mcpServers.mine.env).toEqual({ D: '${HOME}/d' });
      expect(getMcpStatus(homeDir, hubDir).in_sync).toBe(true);
    });
  });
});
