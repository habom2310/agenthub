import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDeclaredSource } from '../src/core/manifest.js';
import {
  emptyLock,
  loadLock,
  loadLockChecked,
  compareVersions,
  parseDeclaredSources,
  parseSourceSpec,
  resolvePin,
  runtime,
  saveLock,
  serializeLock,
} from '../src/core/sources.js';

const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });

describe('parseSourceSpec', () => {
  it('parses local, github, git, npm and pypi strings', () => {
    expect(parseSourceSpec('skills', 'a', 'local').parsed).toEqual({ type: 'local', build: undefined });
    expect(parseSourceSpec('skills', 'a', 'github:o/r#skills/a').parsed).toMatchObject({
      type: 'github',
      url: 'https://github.com/o/r.git',
      subpath: 'skills/a',
    });
    expect(parseSourceSpec('skills', 'a', 'git:file:///tmp/r#skills/a').parsed).toMatchObject({
      type: 'git',
      url: 'file:///tmp/r',
      subpath: 'skills/a',
    });
    expect(parseSourceSpec('mcp', 'a', 'npm:@scope/pkg@^1.2').parsed).toEqual({
      type: 'npm',
      pkg: '@scope/pkg',
      range: '^1.2',
      subpath: undefined,
    });
    expect(parseSourceSpec('mcp', 'a', 'npm:pkg').parsed).toMatchObject({ pkg: 'pkg', range: 'latest' });
    expect(parseSourceSpec('skills', 'a', 'npm:pkg@1#skills/a').parsed).toMatchObject({ subpath: 'skills/a' });
    expect(parseSourceSpec('mcp', 'a', 'pypi:mcp-thing@1.0.0').parsed).toEqual({
      type: 'pypi',
      pkg: 'mcp-thing',
      range: '1.0.0',
    });
  });

  it('parses object forms with ref, build and custom commands', () => {
    const gh = parseSourceSpec('mcp', 'a', { source: 'github:o/r', ref: 'v1', build: 'npm ci' });
    expect(gh.parsed).toMatchObject({ type: 'github', ref: 'v1', build: 'npm ci' });
    expect(gh.spec).toBe('github:o/r ref=v1');
    expect(parseSourceSpec('mcp', 'a', { source: 'local', build: 'make' }).parsed).toEqual({ type: 'local', build: 'make' });
    expect(parseSourceSpec('skills', 'a', { install: 'i', check: 'c', path: '~/x' }).parsed).toEqual({
      type: 'custom',
      install: 'i',
      check: 'c',
      path: '~/x',
    });
  });

  it.each([
    ['skills', 'bad name', 'local', 'invalid name'],
    ['skills', 'a', 'ftp:whatever', 'unknown source'],
    ['skills', 'a', 'github:nope', 'expected github:owner/repo'],
    ['skills', 'a', 'github:o/r#../etc', 'invalid subpath'],
    ['skills', 'a', 'pypi:pkg', 'only supported for MCP'],
    ['mcp', 'a', 'npm:pkg#sub', 'only supported for skills'],
    ['skills', 'a', { install: 'i', check: 'c' }, 'needs "path"'],
    ['mcp', 'a', { install: 'i' }, 'needs a "check" command'],
    ['skills', 'a', { source: 'local', build: 'x' }, 'only supported for MCP'],
    ['mcp', 'a', { source: 'npm:p', build: 'x' }, '"build" is only supported'],
    ['mcp', 'a', { source: 'npm:p', ref: 'x' }, '"ref" is only supported'],
    ['mcp', 'a', { source: 'github:o/r', ref: '-x' }, 'invalid ref'],
    ['mcp', 'a', { source: 'local', install: 'i' }, 'cannot be combined'],
    ['mcp', 'a', 42, 'expected a source string'],
    ['mcp', 'a', 'npm:pkg@1.0 || 2.0', 'expected npm:pkg@range'],
    ['mcp', 'a', 'npm:pkg@1;touch x', 'expected npm:pkg@range'],
    ['mcp', 'a', 'npm:pkg@^1!', 'expected npm:pkg@range'],
    ['mcp', 'a', 'pypi:pkg@1 && x', 'expected pypi:pkg@range'],
  ] as const)('rejects %s.%s = %j', (kind, name, raw, message) => {
    expect(() => parseSourceSpec(kind, name, raw)).toThrow(message);
  });
});

