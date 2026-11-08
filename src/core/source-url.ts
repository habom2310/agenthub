/**
 * Parses the ways a git source can be written (shorthand, GitHub/GitLab/Azure Repos
 * URLs, any git URL) into the recorded form: `github:owner/repo` or `git:<url>`,
 * plus a ref and a subpath. Credentials and query strings are never recorded.
 */

export interface RemoteSpec {
  /** "github:owner/repo" or "git:<url>", without credentials */
  source: string;
  /** What to clone: the repository URL, query stripped (credentials kept so git can use them) */
  cloneUrl: string;
  ref?: string;
  subpath?: string;
  /** owner/repo@skill: install only this skill */
  skill?: string;
  /** The ref came from a /tree/<ref>/ URL, where a ref with a slash cannot be told from the path */
  fromTree?: boolean;
  warnings: string[];
}

const URL_LIKE_RE = /^(?:https?|ssh|git|file):\/\/|^git@/i;
const REMOTE_GIT_RE = /^(?:(?:https?|ssh|git):\/\/[^\s/]|[\w.-]+@[\w.-]+:[\w.~/-])/i;
const SCP_RE = /^git@[\w.-]+:[\w.~/-]+$/;
const NAME_PART_RE = /^[\w.-]+$/;
const REF_RE = /^[\w./-]+$/;
const BAD_CHARS_RE = /[\s\x00-\x1f\x7f]/;

/** A git URL a declaration may use: https, ssh, git or scp-style. Never a local path or file: URL. */
export const isRemoteGitUrl = (raw: string): boolean => REMOTE_GIT_RE.test(raw);

export const isUrlTarget = (raw: string): boolean => URL_LIKE_RE.test(raw);

const redact = (raw: string): string => raw.replace(/\/\/[^@/]*@/, '//***@');
const isDots = (s: string): boolean => /^\.+$/.test(s);

export function validRef(ref: string): boolean {
  return REF_RE.test(ref) && !ref.startsWith('-') && !ref.startsWith('/') && !ref.includes('..') && !ref.endsWith('/') && !ref.endsWith('.lock');
}

export function validSubpathText(sub: string): boolean {
  return (
    sub !== '' &&
    !sub.startsWith('/') &&
    !BAD_CHARS_RE.test(sub) &&
    !/[#?\\]/.test(sub) &&
    !sub.split('/').some((s) => s === '..' || s === '.' || s === '')
  );
}

function decode(seg: string, what: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    throw new Error(`Invalid ${what} in URL`);
  }
}

function checkRef(ref: string): string {
  if (!validRef(ref)) throw new Error(`Invalid ref "${ref}" in URL`);
  return ref;
}

export const TREE_REF_HINT = 'branch names with / are ambiguous in tree URLs; use the repo URL with --ref';

/** The ref of a /tree/<ref>/ URL is its first path segment. */
function treeRef(seg: string): string {
  if (seg.includes('/')) throw new Error(TREE_REF_HINT);
  return checkRef(seg);
}

function checkSubpath(sub: string): string {
  if (!validSubpathText(sub)) throw new Error(`Invalid subpath "${sub}" in URL`);
  return sub;
}

/** owner/repo or owner/repo@skill (GitHub). Null if the text is not that shape. */
export function parseShorthand(raw: string): RemoteSpec | null {
  const m = raw.match(/^([\w.-]+)\/([\w.-]+)(?:@([\w.-]+))?$/);
  if (!m) return null;
  const [, owner, repo, skill] = m;
  if (isDots(owner) || isDots(repo)) return null;
  if (skill !== undefined && isDots(skill)) throw new Error(`Invalid skill name "${skill}"`);
  return {
    source: `github:${owner}/${repo}`,
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
    skill,
    warnings: [],
  };
}

/**
 * The URL pointing at another path, without query and fragment. For what is recorded
 * (`record`) credentials go too, except a ssh user name, which is not one.
 */
function rebuild(u: URL, pathname: string, record = false): string {
  const c = new URL(u.toString());
  c.pathname = pathname;
  c.search = '';
  c.hash = '';
  if (record) {
    c.password = '';
    if (c.protocol !== 'ssh:') c.username = '';
  }
  return c.toString();
}

function parseAzure(u: URL, segs: string[], warnings: string[]): RemoteSpec {
  const i = segs.indexOf('_git');
  if (i < 1 || i > 2 || segs.length !== i + 2) {
    throw new Error('Unsupported Azure Repos URL (expected https://dev.azure.com/<org>/<project>/_git/<repo>)');
  }
  const repoPath = '/' + segs.join('/');
  let ref: string | undefined;
  let subpath: string | undefined;
  const version = u.searchParams.get('version');
  if (version) {
    const m = version.match(/^G([BTC])(.+)$/);
    if (!m) throw new Error(`Unsupported Azure Repos version "${version}" (expected GB<branch>, GT<tag> or GC<commit>)`);
    ref = checkRef(m[2]);
  }
  const p = u.searchParams.get('path');
  if (p && p !== '/') subpath = checkSubpath(p.replace(/^\/+|\/+$/g, ''));
  if (u.search) warnings.push('Query string was not recorded (path and version were kept as subpath and ref).');
  return { source: `git:${rebuild(u, repoPath, true)}`, cloneUrl: rebuild(u, repoPath), ref, subpath, warnings };
}

