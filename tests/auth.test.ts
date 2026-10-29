import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteCredential,
  getAuthFilePath,
  getStoredCredential,
  resolveToken,
  runDeviceFlow,
  saveCredential,
} from '../src/core/auth.js';
import { setCustomHome } from '../src/core/detector.js';

const REG = 'https://registry.example.com';

describe('credential store', () => {
  let home: string;
  const origXdg = process.env.XDG_CONFIG_HOME;
  const origToken = process.env.AGENTHUB_TOKEN;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-auth-test-'));
    setCustomHome(home);
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.AGENTHUB_TOKEN;
    delete process.env.AGENTHUB_REGISTRY_URL;
  });

  afterEach(() => {
    setCustomHome(null, null);
    fs.rmSync(home, { recursive: true, force: true });
    if (origXdg !== undefined) process.env.XDG_CONFIG_HOME = origXdg;
    else delete process.env.XDG_CONFIG_HOME;
    if (origToken !== undefined) process.env.AGENTHUB_TOKEN = origToken;
    else delete process.env.AGENTHUB_TOKEN;
  });

  it('stores under <home>/.config/agenthub/auth.json with 0600 file and 0700 dir', () => {
    saveCredential(REG, { token: 't1', login: 'alice' });
    const file = path.join(home, '.config', 'agenthub', 'auth.json');
    expect(getAuthFilePath()).toBe(file);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({
      registries: { [REG]: { token: 't1', login: 'alice' } },
    });
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    }
  });

  it('keeps credentials per normalized registry', () => {
    saveCredential(`${REG}/`, { token: 't1', login: 'alice' });
    saveCredential('https://other.example.com', { token: 't2', login: 'bob' });
    expect(getStoredCredential(REG)?.login).toBe('alice');
    expect(getStoredCredential('https://other.example.com/')?.login).toBe('bob');
    expect(getStoredCredential('https://none.example.com')).toBeUndefined();
  });

  it('deletes only the given registry and reports whether anything was removed', () => {
    saveCredential(REG, { token: 't1', login: 'alice' });
    saveCredential('https://other.example.com', { token: 't2', login: 'bob' });
    expect(deleteCredential(REG)).toBe(true);
    expect(deleteCredential(REG)).toBe(false);
    expect(getStoredCredential(REG)).toBeUndefined();
    expect(getStoredCredential('https://other.example.com')?.token).toBe('t2');
  });

  it('is never written inside the hub directory', () => {
    const hub = path.join(home, '.agenthub');
    saveCredential(REG, { token: 't1', login: 'alice' });
    expect(path.relative(hub, getAuthFilePath()).startsWith('..')).toBe(true);
    expect(fs.existsSync(hub)).toBe(false);

    setCustomHome(home, path.join(home, '.config'));
    expect(() => saveCredential(REG, { token: 't2', login: 'alice' })).toThrow(/hub directory/);
  });

  it('detects the hub dir through symlinks', () => {
    const real = path.join(home, 'real-hub');
    fs.mkdirSync(path.join(real, 'agenthub'), { recursive: true });
    const link = path.join(home, 'link-hub');
    fs.symlinkSync(real, link);
    // auth dir (<home>/.config/agenthub) is reached via a symlinked "hub" path
    fs.mkdirSync(path.join(home, '.config'), { recursive: true });
    const cfg = path.join(home, '.config');
    fs.rmSync(cfg, { recursive: true });
    fs.symlinkSync(real, cfg);
    setCustomHome(home, link);
    expect(() => saveCredential(REG, { token: 't', login: 'a' })).toThrow(/hub directory/);
  });

  it('tightens an existing config dir to 0700 and leaves no temp files', () => {
    const dir = path.dirname(getAuthFilePath());
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    saveCredential(REG, { token: 't1', login: 'alice' });
    if (process.platform !== 'win32') expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(dir)).toEqual(['auth.json']);
  });

  it('survives a corrupt auth file', () => {
    const file = getAuthFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not json');
    expect(getStoredCredential(REG)).toBeUndefined();
    saveCredential(REG, { token: 't1', login: 'alice' });
    expect(getStoredCredential(REG)?.token).toBe('t1');
  });

  it('resolves token as --token > AGENTHUB_TOKEN > stored', () => {
    expect(resolveToken(REG)).toBeUndefined();
    saveCredential(REG, { token: 'stored', login: 'alice' });
    expect(resolveToken(REG)).toBe('stored');
    process.env.AGENTHUB_TOKEN = 'env';
    expect(resolveToken(REG)).toBe('env');
    expect(resolveToken(REG, 'explicit')).toBe('explicit');
    expect(resolveToken(REG, '   ')).toBe('env');
  });

  it('ignores AGENTHUB_PUBLISH_SECRET', () => {
    process.env.AGENTHUB_PUBLISH_SECRET = 'legacy';
    expect(resolveToken(REG)).toBeUndefined();
    delete process.env.AGENTHUB_PUBLISH_SECRET;
  });
});

