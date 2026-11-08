import { describe, expect, it } from 'vitest';
import { parseDeclaredSources, parseSourceSpec } from '../src/core/sources.js';
import { parseGitUrl, parseRemoteTarget, parseShorthand } from '../src/core/source-url.js';

describe('shorthand targets', () => {
  it('parses owner/repo and owner/repo@skill', () => {
    expect(parseShorthand('o/r')).toMatchObject({ source: 'github:o/r', cloneUrl: 'https://github.com/o/r.git' });
    expect(parseShorthand('o/r')?.skill).toBeUndefined();
    expect(parseShorthand('o/r@my-skill')).toMatchObject({ source: 'github:o/r', skill: 'my-skill' });
  });

  it('has no # form: a ref is given with --ref', () => {
    expect(parseShorthand('o/r#v1')).toBeNull();
    expect(() => parseRemoteTarget('o/r#v1')).toThrow(/use owner\/repo\[@skill\] and --ref/);
    expect(() => parseRemoteTarget('https://git.example.com/p.git#v1')).toThrow(/use --ref/);
  });

  it('is not a shorthand for other shapes', () => {
    expect(parseShorthand('just-a-name')).toBeNull();
    expect(parseShorthand('a/b/c')).toBeNull();
    expect(parseShorthand('../x')).toBeNull();
    expect(parseShorthand('./x')).toBeNull();
    expect(parseShorthand('o/r@')).toBeNull();
  });

});

describe('file: sources and tree refs with a slash', () => {
  it('file: URLs are refused as add targets, with a hint', () => {
    expect(() => parseRemoteTarget('file:///tmp/r')).toThrow(/use the local path/);
  });

  it('file: and local-path sources are refused in agenthub.json declarations', () => {
    for (const spec of ['file:///tmp/r', 'git:file:///tmp/r', 'git:/tmp/r', 'git:../r', 'git:./r', 'git:C:\\r', 'git:r']) {
      expect(() => parseSourceSpec('skills', 's', spec), spec).toThrow(/s: .*(file: URLs are not accepted|not a remote git URL)/);
    }
    expect(() => parseSourceSpec('skills', 's', { source: 'git:file:///tmp/r', ref: 'main' })).toThrow(/not a remote git URL/);
    expect(parseSourceSpec('skills', 's', 'git:git@host.example:team/r.git').spec).toBe('git:git@host.example:team/r.git');
    expect(parseSourceSpec('skills', 's', 'git:ssh://git@host.example/r.git').spec).toBe('git:ssh://git@host.example/r.git');
  });

  it('a tree URL ref that decodes to a slash is an error that points to --ref', () => {
    expect(() => parseGitUrl('https://github.com/o/r/tree/feature%2Fx/skills')).toThrow('use the repo URL with --ref');
    expect(parseGitUrl('https://github.com/o/r/tree/main/a').fromTree).toBe(true);
  });
});

