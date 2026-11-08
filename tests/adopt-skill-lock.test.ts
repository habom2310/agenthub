import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAdopt, scanAdoptable, type AdoptItem } from '../src/core/adopt.js';
import { hashSkill } from '../src/core/hash.js';
import { planInstall, runInstall } from '../src/core/installer.js';
import { loadManifest } from '../src/core/manifest.js';
import { loadLock, runtime } from '../src/core/sources.js';
import { ensureDir, safeWriteFile } from '../src/utils/fs.js';

describe('adopt: skills installed with `npx skills` (~/.agents/.skill-lock.json)', () => {
  let tmp: string;
  let home: string;
  let hub: string;
  const skillMd = (name: string) => `---\nname: ${name}\ndescription: d\n---\n`;
  const lockFile = () => path.join(home, '.agents', '.skill-lock.json');
  const entry = (extra: Record<string, unknown>) => ({
    source: 'acme/skills',
    sourceType: 'github',
    sourceUrl: 'https://github.com/acme/skills.git',
    skillFolderHash: 'abc',
    installedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  });
  const writeLock = (skills: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    safeWriteFile(lockFile(), JSON.stringify({ version: 3, skills, ...extra }));
  // the way `npx skills` leaves them: real folders in ~/.agents/skills
  const install = (...names: string[]) => names.forEach((n) => safeWriteFile(path.join(home, '.agents', 'skills', n, 'SKILL.md'), skillMd(n)));
  // the way linking ~/.agents/skills leaves them: in the hub, the originals kept in skills.old
  const migrated = (...names: string[]) =>
    names.forEach((n) => [path.join(hub, 'skills'), path.join(home, '.agents', 'skills.old')].forEach((d) => safeWriteFile(path.join(d, n, 'SKILL.md'), skillMd(n))));
  const find = (items: AdoptItem[], name: string) => items.find((i) => i.kind === 'skills' && i.name === name) as AdoptItem;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-adopt-lock-')));
    home = path.join(tmp, 'home');
    hub = path.join(tmp, 'hub');
    ensureDir(path.join(home, '.claude'));
    ensureDir(path.join(hub, 'skills'));
    safeWriteFile(path.join(hub, 'agenthub.json'), JSON.stringify({ name: 'h' }));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('proposes github:owner/repo#dir, confidently, from a github entry', () => {
    migrated('review');
    writeLock({ review: entry({ skillPath: 'skills/review/SKILL.md' }) });
    const item = find(scanAdoptable(home, hub), 'review');
    expect(item.proposal).toMatchObject({ label: 'github:acme/skills#skills/review', spec: 'github:acme/skills#skills/review', confident: true });
    expect(item.proposal?.note).toContain('installed with npx skills');
    expect(item.proposal?.note).toContain('npx skills update');
    expect(item.proposal?.note).toContain('vendors its own pinned copy');
    expect(item.selfBuilt).toBeUndefined();
  });

  it('carries the ref, and declares the repository root for a SKILL.md at the top', () => {
    migrated('root', 'pinned');
    writeLock({
      root: entry({ skillPath: 'SKILL.md' }),
      pinned: entry({ skillPath: 'a/b/SKILL.md', ref: 'v1.2.0' }),
    });
    const items = scanAdoptable(home, hub);
    expect(find(items, 'root').proposal).toMatchObject({ spec: 'github:acme/skills', confident: true });
    expect(find(items, 'pinned').proposal).toMatchObject({ spec: { source: 'github:acme/skills#a/b', ref: 'v1.2.0' }, confident: true });
  });

  it('proposes git:<url> for a gitlab entry and strips credentials from the URL', () => {
    install('lab', 'secret', 'hosted');
    writeLock({
      lab: entry({ source: 'g/p', sourceType: 'gitlab', sourceUrl: 'https://gitlab.com/g/p.git', skillPath: 'x/SKILL.md' }),
      secret: entry({ source: 'g/p', sourceType: 'git', sourceUrl: 'https://user:hunter2@gitlab.example.com/g/p.git?token=abc#frag', skillPath: 'SKILL.md' }),
      hosted: entry({ source: 'acme/skills', sourceType: 'github', sourceUrl: 'https://ghp_tok:x-oauth-basic@github.com/acme/skills', skillPath: 'h/SKILL.md' }),
    });
    const items = scanAdoptable(home, hub);
    expect(find(items, 'lab').proposal?.spec).toBe('git:https://gitlab.com/g/p.git#x');
    expect(find(items, 'secret').proposal?.spec).toBe('git:https://gitlab.example.com/g/p.git');
    expect(find(items, 'hosted').proposal?.spec).toBe('github:acme/skills#h');
    expect(JSON.stringify(items)).not.toMatch(/hunter2|ghp_tok|token=abc/);
  });

  it('is not confident when the lock names no folder in the repository', () => {
    install('nofolder');
    writeLock({ nofolder: entry({}) });
    expect(find(scanAdoptable(home, hub), 'nofolder').proposal).toMatchObject({ spec: 'github:acme/skills', confident: false });
  });

  it('ignores local, download and well-known entries and names the lock does not have', () => {
    install('l', 'd', 'w', 'unlocked');
    writeLock({
      l: entry({ sourceType: 'local', skillPath: 'l/SKILL.md' }),
      d: entry({ sourceType: 'download', skillPath: 'd/SKILL.md' }),
      w: entry({ sourceType: 'well-known', skillPath: 'w/SKILL.md' }),
    });
    const items = scanAdoptable(home, hub);
    for (const n of ['l', 'd', 'w', 'unlocked']) {
      expect(find(items, n).proposal, n).toBeUndefined();
      expect(find(items, n).selfBuilt, n).toBeDefined();
    }
  });

  it('skips malformed entries and treats the file as untrusted data', () => {
    install('good', 'evilpath', 'evilref', 'evilsource', 'notobj', 'badurl');
    writeLock({
      good: entry({ skillPath: 'g/SKILL.md' }),
      evilpath: entry({ skillPath: '../../etc/SKILL.md' }),
      evilref: entry({ skillPath: 'e/SKILL.md', ref: '--upload-pack=touch /tmp/x' }),
      evilsource: entry({ source: '$(touch /tmp/x)/repo', sourceUrl: 'file:///etc/passwd', skillPath: 's/SKILL.md' }),
      notobj: 'oops',
      badurl: entry({ source: 'x', sourceType: 'git', sourceUrl: 'ext::sh -c touch% /tmp/x', skillPath: 'b/SKILL.md' }),
    });
    const items = scanAdoptable(home, hub);
    expect(find(items, 'good').proposal?.spec).toBe('github:acme/skills#g');
    for (const n of ['evilpath', 'evilref', 'evilsource', 'notobj', 'badurl']) expect(find(items, n).proposal, n).toBeUndefined();
  });

  it.each([
    ['not json', '{ nope'],
    ['an array', '[]'],
    ['a string', '"x"'],
    ['skills as an array', '{"version":3,"skills":[]}'],
    ['no skills', '{"version":3}'],
  ])('survives a lock file that is %s', (_label, text) => {
    install('a');
    safeWriteFile(lockFile(), text);
    const items = scanAdoptable(home, hub);
    expect(find(items, 'a').selfBuilt).toBeDefined();
  });

  it('survives an oversized lock file and a __proto__ key', () => {
    install('a');
    safeWriteFile(lockFile(), `{"version":3,"skills":{"__proto__":{"sourceType":"github","source":"x/y"},"a":${JSON.stringify(entry({ skillPath: 'a/SKILL.md' }))}},"pad":"${'x'.repeat(5 * 1024 * 1024)}"}`);
    expect(find(scanAdoptable(home, hub), 'a').proposal).toBeUndefined();
    safeWriteFile(lockFile(), `{"version":3,"skills":{"__proto__":{"sourceType":"github","source":"x/y"},"a":${JSON.stringify(entry({ skillPath: 'a/SKILL.md' }))}}}`);
    expect(find(scanAdoptable(home, hub), 'a').proposal?.spec).toBe('github:acme/skills#a');
    expect(({} as Record<string, unknown>).sourceType).toBeUndefined();
  });

  it('leaves a skill that is already declared alone', () => {
    install('review');
    writeLock({ review: entry({ skillPath: 'skills/review/SKILL.md' }) });
    safeWriteFile(path.join(hub, 'agenthub.json'), JSON.stringify({ name: 'h', skills: { review: 'local' } }));
    expect(scanAdoptable(home, hub).find((i) => i.name === 'review')).toBeUndefined();
  });

  it('finds it after the folder moved into the hub, and --yes declares it without moving or running anything', async () => {
    // what linking ~/.agents/skills does: the folder now lives in the hub
    safeWriteFile(path.join(hub, 'skills', 'review', 'SKILL.md'), skillMd('review'));
    safeWriteFile(path.join(home, '.agents', 'skills.old', 'review', 'SKILL.md'), skillMd('review'));
    writeLock({ review: entry({ skillPath: 'skills/review/SKILL.md', ref: 'main' }) });
    const report = await runAdopt({ homeDir: home, hubDir: hub, yes: true });
    expect(report.applied.map((a) => a.item)).toContain('skill review');
    expect(loadManifest(hub)?.skills?.review).toEqual({ source: 'github:acme/skills#skills/review', ref: 'main' });
    // the hub copy is kept in backups (agenthub vendors its own pinned copy on install), nothing is executed
    const backups = path.join(hub, 'backups');
    const adopted = fs.readdirSync(backups).filter((d) => d.startsWith('adopt-'));
    expect(adopted).toHaveLength(1);
    expect(fs.existsSync(path.join(backups, adopted[0], 'skills', 'review', 'SKILL.md'))).toBe(true);
  });

  describe('confidence needs the hub copy to be the one npx skills installed', () => {
    const inHub = (text: string) => safeWriteFile(path.join(hub, 'skills', 'review', 'SKILL.md'), text);
    const original = (text: string) => safeWriteFile(path.join(home, '.agents', 'skills.old', 'review', 'SKILL.md'), text);

    it('is confident when the hub folder equals ~/.agents/skills.old/<name>', () => {
      inHub(skillMd('review'));
      original(skillMd('review'));
      writeLock({ review: entry({ skillPath: 'skills/review/SKILL.md' }) });
      const p = find(scanAdoptable(home, hub), 'review').proposal;
      expect(p?.confident).toBe(true);
      expect(p?.note).not.toContain('content differs');
    });

    it('is not confident when the content differs, and says why', () => {
      inHub(skillMd('review') + 'edited after the move\n');
      original(skillMd('review'));
      writeLock({ review: entry({ skillPath: 'skills/review/SKILL.md' }) });
      const p = find(scanAdoptable(home, hub), 'review').proposal;
      expect(p?.spec).toBe('github:acme/skills#skills/review');
      expect(p?.confident).toBe(false);
      expect(p?.note).toContain('a skill named review exists in the npx skills lock but its content differs');
    });

    it('is not confident when there is no copy left to compare with', () => {
      inHub(skillMd('review'));
      writeLock({ review: entry({ skillPath: 'skills/review/SKILL.md' }) });
      const p = find(scanAdoptable(home, hub), 'review').proposal;
      expect(p?.confident).toBe(false);
      expect(p?.note).toContain('no copy from ~/.agents/skills is left to compare it with');
    });

    it('is not confident before the migration: the live ~/.agents/skills/<name> cannot be compared with itself', () => {
      install('review');
      fs.appendFileSync(path.join(home, '.agents', 'skills', 'review', 'SKILL.md'), 'local edit\n');
      writeLock({ review: entry({ skillPath: 'skills/review/SKILL.md' }) });
      const p = find(scanAdoptable(home, hub), 'review').proposal;
      expect(p?.confident).toBe(false);
      expect(p?.note).toContain('local edits to it cannot be detected');
    });

    it('--yes does not declare a differing skill', async () => {
      inHub(skillMd('review') + 'edited\n');
      original(skillMd('review'));
      writeLock({ review: entry({ skillPath: 'skills/review/SKILL.md' }) });
      const report = await runAdopt({ homeDir: home, hubDir: hub, yes: true });
      expect(report.applied).toEqual([]);
      expect(fs.existsSync(path.join(hub, 'skills', 'review', 'SKILL.md'))).toBe(true);
    });
  });

  it('an adopted skill gets a content hash in agenthub.lock.json and verifies under a frozen lock', async () => {
    safeWriteFile(path.join(hub, 'skills', 'review', 'SKILL.md'), skillMd('review'));
    safeWriteFile(path.join(home, '.agents', 'skills.old', 'review', 'SKILL.md'), skillMd('review'));
    writeLock({ review: entry({ skillPath: 'skills/review/SKILL.md' }) });
    expect((await runAdopt({ homeDir: home, hubDir: hub, yes: true })).applied.map((a) => a.item)).toContain('skill review');

    // fake git: the pinned checkout holds the skill
    vi.spyOn(runtime, 'spawn').mockImplementation((cmd, args, cwd) => {
      if (cmd === 'git' && args[0] === 'ls-remote') return { status: 0, stdout: `${'a'.repeat(40)}\tHEAD\n`, stderr: '' };
      if (cmd === 'git' && args[0] === 'checkout') safeWriteFile(path.join(cwd as string, 'skills', 'review', 'SKILL.md'), skillMd('review'));
      return { status: 0, stdout: '', stderr: '' };
    });
    try {
      const result = runInstall(await planInstall(hub));
      expect(result.failed).toEqual([]);
      const pin = loadLock(hub).skills.review;
      expect(pin?.hash).toBe(hashSkill(path.join(hub, 'vendor', 'skills', 'review', 'skills', 'review')));
      const frozen = await planInstall(hub, { frozen: true });
      expect(frozen.errors).toEqual([]);
      expect(frozen.actions).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('dry-run reads the lock and changes nothing', async () => {
    install('review');
    writeLock({ review: entry({ skillPath: 'skills/review/SKILL.md' }) });
    const before = fs.readFileSync(path.join(hub, 'agenthub.json'), 'utf-8');
    const report = await runAdopt({ homeDir: home, hubDir: hub, dryRun: true });
    expect(report.mode).toBe('dry-run');
    expect(report.items.find((i) => i.name === 'review')?.proposal?.spec).toBe('github:acme/skills#skills/review');
    expect(fs.readFileSync(path.join(hub, 'agenthub.json'), 'utf-8')).toBe(before);
    expect(fs.existsSync(lockFile())).toBe(true);
  });
});
