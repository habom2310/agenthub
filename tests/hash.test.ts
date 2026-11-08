import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GENERATED_MARK, hashEntries, hashFolder, hashSkill } from '../src/core/hash.js';

describe('hashFolder', () => {
  let tmp: string;
  const write = (root: string, rel: string, content: string | Buffer) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-hash-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('is a SHA-256 hex digest', () => {
    write(tmp, 'a.txt', 'x');
    expect(hashFolder(tmp)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives the same hash for the same content created in another order, with other mtimes and modes', () => {
    const a = path.join(tmp, 'a');
    const b = path.join(tmp, 'b');
    for (const rel of ['z.md', 'dir/b.md', 'dir/a.md', 'SKILL.md']) write(a, rel, `content of ${rel}`);
    for (const rel of ['SKILL.md', 'dir/a.md', 'dir/b.md', 'z.md']) write(b, rel, `content of ${rel}`);
    const old = new Date('2001-01-01T00:00:00Z');
    fs.utimesSync(path.join(b, 'z.md'), old, old);
    if (process.platform !== 'win32') fs.chmodSync(path.join(b, 'SKILL.md'), 0o755);
    expect(hashFolder(a)).toBe(hashFolder(b));
  });

  it('changes when a file changes, is renamed or is added', () => {
    write(tmp, 'SKILL.md', 'one');
    const base = hashFolder(tmp);
    write(tmp, 'SKILL.md', 'two');
    const edited = hashFolder(tmp);
    expect(edited).not.toBe(base);
    fs.renameSync(path.join(tmp, 'SKILL.md'), path.join(tmp, 'OTHER.md'));
    expect(hashFolder(tmp)).not.toBe(edited);
    write(tmp, 'extra.md', '');
    expect(hashFolder(tmp)).not.toBe(edited);
  });

  it('does not confuse where one file ends and the next starts', () => {
    const a = path.join(tmp, 'a');
    const b = path.join(tmp, 'b');
    write(a, 'a', 'bc');
    write(a, 'd', 'e');
    write(b, 'a', 'b');
    write(b, 'cd', 'e');
    expect(hashFolder(a)).not.toBe(hashFolder(b));
  });

  it('skips .git and node_modules at any depth', () => {
    write(tmp, 'SKILL.md', 'x');
    const base = hashFolder(tmp);
    write(tmp, '.git/HEAD', 'ref');
    write(tmp, 'node_modules/p/index.js', 'm');
    write(tmp, 'sub/node_modules/q.js', 'm');
    write(tmp, 'sub/.git/config', 'c');
    expect(hashFolder(tmp)).toBe(base);
  });

  it('skips .git and node_modules only as directories: a file with that name counts', () => {
    write(tmp, 'SKILL.md', 'x');
    const base = hashFolder(tmp);
    write(tmp, 'sub/.git', 'gitdir: ../elsewhere');
    expect(hashFolder(tmp)).not.toBe(base);
    const other = path.join(tmp, 'o');
    write(other, 'node_modules', 'a file');
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty);
    expect(hashFolder(other)).not.toBe(hashFolder(empty));
  });

  it('hashes a symlink by its target, not by what it points at', () => {
    const a = path.join(tmp, 'a');
    const b = path.join(tmp, 'b');
    write(a, 'SKILL.md', 'x');
    write(b, 'SKILL.md', 'x');
    write(tmp, 'secret-1', 'one');
    write(tmp, 'secret-2', 'two');
    try {
      fs.symlinkSync('../secret-1', path.join(a, 'link'));
      fs.symlinkSync('../secret-2', path.join(b, 'link'));
    } catch {
      return; // no symlink permission here
    }
    const plain = path.join(tmp, 'c');
    write(plain, 'SKILL.md', 'x');
    const withLink = hashFolder(a);
    expect(withLink).not.toBe(hashFolder(plain));
    expect(withLink).not.toBe(hashFolder(b));
    fs.writeFileSync(path.join(tmp, 'secret-1'), 'changed');
    expect(hashFolder(a)).toBe(withLink);
  });

  it('normalises path names to NFC', () => {
    const a = path.join(tmp, 'a');
    const b = path.join(tmp, 'b');
    write(a, 'café.md', 'x');
    write(b, 'café.md', 'x');
    // a file system may keep either form; the hash must not depend on it
    expect(hashEntries(a, ['café.md'])).toBe(hashEntries(b, ['café.md']));
  });

  it('hashSkill leaves out only an agents/openai.yaml that agenthub generated', () => {
    write(tmp, 'SKILL.md', 'x');
    const base = hashSkill(tmp);
    write(tmp, 'agents/openai.yaml', `${GENERATED_MARK}\ninterface:\n  display_name: X\n`);
    expect(hashSkill(tmp)).toBe(base);
    write(tmp, 'agents/openai.yaml', 'interface:\n  display_name: X\n  short_description: s\n  default_prompt: Use x skill for this task.\n');
    expect(hashSkill(tmp)).toBe(base); // what earlier versions generated
    write(tmp, 'agents/openai.yaml', 'interface:\n  display_name: Mine, shipped by the skill\n');
    expect(hashSkill(tmp)).not.toBe(base);
    write(tmp, 'agents/openai.yaml', `${GENERATED_MARK}\ninterface: {}\n`);
    write(tmp, 'agents/other.yaml', 'x');
    expect(hashSkill(tmp)).not.toBe(base);
  });

  it('is line-ending independent: CRLF counts as LF, other bytes as they are', () => {
    const a = path.join(tmp, 'a');
    const b = path.join(tmp, 'b');
    const c = path.join(tmp, 'c');
    write(a, 'SKILL.md', 'one\ntwo\n');
    write(b, 'SKILL.md', 'one\r\ntwo\r\n');
    write(c, 'SKILL.md', 'one\rtwo\n');
    expect(hashFolder(a)).toBe(hashFolder(b));
    expect(hashFolder(c)).not.toBe(hashFolder(a));
  });
});