describe('XDG_CONFIG_HOME', () => {
  const origXdg = process.env.XDG_CONFIG_HOME;
  afterEach(() => {
    setCustomHome(null, null);
    if (origXdg !== undefined) process.env.XDG_CONFIG_HOME = origXdg;
    else delete process.env.XDG_CONFIG_HOME;
  });

  it('is used without a home override and ignored with one', () => {
    process.env.XDG_CONFIG_HOME = '/xdg/config';
    expect(getAuthFilePath()).toBe(path.join('/xdg/config', 'agenthub', 'auth.json'));
    setCustomHome('/custom/home');
    expect(getAuthFilePath()).toBe(path.join('/custom/home', '.config', 'agenthub', 'auth.json'));
  });
});

describe('runDeviceFlow', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  const json = (body: unknown, status = 200) =>
    ({ ok: status < 400, status, statusText: 'x', json: async () => body }) as Response;
  const deviceCode = json({
    device_code: 'dc',
    user_code: 'ABCD-1234',
    verification_uri: 'https://github.com/login/device',
    interval: 5,
  });

  function mockSequence(...polls: Response[]) {
    const fn = vi.fn();
    fn.mockResolvedValueOnce(deviceCode);
    for (const p of polls) fn.mockResolvedValueOnce(p);
    globalThis.fetch = fn;
    return fn;
  }

  it('requests a code, polls, and returns the token', async () => {
    const fn = mockSequence(json({ error: 'authorization_pending' }), json({ access_token: 'gho_x' }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const onCode = vi.fn();

    const token = await runDeviceFlow({ clientId: 'cid', sleep, onCode });

    expect(token).toBe('gho_x');
    expect(onCode).toHaveBeenCalledWith({
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
    });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([5000, 5000]);
    const [codeUrl, codeInit] = fn.mock.calls[0];
    expect(codeUrl).toBe('https://github.com/login/device/code');
    expect(codeInit.headers.Accept).toBe('application/json');
    expect(codeInit.body).toBe('client_id=cid');
    const [pollUrl, pollInit] = fn.mock.calls[1];
    expect(pollUrl).toBe('https://github.com/login/oauth/access_token');
    const form = new URLSearchParams(pollInit.body);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
    expect(form.get('device_code')).toBe('dc');
    expect(form.get('client_id')).toBe('cid');
  });

  it('adds 5s to the interval on slow_down', async () => {
    mockSequence(json({ error: 'slow_down' }), json({ error: 'authorization_pending' }), json({ access_token: 't' }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await runDeviceFlow({ clientId: 'cid', sleep });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([5000, 10000, 10000]);
  });

  it('enforces a 5s minimum interval when GitHub sends 0 or nothing', async () => {
    for (const interval of [0, undefined]) {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(json({ device_code: 'd', user_code: 'u', verification_uri: 'v', interval }))
        .mockResolvedValueOnce(json({ access_token: 't' }));
      const sleep = vi.fn().mockResolvedValue(undefined);
      await runDeviceFlow({ clientId: 'c', sleep });
      expect(sleep.mock.calls[0][0]).toBe(5000);
    }
  });

  it('keeps polling through transient network errors', async () => {
    mockSequence(json({}, 502));
    const fn = globalThis.fetch as any;
    fn.mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(json({ access_token: 'ok' }));
    // device code, then 502 (no error field), then network error, then token
    const sleep = vi.fn().mockResolvedValue(undefined);
    expect(await runDeviceFlow({ clientId: 'c', sleep })).toBe('ok');
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('treats expires_in as a hard deadline even if polls keep failing', async () => {
    const fn = vi.fn().mockResolvedValueOnce(
      json({ device_code: 'd', user_code: 'u', verification_uri: 'v', interval: 5, expires_in: 20 })
    );
    fn.mockRejectedValue(new TypeError('fetch failed'));
    globalThis.fetch = fn;
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(runDeviceFlow({ clientId: 'c', sleep })).rejects.toThrow(/expired/);
    expect(sleep).toHaveBeenCalledTimes(4);
  });

  it('fails on expired_token', async () => {
    mockSequence(json({ error: 'expired_token' }));
    await expect(runDeviceFlow({ clientId: 'c', sleep: async () => {} })).rejects.toThrow(/expired/);
  });

  it('fails on access_denied', async () => {
    mockSequence(json({ error: 'access_denied' }));
    await expect(runDeviceFlow({ clientId: 'c', sleep: async () => {} })).rejects.toThrow(/denied/);
  });

  it('fails on an unknown error with GitHub description', async () => {
    mockSequence(json({ error: 'incorrect_client_credentials', error_description: 'Bad client' }));
    await expect(runDeviceFlow({ clientId: 'c', sleep: async () => {} })).rejects.toThrow('Bad client');
  });

  it('fails clearly when GitHub is unreachable', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(runDeviceFlow({ clientId: 'c', sleep: async () => {} })).rejects.toThrow(/Could not reach GitHub/);
  });
});
