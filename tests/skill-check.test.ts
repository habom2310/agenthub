import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkSkillDir, findDuplicateSkills, parseSkillFrontmatter, relativeLinks, skillResolves } from '../src/core/skill-check.js';
import { createJunction, ensureDir, safeWriteFile } from '../src/utils/fs.js';

describe('skill checks', () => {
  let tmp: string;
  const md = (name: string | null, description: string | null, body = '# Skill\n') =>
    `---\n${name !== null ? `name: ${name}\n` : ''}${description !== null ? `description: ${description}\n` : ''}---\n${body}`;
  const make = (folder: string, content: string) => {
    const dir = path.join(tmp, folder);
    safeWriteFile(path.join(dir, 'SKILL.md'), content);
    return dir;
  };
  const messages = (dir: string, folder: string) => checkSkillDir(dir, folder).map((i) => `${i.level}: ${i.message}`);

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-skillcheck-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('accepts a valid skill', () => {
    expect(messages(make('good-skill', md('good-skill', 'Does a thing.')), 'good-skill')).toEqual([]);
  });

  it('fails when SKILL.md is missing, has no frontmatter, or has invalid YAML', () => {
    ensureDir(path.join(tmp, 'empty'));
    expect(messages(path.join(tmp, 'empty'), 'empty')).toEqual(['FAIL: SKILL.md is missing or unreadable']);
    expect(messages(make('plain', '# just text'), 'plain')[0]).toContain('FAIL: no frontmatter');
    expect(messages(make('badyaml', '---\nname: [unclosed\n---\n'), 'badyaml')[0]).toContain('not valid YAML');
  });

  it('checks name presence, charset and folder match, and description presence and length', () => {
    expect(messages(make('a', md(null, 'd')), 'a')).toContain('FAIL: frontmatter has no name');
    expect(messages(make('b', md('Bad Name', 'd')), 'b').join('\n')).toContain('FAIL: name "Bad Name" must be letters');
    expect(messages(make('c', md('other', 'd')), 'c')).toContain('WARN: name "other" does not match the folder name "c"');
    expect(messages(make('d', md('d', null)), 'd')).toContain('FAIL: frontmatter has no description');
    expect(messages(make('e', md('e', 'x'.repeat(1025))), 'e')).toContain('FAIL: description is 1025 characters (max 1024)');
    expect(messages(make('f', md('f', 'x'.repeat(1024))), 'f')).toEqual([]);
  });

  it('warns about relative links that point nowhere, ignoring urls, anchors and code fences', () => {
    const body = '[ok](refs/a.md) [url](https://x.io/a.md) [anchor](#top) [gone](refs/missing.md#sec)\n```\n[code](nope.md)\n```\n![img](assets/none.png)\n';
    const dir = make('linky', md('linky', 'd', body));
    safeWriteFile(path.join(dir, 'refs', 'a.md'), 'x');
    expect(relativeLinks(body)).toEqual(['refs/a.md', 'refs/missing.md']);
    expect(messages(dir, 'linky')).toEqual(['WARN: SKILL.md links to missing file(s): refs/missing.md']);
  });

  it.skipIf(process.platform === 'win32')('warns about scripts that are not executable', () => {
    const dir = make('scr', md('scr', 'd'));
    safeWriteFile(path.join(dir, 'scripts', 'run.sh'), '#!/bin/sh\n');
    safeWriteFile(path.join(dir, 'scripts', 'ok.sh'), '#!/bin/sh\n');
    fs.chmodSync(path.join(dir, 'scripts', 'ok.sh'), 0o755);
    expect(messages(dir, 'scr')).toEqual(['WARN: not executable: scripts/run.sh']);
  });

  it('warns, not fails, on a name Claude loads but other assistants may not (underscores)', () => {
    const out = messages(make('summary_and_handover', md('summary_and_handover', 'd')), 'summary_and_handover');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^WARN: name "summary_and_handover" loads in Claude Code but is not portable to some assistants/);
  });

  it.skipIf(process.platform === 'win32')('reports only #! files without the executable bit, not data files or python x.py scripts', () => {
    const dir = make('mix', md('mix', 'd'));
    safeWriteFile(path.join(dir, 'scripts', 'VERSION'), '1.0\n');
    safeWriteFile(path.join(dir, 'scripts', 'data', 'command-metadata.json'), '{}');
    safeWriteFile(path.join(dir, 'scripts', 'lint.py'), 'print(1)\n');
    safeWriteFile(path.join(dir, 'scripts', 'run.sh'), '#!/bin/sh\n');
    safeWriteFile(path.join(dir, 'scripts', 'empty'), '');
    expect(messages(dir, 'mix')).toEqual(['WARN: not executable: scripts/run.sh']);
  });

  it('parses frontmatter', () => {
    expect(parseSkillFrontmatter('---\nname: x\n---\nbody').data).toEqual({ name: 'x' });
  });

  it('finds names loaded twice, telling a real clash from one folder reached through two roots', () => {
    const hub = path.join(tmp, 'hub');
    make('hub/s1', md('s1', 'd'));
    createJunction(hub, path.join(tmp, 'rootA'));
    createJunction(hub, path.join(tmp, 'rootB'));
    safeWriteFile(path.join(tmp, 'rootC', 's1', 'SKILL.md'), md('s1', 'other copy'));

    const same = findDuplicateSkills([path.join(tmp, 'rootA'), path.join(tmp, 'rootB')]);
    expect(same).toEqual([expect.objectContaining({ name: 's1', conflicting: false })]);
    const clash = findDuplicateSkills([path.join(tmp, 'rootA'), path.join(tmp, 'rootC')]);
    expect(clash).toEqual([expect.objectContaining({ name: 's1', conflicting: true })]);
    expect(findDuplicateSkills([path.join(tmp, 'rootA')])).toEqual([]);
  });

  it('checks that a skill resolves through a linked folder', () => {
    make('hub/s1', md('s1', 'd'));
    createJunction(path.join(tmp, 'hub'), path.join(tmp, 'linked'));
    expect(skillResolves(path.join(tmp, 'linked'), 's1').ok).toBe(true);
    expect(skillResolves(path.join(tmp, 'linked'), 'nope').ok).toBe(false);
    fs.rmSync(path.join(tmp, 'hub'), { recursive: true });
    expect(skillResolves(path.join(tmp, 'linked'), 's1').ok).toBe(false);
  });
});
