import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getHomeDir, getHubDir } from './detector.js';
import { getCleanBaseUrl } from './registry.js';

export interface StoredCredential {
  token: string;
  login: string;
}

interface AuthFile {
  registries: Record<string, StoredCredential>;
}

/**
 * Credentials live outside the hub (which is a pushed git repo):
 * <home>/.config/agenthub/auth.json, or $XDG_CONFIG_HOME/agenthub/auth.json
 * when the real home is in use.
 */
export function getAuthFilePath(): string {
  const home = getHomeDir();
  const xdg = process.env.XDG_CONFIG_HOME;
  const configDir = xdg && home === os.homedir() ? xdg : path.join(home, '.config');
  return path.join(configDir, 'agenthub', 'auth.json');
}

function readAuthFile(): AuthFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(getAuthFilePath(), 'utf-8'));
    if (parsed && typeof parsed.registries === 'object' && parsed.registries) return parsed;
  } catch {}
  return { registries: {} };
}

/** Resolves symlinks on the deepest existing ancestor, then re-appends the missing tail. */
function realpathLoose(p: string): string {
  let current = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p);
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

function writeAuthFile(file: AuthFile): void {
  const authPath = getAuthFilePath();
  const rel = path.relative(realpathLoose(getHubDir()), realpathLoose(authPath));
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    throw new Error(`Refusing to store credentials inside the hub directory: ${authPath}`);
  }
  const dir = path.dirname(authPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const tmp = `${authPath}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, authPath);
}

export function getStoredCredential(registryUrl?: string): StoredCredential | undefined {
  const cred = readAuthFile().registries[getCleanBaseUrl(registryUrl)];
  return cred?.token ? cred : undefined;
}

export function saveCredential(registryUrl: string | undefined, cred: StoredCredential): void {
  const file = readAuthFile();
  file.registries[getCleanBaseUrl(registryUrl)] = { token: cred.token, login: cred.login };
  writeAuthFile(file);
}

/** Returns true if a credential was removed. */
export function deleteCredential(registryUrl?: string): boolean {
  const file = readAuthFile();
  const key = getCleanBaseUrl(registryUrl);
  if (!(key in file.registries)) return false;
  delete file.registries[key];
  writeAuthFile(file);
  return true;
}

/**
 * Token resolution: explicit --token > AGENTHUB_TOKEN env > stored credential.
 */
export function resolveToken(registryUrl?: string, explicit?: string): string | undefined {
  return (
    explicit?.trim() ||
    process.env.AGENTHUB_TOKEN?.trim() ||
    getStoredCredential(registryUrl)?.token ||
    undefined
  );
}

export interface DeviceFlowOptions {
  clientId: string;
  sleep?: (ms: number) => Promise<void>;
  onCode?: (info: { userCode: string; verificationUri: string }) => void;
}

/** Overridable by tests so the CLI never really waits. */
export const deviceFlowRuntime = {
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
};

const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const MIN_POLL_INTERVAL_MS = 5000;

class TransientError extends Error {}

async function githubPost(url: string, body: Record<string, string>): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err: any) {
    throw new TransientError(`Could not reach GitHub (${err?.cause?.code || err?.message || err})`);
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok && !data.error) {
    throw new TransientError(`GitHub request failed: ${res.status} ${res.statusText}`);
  }
  return data;
}

/**
 * GitHub OAuth device flow (no client secret). Resolves to the user access token; throws on failure.
 * Transient network errors while polling are retried until the code expires.
 */
export async function runDeviceFlow(options: DeviceFlowOptions): Promise<string> {
  const sleep = options.sleep ?? deviceFlowRuntime.sleep;

  const code = await githubPost(GITHUB_DEVICE_CODE_URL, { client_id: options.clientId });
  if (!code.device_code || !code.user_code || !code.verification_uri) {
    throw new Error(code.error_description || code.error || 'GitHub returned an invalid device code response');
  }
  options.onCode?.({ userCode: code.user_code, verificationUri: code.verification_uri });

  let interval = Math.max(Number(code.interval) * 1000 || 0, MIN_POLL_INTERVAL_MS);
  const expiresMs = (Number(code.expires_in) || 900) * 1000;
  const expired = () => new Error('The login code expired. Run agenthub login again.');
  const start = Date.now();
  let slept = 0;

  for (;;) {
    if (Math.max(slept, Date.now() - start) + interval > expiresMs) throw expired();
    await sleep(interval);
    slept += interval;
    let data: any;
    try {
      data = await githubPost(GITHUB_ACCESS_TOKEN_URL, {
        client_id: options.clientId,
        device_code: code.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
    } catch (err) {
      if (err instanceof TransientError) continue;
      throw err;
    }
    if (data.access_token) return data.access_token;
    switch (data.error) {
      case 'authorization_pending':
        break;
      case 'slow_down':
        interval += 5000;
        break;
      case 'expired_token':
        throw expired();
      case 'access_denied':
        throw new Error('Login was denied on GitHub.');
      default:
        throw new Error(data.error_description || data.error || 'GitHub login failed');
    }
  }
}