/**
 * Parses a URL target. Throws a user-facing Error for anything invalid or hostile
 * (control characters, "#", unsupported schemes or shapes, bad ref or subpath).
 */
export function parseGitUrl(raw: string): RemoteSpec {
  if (BAD_CHARS_RE.test(raw)) throw new Error('Target URL must not contain whitespace or control characters');
  if (raw.includes('#')) throw new Error(`Target URL must not contain "#": ${redact(raw)} (to pick a branch, tag or commit use --ref <ref>)`);
  const warnings: string[] = [];

  if (raw.startsWith('git@')) {
    if (!SCP_RE.test(raw)) throw new Error(`Invalid git URL: ${raw}`);
    return { source: `git:${raw}`, cloneUrl: raw, warnings };
  }

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${redact(raw)}`);
  }
  if (!['https:', 'http:', 'ssh:', 'git:'].includes(u.protocol)) throw new Error(u.protocol === 'file:' ? 'file: URLs are not accepted: use the local path instead' : `Unsupported URL scheme "${u.protocol}"`);
  const segs = u.pathname.split('/').filter(Boolean).map((s) => decode(s, 'path'));
  const host = u.hostname.toLowerCase();
  const web = u.protocol === 'https:' || u.protocol === 'http:';

  if (web && (u.username || u.password)) {
    warnings.push('Credentials in the URL were not recorded in agenthub.json; git will need its own credentials on other machines.');
  }
  if (u.protocol === 'ssh:' && u.password) {
    warnings.push('Credentials in the URL were not recorded in agenthub.json; git will need its own credentials on other machines.');
  }

  if (web && host === 'github.com') {
    // GitHub has no credentials worth warning about: the recorded form is github:owner/repo
    warnings.length = 0;
    const [owner, repoRaw, kind, refSeg, ...rest] = segs;
    const repo = repoRaw?.replace(/\.git$/, '');
    if (!owner || !repo || !NAME_PART_RE.test(owner) || !NAME_PART_RE.test(repo) || isDots(owner) || isDots(repo)) {
      throw new Error(`Unsupported GitHub URL: ${redact(raw)}`);
    }
    if (u.search) warnings.push('Query string was not recorded.');
    const out: RemoteSpec = {
      source: `github:${owner}/${repo}`,
      cloneUrl: rebuild(u, `/${owner}/${repo}.git`),
      warnings,
    };
    if (kind === undefined) return out;
    if (kind !== 'tree' || !refSeg) throw new Error(`Unsupported GitHub URL (use https://github.com/${owner}/${repo}/tree/<ref>/<path>): ${redact(raw)}`);
    out.ref = treeRef(refSeg);
    out.fromTree = true;
    if (rest.length > 0) out.subpath = checkSubpath(rest.join('/'));
    return out;
  }

  if (web && host === 'dev.azure.com') return parseAzure(u, segs, warnings);

  const marker = segs.indexOf('-');
  if (web && marker > 1 && segs[marker + 1] === 'tree') {
    // GitLab: /group[/subgroup]/repo/-/tree/<ref>[/<path>]
    const refSeg = segs[marker + 2];
    if (!refSeg) throw new Error(`Unsupported GitLab URL: ${redact(raw)}`);
    const repoSegs = segs.slice(0, marker);
    if (repoSegs.some((s) => !NAME_PART_RE.test(s) || isDots(s))) throw new Error(`Unsupported GitLab URL: ${redact(raw)}`);
    repoSegs[repoSegs.length - 1] = repoSegs[repoSegs.length - 1].replace(/\.git$/, '') + '.git';
    const repoPath = '/' + repoSegs.join('/');
    if (u.search) warnings.push('Query string was not recorded.');
    const rest = segs.slice(marker + 3);
    return {
      source: `git:${rebuild(u, repoPath, true)}`,
      cloneUrl: rebuild(u, repoPath),
      ref: treeRef(refSeg),
      fromTree: true,
      subpath: rest.length > 0 ? checkSubpath(rest.join('/')) : undefined,
      warnings,
    };
  }

  if (u.search) warnings.push('Query string was not recorded.');
  const pathname = u.pathname.replace(/\/+$/, '');
  return { source: `git:${rebuild(u, pathname, true)}`, cloneUrl: rebuild(u, pathname), warnings };
}

/** Parses an `agenthub add` target that is not a local folder. Null when it is none of the remote forms. */
export function parseRemoteTarget(raw: string): RemoteSpec | null {
  if (!isUrlTarget(raw) && raw.includes('#')) {
    throw new Error(`Target must not contain "#": use owner/repo[@skill] and --ref <ref> to pick a branch, tag or commit`);
  }
  return isUrlTarget(raw) ? parseGitUrl(raw) : parseShorthand(raw);
}
