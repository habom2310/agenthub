import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { deviceFlowRuntime, getStoredCredential, saveCredential } from '../src/core/auth.js';
import { setCustomHome } from '../src/core/detector.js';

const REG = 'https://registry.example.com';
const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

function res(status: number, body: unknown): Response {
  return {
    ok: status < 400,
    status,
    statusText: String(status),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('auth CLI commands', () => {
  let home: string;
  let logs: string[];
  let errors: string[];
  const origFetch = globalThis.fetch;
  const origToken = process.env.AGENTHUB_TOKEN;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-auth-cli-'));
    logs = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => void logs.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a) => void errors.push(a.join(' ')));
    delete process.env.AGENTHUB_TOKEN;
    delete process.env.AGENTHUB_REGISTRY_URL;
    process.exitCode = undefined;
    setCustomHome(home);
    vi.spyOn(deviceFlowRuntime, 'sleep').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = origFetch;
    setCustomHome(null, null);
    process.exitCode = undefined;
    if (origToken !== undefined) process.env.AGENTHUB_TOKEN = origToken;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const run = (...args: string[]) => runCli(['-H', home, ...args]);
  const out = () => strip(logs.join('\n'));
  const err = () => strip(errors.join('\n'));

  function mockLoginFetch(who: Response = res(200, { login: 'alice', id: 1, name: 'A', avatarUrl: '' })) {
    globalThis.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.endsWith('/api/auth/config')) return res(200, { githubClientId: 'cid' });
      if (u.endsWith('/login/device/code')) {
        return res(200, {
          device_code: 'dc',
          user_code: 'WXYZ-9999',
          verification_uri: 'https://github.com/login/device',
          interval: 5,
        });
      }
      if (u.endsWith('/login/oauth/access_token')) return res(200, { access_token: 'gho_tok' });
      if (u.endsWith('/api/auth/whoami')) return who;
      throw new Error(`unexpected ${u}`);
    }) as any;
  }

  describe('login', () => {
    it('runs the device flow, confirms via whoami and stores the credential', async () => {
      mockLoginFetch();
      await run('login', '--registry', REG);
      expect(out()).toContain('WXYZ-9999');
      expect(out()).toContain('https://github.com/login/device');
      expect(out()).toContain(`✓ Logged in to ${REG} as @alice`);
      expect(getStoredCredential(REG)).toEqual({ token: 'gho_tok', login: 'alice' });
      const whoamiCall = (globalThis.fetch as any).mock.calls.find((c: any[]) => String(c[0]).endsWith('/whoami'));
      expect(whoamiCall[1].headers.Authorization).toBe('Bearer gho_tok');
      expect(process.exitCode).toBeUndefined();
    });

    it('skips when already logged in unless --force', async () => {
      saveCredential(REG, { token: 'old', login: 'alice' });
      globalThis.fetch = vi.fn() as any;
      await run('login', '--registry', REG);
      expect(out()).toContain('Already logged in');
      expect(out()).toContain('--force');
      expect(globalThis.fetch).not.toHaveBeenCalled();

      mockLoginFetch();
      await run('login', '--registry', REG, '--force');
      expect(getStoredCredential(REG)?.token).toBe('gho_tok');
    });

    it('reports a registry without GitHub login configured', async () => {
      globalThis.fetch = vi.fn(async () => res(503, { error: 'GitHub login is not configured' })) as any;
      await run('login', '--registry', REG);
      expect(err()).toContain('GitHub login is not configured');
      expect(process.exitCode).toBe(1);
      expect(getStoredCredential(REG)).toBeUndefined();
    });

    it('does not store the token when whoami rejects it', async () => {
      mockLoginFetch(res(401, { error: 'Bad token' }));
      await run('login', '--registry', REG);
      expect(err()).toContain('Bad token');
      expect(process.exitCode).toBe(1);
      expect(getStoredCredential(REG)).toBeUndefined();
    });

    it('fails readably when the registry is unreachable', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed')) as any;
      await run('login', '--registry', REG);
      expect(err()).toContain('Could not reach registry');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('registry URL safety', () => {
    it.each([
      ['login', ['login']],
      ['whoami', ['whoami', '--token', 'tok']],
      ['unpublish', ['unpublish', 'a/b', '--token', 'tok']],
      ['share --publish', ['share', '--publish', '--token', 'tok']],
    ])('%s rejects plain http to a remote host', async (_n, args) => {
      globalThis.fetch = vi.fn() as any;
      await run(...args, '--registry', 'http://evil.example.com');
      expect(err()).toContain('must use https');
      expect(process.exitCode).toBe(1);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('allows http to localhost, 127.0.0.1 and [::1]', async () => {
      for (const host of ['localhost:8787', '127.0.0.1:8787', '[::1]:8787']) {
        process.exitCode = undefined;
        errors.length = 0;
        globalThis.fetch = vi.fn(async () => res(200, { login: 'alice' })) as any;
        await run('whoami', '--token', 'tok', '--registry', `http://${host}`);
        expect(errors).toEqual([]);
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      }
    });

    it('search still allows http', async () => {
      globalThis.fetch = vi.fn(async () => res(200, { packages: [] })) as any;
      await run('search', '--registry', 'http://remote.example.com');
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('401 hint', () => {
    it('whoami and unpublish append Run: agenthub login', async () => {
      globalThis.fetch = vi.fn(async () => res(401, { error: 'Token not issued by this registry.' })) as any;
      await run('whoami', '--token', 'pat', '--registry', REG);
      expect(err()).toContain('Token not issued by this registry. Run: agenthub login');
      errors.length = 0;
      await run('unpublish', 'a/b', '--token', 'pat', '--registry', REG);
      expect(err()).toContain('Run: agenthub login');
    });
  });

  describe('logout', () => {
    it('removes the stored credential', async () => {
      saveCredential(REG, { token: 't', login: 'alice' });
      await run('logout', '--registry', REG);
      expect(out()).toContain('Logged out');
      expect(getStoredCredential(REG)).toBeUndefined();
    });

    it('is not an error when not logged in', async () => {
      await run('logout', '--registry', REG);
      expect(out()).toContain('Not logged in');
      expect(process.exitCode).toBeUndefined();
    });
  });

  describe('whoami', () => {
    it('prints @login using the stored token', async () => {
      saveCredential(REG, { token: 'stored', login: 'alice' });
      globalThis.fetch = vi.fn(async () => res(200, { login: 'alice', id: 1 })) as any;
      await run('whoami', '--registry', REG);
      expect(out()).toBe('@alice');
      const [url, init] = (globalThis.fetch as any).mock.calls[0];
      expect(url).toBe(`${REG}/api/auth/whoami`);
      expect(init.headers.Authorization).toBe('Bearer stored');
    });

    it('exits 1 with a clear message when not logged in', async () => {
      globalThis.fetch = vi.fn() as any;
      await run('whoami', '--registry', REG);
      expect(err()).toContain('Not logged in. Run agenthub login');
      expect(process.exitCode).toBe(1);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('shows the registry error for a bad token', async () => {
      saveCredential(REG, { token: 'bad', login: 'alice' });
      globalThis.fetch = vi.fn(async () => res(401, { error: 'Invalid token' })) as any;
      await run('whoami', '--registry', REG);
      expect(err()).toContain('Invalid token');
      expect(process.exitCode).toBe(1);
    });
  });

  describe('unpublish', () => {
    it('sends an authenticated DELETE and prints the message', async () => {
      saveCredential(REG, { token: 'stored', login: 'alice' });
      globalThis.fetch = vi.fn(async () => res(200, { message: 'Package removed' })) as any;
      await run('unpublish', 'alice/my-agent', '--registry', REG);
      const [url, init] = (globalThis.fetch as any).mock.calls[0];
      expect(url).toBe(`${REG}/api/packages/alice/my-agent`);
      expect(init.method).toBe('DELETE');
      expect(init.headers.Authorization).toBe('Bearer stored');
      expect(out()).toContain('Package removed');
    });

    it('prints the registry error verbatim and exits 1', async () => {
      saveCredential(REG, { token: 'stored', login: 'alice' });
      globalThis.fetch = vi.fn(async () => res(403, { error: 'You need push access to alice/x' })) as any;
      await run('unpublish', 'alice/x', '--registry', REG);
      expect(err()).toContain('You need push access to alice/x');
      expect(process.exitCode).toBe(1);
    });

    it('needs a login and a valid owner/repo', async () => {
      globalThis.fetch = vi.fn() as any;
      await run('unpublish', 'alice/x', '--registry', REG);
      expect(err()).toContain('agenthub login');
      expect(process.exitCode).toBe(1);

      errors.length = 0;
      await run('unpublish', 'bad', '--registry', REG, '--token', 'tok');
      expect(err()).toContain('owner/repo');
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });

  describe('share --publish preflight', () => {
    function setupHub(remote?: string) {
      const hub = path.join(home, '.agenthub');
      fs.mkdirSync(hub, { recursive: true });
      spawnSync('git', ['init', '-b', 'main'], { cwd: hub });
      if (remote) spawnSync('git', ['remote', 'add', 'origin', remote], { cwd: hub });
      return hub;
    }

    it('fails before pushing when there is no token', async () => {
      const hub = setupHub('https://github.com/alice/my-agent.git');
      globalThis.fetch = vi.fn() as any;
      await run('share', '--publish');
      expect(err()).toContain('Publishing needs a login. Run: agenthub login');
      expect(process.exitCode).toBe(1);
      expect(out()).not.toContain('Ready to share');
      expect(spawnSync('git', ['log'], { cwd: hub }).status).not.toBe(0);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('fails before pushing when the remote is not on GitHub', async () => {
      const hub = setupHub('https://gitlab.com/alice/my-agent.git');
      globalThis.fetch = vi.fn() as any;
      await run('share', '--publish', '--token', 'tok');
      expect(err()).toContain('Publishing needs a public GitHub remote');
      expect(process.exitCode).toBe(1);
      expect(spawnSync('git', ['log'], { cwd: hub }).status).not.toBe(0);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('fails when there is no remote at all', async () => {
      setupHub();
      await run('share', '--publish', '--token', 'tok');
      expect(err()).toContain('Publishing needs a public GitHub remote');
      expect(process.exitCode).toBe(1);
    });
  });
});
