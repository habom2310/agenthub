import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverSkills, findSkills, selectSkills } from '../src/core/skill-discovery.js';

describe('skill discovery', () => {
  let tmp: string;
  const skill = (rel: string, body = '# s') => {
    const file = path.join(tmp, rel, 'SKILL.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };
  const json = (rel: string, data: unknown) => {
    const file = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  };
  const rels = () => discoverSkills(tmp).map((s) => s.rel);

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-disc-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('finds skills in every standard folder', () => {
    skill('skills/a');
    skill('skills/.curated/b');
    skill('skills/.experimental/c');
    skill('.agents/skills/d');
    skill('.claude/skills/e');
    expect(rels()).toEqual(['skills/a', 'skills/.curated/b', 'skills/.experimental/c', '.agents/skills/d', '.claude/skills/e']);
  });

  it('a root SKILL.md is the skill and shadows everything below it', () => {
    skill('', '---\nname: root-skill\ndescription: The root\n---\n');
    skill('skills/a');
    const found = discoverSkills(tmp);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: 'root-skill', rel: '', description: 'The root' });
  });

  it('a root SKILL.md without a usable name falls back to the folder name', () => {
    skill('', '---\nname: bad name\n---\n');
    expect(discoverSkills(tmp)[0].name).toBe(path.basename(fs.realpathSync(tmp)));
  });

  it('walks up to three levels (flat and two category levels), not four', () => {
    skill('skills/l1');
    skill('skills/cat/l2');
    skill('skills/cat/sub/l3');
    skill('skills/cat/sub/deep/l4');
    expect(rels()).toEqual(['skills/cat/l2', 'skills/cat/sub/l3', 'skills/l1']);
  });

  it('a shallower SKILL.md shadows deeper ones', () => {
    skill('skills/outer');
    skill('skills/outer/inner');
    expect(rels()).toEqual(['skills/outer']);
  });

  it('the first skill with a name wins across folders', () => {
    skill('skills/dup', 'first');
    skill('.claude/skills/dup', 'second');
    const found = discoverSkills(tmp);
    expect(found.map((s) => s.rel)).toEqual(['skills/dup']);
  });

  it('skips node_modules, .git and hidden folders inside a search folder', () => {
    skill('skills/node_modules/x');
    skill('skills/.git/x');
    skill('skills/.hidden/x');
    skill('skills/ok');
    expect(rels()).toEqual(['skills/ok']);
  });

  it('does not follow a symlinked search folder or skill folder out of the repo', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-disc-out-'));
    try {
      fs.mkdirSync(path.join(outside, 'evil'), { recursive: true });
      fs.writeFileSync(path.join(outside, 'evil', 'SKILL.md'), '# evil');
      fs.mkdirSync(path.join(tmp, 'skills'));
      try {
        fs.symlinkSync(outside, path.join(tmp, '.claude'), 'junction');
        fs.symlinkSync(path.join(outside, 'evil'), path.join(tmp, 'skills', 'evil'), 'junction');
      } catch {
        return; // no symlink permission here
      }
      expect(rels()).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('a SKILL.md that is a symlink does not count', () => {
    fs.mkdirSync(path.join(tmp, 'skills', 'linked'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'real.md'), '# real');
    try {
      fs.symlinkSync(path.join(tmp, 'real.md'), path.join(tmp, 'skills', 'linked', 'SKILL.md'));
    } catch {
      return; // no symlink permission here
    }
    expect(rels()).toEqual([]);
    expect(findSkills(tmp).warnings).toEqual(['skipped skills/linked: no SKILL.md']);
  });

  it('warns about folders without a SKILL.md once, at their top, and about duplicate names', () => {
    skill('skills/ok');
    fs.mkdirSync(path.join(tmp, 'skills', 'draft', 'deeper'), { recursive: true });
    skill('skills/cat/inner');
    fs.mkdirSync(path.join(tmp, 'skills', 'cat', 'bare'));
    skill('.claude/skills/ok');
    const { skills, warnings } = findSkills(tmp);
    expect(skills.map((s) => s.rel)).toEqual(['skills/cat/inner', 'skills/ok']);
    expect(warnings.sort()).toEqual([
      'duplicate skill "ok": using skills/ok, ignoring .claude/skills/ok',
      'skipped skills/cat/bare: no SKILL.md',
      'skipped skills/draft: no SKILL.md',
    ]);
  });

  it('a root SKILL.md with no usable name takes the given root name', () => {
    skill('', '# unnamed');
    expect(findSkills(tmp, { rootName: 'owner-repo' }).skills[0].name).toBe('owner-repo');
  });

  describe('Claude plugin manifests', () => {
    it('reads the skills array of plugin.json: a skill folder or a folder of skills', () => {
      skill('tools/one');
      skill('tools/many/a');
      skill('tools/many/b');
      json('.claude-plugin/plugin.json', { skills: ['./tools/one', './tools/many'] });
      expect(rels()).toEqual(['tools/one', 'tools/many/a', 'tools/many/b']);
    });

    it('reads marketplace.json: top-level skills and per-plugin skills relative to the plugin source', () => {
      skill('top/t');
      skill('plugins/p/skills/x');
      json('.claude-plugin/marketplace.json', {
        skills: ['./top'],
        plugins: [{ name: 'p', source: './plugins/p', skills: ['./skills'] }, { name: 'q', skills: ['./nope'] }],
      });
      expect(rels().sort()).toEqual(['plugins/p/skills/x', 'top/t']);
    });

    it('rejects paths that do not start with ./, climb out of the repo or are absolute', () => {
      skill('inside/ok');
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-disc-out-'));
      fs.mkdirSync(path.join(outside, 'evil'));
      fs.writeFileSync(path.join(outside, 'evil', 'SKILL.md'), '# evil');
      try {
        json('.claude-plugin/plugin.json', {
          skills: ['inside', '../evil', './../evil', './a/../../evil', outside, path.join(outside, 'evil'), '.\\x', './inside/../../evil', 42, null],
        });
        expect(rels()).toEqual([]);
        json('.claude-plugin/plugin.json', { skills: ['./inside'] });
        expect(rels()).toEqual(['inside/ok']);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it('rejects a manifest path that is a symlink leaving the repo', () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-disc-out-'));
      try {
        fs.mkdirSync(path.join(outside, 'evil'));
        fs.writeFileSync(path.join(outside, 'evil', 'SKILL.md'), '# evil');
        try {
          fs.symlinkSync(outside, path.join(tmp, 'link'), 'junction');
        } catch {
          return;
        }
        json('.claude-plugin/plugin.json', { skills: ['./link', './link/evil'] });
        expect(rels()).toEqual([]);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it('ignores malformed manifests', () => {
      fs.mkdirSync(path.join(tmp, '.claude-plugin'));
      fs.writeFileSync(path.join(tmp, '.claude-plugin', 'plugin.json'), '{not json');
      fs.writeFileSync(path.join(tmp, '.claude-plugin', 'marketplace.json'), '[]');
      skill('skills/a');
      expect(rels()).toEqual(['skills/a']);
    });
  });

  describe('selectSkills', () => {
    it('selects by name, and lists what exists for an unknown name', () => {
      skill('skills/a');
      skill('skills/b');
      const found = discoverSkills(tmp);
      expect(selectSkills(found, []).map((s) => s.name)).toEqual(['a', 'b']);
      expect(selectSkills(found, ['b']).map((s) => s.name)).toEqual(['b']);
      expect(() => selectSkills(found, ['zz'])).toThrow('Skill "zz" not found. Available: a, b');
    });
  });
});