describe('parseDeclaredSources', () => {
  it('collects valid sources and reports every error', () => {
    const { sources, errors } = parseDeclaredSources({
      name: 'x',
      skills: { good: 'local', bad: 'zzz:1' },
      mcp: { m: 'npm:pkg@1' },
    });
    expect(sources.map((s) => `${s.kind}.${s.name}`)).toEqual(['skills.good', 'mcp.m']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('skills.bad');
  });

  it('rejects a non-object section and ignores an absent manifest', () => {
    expect(parseDeclaredSources({ skills: ['a'] } as any).errors[0]).toContain('skills: expected an object');
    expect(parseDeclaredSources(null)).toEqual({ sources: [], errors: [] });
  });
});

describe('setDeclaredSource', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-decl-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('keeps other keys and refuses to overwrite a corrupt manifest', () => {
    fs.writeFileSync(path.join(dir, 'agenthub.json'), JSON.stringify({ name: 'n', skills: { a: 'local' } }));
    setDeclaredSource(dir, 'skills', 'b', 'github:o/r#s');
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'agenthub.json'), 'utf-8'));
    expect(data).toEqual({ name: 'n', skills: { a: 'local', b: 'github:o/r#s' } });

    fs.writeFileSync(path.join(dir, 'agenthub.json'), '{oops');
    expect(() => setDeclaredSource(dir, 'mcp', 'c', 'local')).toThrow('Refusing');
    expect(fs.readFileSync(path.join(dir, 'agenthub.json'), 'utf-8')).toBe('{oops');
  });
});

describe('lockfile', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-lock-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('round-trips, sorts keys and skips identical writes', () => {
    expect(loadLock(dir)).toEqual(emptyLock());
    const lock = emptyLock();
    lock.skills.b = { source: 'github:o/r', commit: 'b'.repeat(40) };
    lock.skills.a = { source: 'npm:p@1', version: '1.0.0' };
    expect(saveLock(dir, lock)).toBe(true);
    expect(saveLock(dir, lock)).toBe(false);
    expect(Object.keys(loadLock(dir).skills)).toEqual(['a', 'b']);
    expect(fs.readFileSync(path.join(dir, 'agenthub.lock.json'), 'utf-8')).toBe(serializeLock(lock));
  });

  it('treats a corrupt lockfile as empty', () => {
    fs.writeFileSync(path.join(dir, 'agenthub.lock.json'), 'nope');
    expect(loadLock(dir)).toEqual(emptyLock());
  });
});