describe('GitHub URLs', () => {
  it('parses a plain repo URL, with .git and a trailing slash', () => {
    for (const u of ['https://github.com/o/r', 'https://github.com/o/r.git', 'https://github.com/o/r/']) {
      expect(parseGitUrl(u)).toMatchObject({ source: 'github:o/r' });
    }
  });

  it('parses a tree URL into ref and subpath', () => {
    expect(parseGitUrl('https://github.com/o/r/tree/main/skills/x')).toMatchObject({
      source: 'github:o/r',
      cloneUrl: 'https://github.com/o/r.git',
      ref: 'main',
      subpath: 'skills/x',
    });
    expect(parseGitUrl('https://github.com/o/r/tree/v1.0')).toMatchObject({ ref: 'v1.0' });
  });

  it('drops the query string and does not record it', () => {
    const r = parseGitUrl('https://github.com/o/r/tree/main/a?plain=1');
    expect(r.subpath).toBe('a');
    expect(JSON.stringify(r)).not.toContain('plain');
  });

  it('keeps credentials for the clone only, and does not warn for GitHub', () => {
    const r = parseGitUrl('https://user:tok@github.com/o/r');
    expect(r.source).toBe('github:o/r');
    expect(r.source).not.toContain('tok');
    expect(r.cloneUrl).toContain('tok@');
  });

  it('rejects unsupported GitHub URLs and traversal', () => {
    expect(() => parseGitUrl('https://github.com/o')).toThrow(/Unsupported GitHub URL/);
    expect(() => parseGitUrl('https://github.com/o/r/issues/1')).toThrow(/Unsupported GitHub URL/);
    expect(() => parseGitUrl('https://github.com/o/r/tree')).toThrow(/Unsupported GitHub URL/);
    expect(() => parseGitUrl('https://github.com/o/r/tree/main/a%5Cb')).toThrow(/Invalid subpath/);
    expect(() => parseGitUrl('https://github.com/o/r/tree/main/a%2F..%2Fb')).toThrow(/Invalid subpath/);
    // the URL parser itself collapses dot segments, so they never reach the subpath
    expect(parseGitUrl('https://github.com/o/r/tree/main/a/../b').subpath).toBe('b');
    expect(parseGitUrl('https://github.com/o/r/tree/main/%2E%2E/x').ref).toBe('x');
    expect(() => parseGitUrl('https://github.com/o/r/tree/-x/a')).toThrow(/Invalid ref/);
    expect(() => parseGitUrl('https://github.com/o/r/tree/%zz/a')).toThrow(/Invalid path/);
  });
});

describe('GitLab URLs', () => {
  it('parses a tree URL with subgroups', () => {
    expect(parseGitUrl('https://gitlab.com/g/sub/r/-/tree/dev/skills/x')).toMatchObject({
      source: 'git:https://gitlab.com/g/sub/r.git',
      cloneUrl: 'https://gitlab.com/g/sub/r.git',
      ref: 'dev',
      subpath: 'skills/x',
    });
  });

  it('records a plain repo URL as git:', () => {
    expect(parseGitUrl('https://gitlab.com/g/r')).toMatchObject({ source: 'git:https://gitlab.com/g/r' });
    expect(parseGitUrl('https://gitlab.com/g/r.git/')).toMatchObject({ source: 'git:https://gitlab.com/g/r.git' });
  });

  it('strips credentials and query from what is recorded, with a warning', () => {
    const r = parseGitUrl('https://oauth2:secret@gitlab.com/g/r/-/tree/main/a?ref_type=heads');
    expect(r.source).toBe('git:https://gitlab.com/g/r.git');
    expect(r.warnings.join(' ')).toContain('Credentials');
    expect(JSON.stringify([r.source, r.ref, r.subpath])).not.toMatch(/secret|ref_type/);
  });

  it('rejects a tree URL without a ref and a bad ref', () => {
    expect(() => parseGitUrl('https://gitlab.com/g/r/-/tree')).toThrow(/Unsupported GitLab URL/);
    expect(() => parseGitUrl('https://gitlab.com/g/r/-/tree/-x')).toThrow(/Invalid ref/);
  });
});

describe('Azure Repos URLs', () => {
  it('parses repo, path and branch, and drops the query', () => {
    const r = parseGitUrl('https://dev.azure.com/org/proj/_git/repo?path=/skills/x&version=GBmain');
    expect(r).toMatchObject({
      source: 'git:https://dev.azure.com/org/proj/_git/repo',
      cloneUrl: 'https://dev.azure.com/org/proj/_git/repo',
      ref: 'main',
      subpath: 'skills/x',
    });
    expect(r.source).not.toContain('?');
  });

  it('accepts tags and drops org@ user info', () => {
    const r = parseGitUrl('https://org@dev.azure.com/org/proj/_git/repo?version=GTv1');
    expect(r.ref).toBe('v1');
    expect(r.source).toBe('git:https://dev.azure.com/org/proj/_git/repo');
  });

  it('rejects other shapes, bad versions and traversal', () => {
    expect(() => parseGitUrl('https://dev.azure.com/org/proj')).toThrow(/Unsupported Azure/);
    expect(() => parseGitUrl('https://dev.azure.com/org/proj/_git/repo?version=main')).toThrow(/Unsupported Azure Repos version/);
    expect(() => parseGitUrl('https://dev.azure.com/org/proj/_git/repo?path=/../x')).toThrow(/Invalid subpath/);
  });
});