describe('resolvePin', () => {
  const sha = 'a'.repeat(40);
  const tagSha = 'c'.repeat(40);

  afterEach(() => vi.restoreAllMocks());

  it('resolves a github HEAD and a tag through git ls-remote', async () => {
    const spawn = vi.spyOn(runtime, 'spawn').mockReturnValue(ok(`${sha}\tHEAD\n`));
    const head = await resolvePin(parseSourceSpec('skills', 'a', 'github:o/r'));
    expect(head).toEqual({ source: 'github:o/r', commit: sha });
    expect(spawn).toHaveBeenCalledWith('git', ['ls-remote', '--', 'https://github.com/o/r.git', 'HEAD'], undefined);

    spawn.mockReturnValue(ok(`${sha}\trefs/tags/v1\n${tagSha}\trefs/tags/v1^{}\n`));
    const tag = await resolvePin(parseSourceSpec('skills', 'a', { source: 'github:o/r', ref: 'v1' }));
    expect(tag.commit).toBe(tagSha);
  });

  it('uses a full commit ref without network', async () => {
    const spawn = vi.spyOn(runtime, 'spawn');
    const pin = await resolvePin(parseSourceSpec('skills', 'a', { source: 'github:o/r', ref: sha }));
    expect(pin.commit).toBe(sha);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('fails clearly when git is missing or the ref is unknown', async () => {
    const spawn = vi.spyOn(runtime, 'spawn');
    spawn.mockReturnValue({ status: -1, stdout: '', stderr: '', error: Object.assign(new Error('x'), { code: 'ENOENT' }) });
    await expect(resolvePin(parseSourceSpec('skills', 'a', 'github:o/r'))).rejects.toThrow("'git' is not installed");
    spawn.mockReturnValue(ok(''));
    await expect(resolvePin(parseSourceSpec('skills', 'a', { source: 'github:o/r', ref: 'nope' }))).rejects.toThrow('could not resolve');
  });

  it('resolves npm versions, taking the highest match of a range', async () => {
    const spawn = vi.spyOn(runtime, 'spawn').mockReturnValue(ok('["1.2.0","1.2.5"]\n'));
    const pin = await resolvePin(parseSourceSpec('mcp', 'a', 'npm:pkg@^1.2'));
    expect(pin).toEqual({ source: 'npm:pkg@^1.2', version: '1.2.5' });
    expect(spawn).toHaveBeenCalledWith('npm', ['view', 'pkg@^1.2', 'version', '--json'], undefined);

    spawn.mockReturnValue(ok('"2.0.1"\n'));
    expect((await resolvePin(parseSourceSpec('mcp', 'a', 'npm:pkg'))).version).toBe('2.0.1');
  });

  it('resolves pypi versions from the JSON API', async () => {
    const fetchJson = vi.spyOn(runtime, 'fetchJson').mockResolvedValue({
      info: { version: '2.1.0' },
      releases: { '1.0.0': [], '1.5.0': [], '2.0.0': [], '2.1.0': [] },
    });
    expect((await resolvePin(parseSourceSpec('mcp', 'a', 'pypi:pkg'))).version).toBe('2.1.0');
    expect((await resolvePin(parseSourceSpec('mcp', 'a', 'pypi:pkg@1.0.0'))).version).toBe('1.0.0');
    expect((await resolvePin(parseSourceSpec('mcp', 'a', 'pypi:pkg@>=1.0,<2.0'))).version).toBe('1.5.0');
    await expect(resolvePin(parseSourceSpec('mcp', 'a', 'pypi:pkg@>=9'))).rejects.toThrow('no PyPI release');
    expect(fetchJson).toHaveBeenCalledWith('https://pypi.org/pypi/pkg/json');
  });
});

describe('hostile and stale lock data', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-lockbad-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('drops entries with a malformed commit or version and names them', () => {
    fs.writeFileSync(
      path.join(dir, 'agenthub.lock.json'),
      JSON.stringify({
        version: 1,
        skills: {
          ok: { source: 'github:o/r', commit: 'a'.repeat(40) },
          evil: { source: 'github:o/r', commit: '--upload-pack=touch /tmp/x' },
          short: { source: 'github:o/r', commit: 'abc123' },
        },
        mcp: {
          n: { source: 'npm:p', version: '1.0.0; rm -rf ~' },
          g: { source: 'npm:p', version: '-rf' },
          fine: { source: 'npm:p', version: '2.0.0-beta.1' },
        },
      })
    );
    const { lock, invalid } = loadLockChecked(dir);
    expect(Object.keys(lock.skills)).toEqual(['ok']);
    expect(Object.keys(lock.mcp)).toEqual(['fine']);
    expect(Object.keys(invalid).sort()).toEqual(['mcp.g', 'mcp.n', 'skills.evil', 'skills.short']);
    expect(invalid['skills.evil']).toContain('invalid commit');
    expect(invalid['mcp.n']).toContain('invalid version');
  });

  it('rejects an unusable pin returned by npm', async () => {
    vi.spyOn(runtime, 'spawn').mockReturnValue(ok('"1.0.0; touch x"'));
    await expect(resolvePin(parseSourceSpec('mcp', 'a', 'npm:pkg'))).rejects.toThrow('could not resolve npm version');
    vi.restoreAllMocks();
  });
});

describe('npm resolution details', () => {
  afterEach(() => vi.restoreAllMocks());

  it('passes the range as a single argv entry and picks the highest version, not the last', async () => {
    const spawn = vi.spyOn(runtime, 'spawn').mockReturnValue(ok('["1.10.0","1.2.0","1.9.9","1.10.0-rc.1"]'));
    const pin = await resolvePin(parseSourceSpec('mcp', 'a', 'npm:pkg@^1'));
    expect(pin.version).toBe('1.10.0');
    expect(spawn.mock.calls[0]).toEqual(['npm', ['view', 'pkg@^1', 'version', '--json'], undefined]);
  });

  it('orders prereleases below their release', () => {
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0);
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
  });
});