describe('any git URL', () => {
  it('records https, ssh and scp URLs without credentials or query', () => {
    expect(parseGitUrl('https://git.example.com/team/pack.git').source).toBe('git:https://git.example.com/team/pack.git');
    expect(parseGitUrl('https://bob:s3cret@git.example.com/team/pack.git?x=1')).toMatchObject({
      source: 'git:https://git.example.com/team/pack.git',
    });
    expect(parseGitUrl('ssh://git@git.example.com/team/pack.git').source).toBe('git:ssh://git@git.example.com/team/pack.git');
    expect(parseGitUrl('ssh://git:pw@git.example.com/team/pack.git').source).toBe('git:ssh://git@git.example.com/team/pack.git');
    expect(parseGitUrl('git@git.example.com:team/pack.git').source).toBe('git:git@git.example.com:team/pack.git');
  });

  it('rejects "#", whitespace, control characters and unknown schemes', () => {
    expect(() => parseGitUrl('https://git.example.com/p.git#frag')).toThrow('must not contain "#"');
    expect(() => parseGitUrl('https://git.example.com/p .git')).toThrow(/whitespace/);
    expect(() => parseGitUrl('https://git.example.com/p.git\nrm')).toThrow(/whitespace or control/);
    expect(parseRemoteTarget('ext::sh -c x')).toBeNull();
    expect(() => parseGitUrl('ftp://host/p.git')).toThrow(/Unsupported URL scheme/);
    expect(() => parseGitUrl('git@host:a b')).toThrow(/whitespace/);
    expect(() => parseGitUrl('https://')).toThrow(/Invalid URL/);
  });

  it('redacts credentials in error messages', () => {
    expect(() => parseGitUrl('https://u:pw@host.example.com/p.git#x')).toThrow(expect.objectContaining({ message: expect.not.stringContaining('pw') }));
  });
});

describe('declarations accept the same URL forms', () => {
  it('records a tree URL as github: with #subpath and the ref in the spec', () => {
    const d = parseSourceSpec('skills', 's', 'https://github.com/o/r/tree/main/skills/s');
    expect(d.spec).toBe('github:o/r#skills/s ref=main');
    expect(d.parsed).toMatchObject({ type: 'github', url: 'https://github.com/o/r.git', ref: 'main', subpath: 'skills/s' });
  });

  it('takes the ref from the "ref" field when the URL has none, and rejects a conflict', () => {
    expect(parseSourceSpec('skills', 's', { source: 'https://gitlab.com/g/r', ref: 'dev' }).spec).toBe('git:https://gitlab.com/g/r ref=dev');
    expect(() => parseSourceSpec('skills', 's', { source: 'https://github.com/o/r/tree/main/a', ref: 'dev' })).toThrow(/conflicts/);
  });

  it('uses "#" as the subpath, as for github:', () => {
    expect(parseSourceSpec('skills', 's', 'https://git.example.com/p.git#skills/s').spec).toBe('git:https://git.example.com/p.git#skills/s');
    expect(() => parseSourceSpec('skills', 's', 'https://github.com/o/r/tree/main/a#b')).toThrow(/already has a path/);
  });

  it('never records credentials or queries from a declaration', () => {
    const d = parseSourceSpec('mcp', 'm', 'https://u:pw@git.example.com/p.git?token=1');
    expect(d.spec).toBe('git:https://git.example.com/p.git');
  });

  it('reports a bad URL as an error of that item', () => {
    const { errors } = parseDeclaredSources({ skills: { s: 'https://github.com/o/r/tree/main/a%5Cb' } });
    expect(errors[0]).toMatch(/^skills\.s: Invalid subpath/);
  });
});
