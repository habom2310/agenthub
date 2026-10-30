import fs from 'node:fs';
import path from 'node:path';

export interface JunctionOptions {
  force?: boolean;
}

/**
 * Creates a Windows junction or a directory symlink on other platforms.
 * Handles clean replacement if the linkPath already exists (if it is a link,
 * or if force is true).
 */
export function createJunction(target: string, linkPath: string, options?: JunctionOptions): boolean {
  try {
    const resolvedTarget = path.resolve(target);
    const resolvedLink = path.resolve(linkPath);

    // Target must exist
    if (!fs.existsSync(resolvedTarget)) {
      return false;
    }

    // Ensure parent directory exists
    fs.mkdirSync(path.dirname(resolvedLink), { recursive: true });

    let existingLstat: fs.Stats | null = null;
    try {
      existingLstat = fs.lstatSync(resolvedLink);
    } catch {
      existingLstat = null;
    }

    if (existingLstat) {
      if (existingLstat.isSymbolicLink()) {
        try {
          const currentTarget = fs.realpathSync(resolvedLink);
          let canonicalTarget = resolvedTarget;
          try {
            canonicalTarget = fs.realpathSync(resolvedTarget);
          } catch {
            canonicalTarget = resolvedTarget;
          }
          const isSame =
            process.platform === 'win32'
              ? currentTarget.toLowerCase() === canonicalTarget.toLowerCase()
              : currentTarget === canonicalTarget;
          if (isSame) {
            return true;
          }
        } catch {
          // broken link or inaccessible target
        }
        // Remove existing link
        fs.unlinkSync(resolvedLink);
      } else if (existingLstat.isDirectory()) {
        if (options?.force) {
          fs.rmSync(resolvedLink, { recursive: true, force: true });
        } else {
          return false;
        }
      } else {
        if (options?.force) {
          fs.unlinkSync(resolvedLink);
        } else {
          return false;
        }
      }
    }

    const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(resolvedTarget, resolvedLink, symlinkType);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks whether a given path is a junction or symbolic link.
 */
export function isJunctionOrSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Ensures that a directory exists, creating parent directories recursively if needed.
 */
export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * Returns the current UTC time as YYYYMMDD_HHMMSSZ, used for backup names.
 */
export function getUtcTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const year = now.getUTCFullYear();
  const month = pad(now.getUTCMonth() + 1);
  const day = pad(now.getUTCDate());
  const hours = pad(now.getUTCHours());
  const mins = pad(now.getUTCMinutes());
  const secs = pad(now.getUTCSeconds());
  return `${year}${month}${day}_${hours}${mins}${secs}Z`;
}

/**
 * Renames a real skills directory to a sibling backup without deleting any
 * earlier backup. Uses skills.old when free (the name uninstall restores),
 * otherwise skills.old.<YYYYMMDD_HHMMSSZ>, adding -N on a same-second clash.
 * Returns the backup path.
 */
export function backupSkillsDir(skillsDir: string): string {
  // lstat, not existsSync: a dangling symlink at a candidate name still counts as taken
  const taken = (p: string): boolean => {
    try {
      fs.lstatSync(p);
      return true;
    } catch {
      return false;
    }
  };
  const base = path.join(path.dirname(skillsDir), 'skills.old');
  let backup = base;
  if (taken(backup)) {
    const stamped = `${base}.${getUtcTimestamp()}`;
    backup = stamped;
    for (let n = 1; taken(backup); n++) {
      backup = `${stamped}-${n}`;
    }
  }
  fs.renameSync(skillsDir, backup);
  return backup;
}

/** Follows a symlink (even a dangling one) to the file that is really written. */
function resolveWriteTarget(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    // missing, or a dangling link
  }
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) {
      return path.resolve(path.dirname(filePath), fs.readlinkSync(filePath));
    }
  } catch {
    // does not exist yet
  }
  return filePath;
}

/**
 * Safely writes a UTF-8 file, ensuring parent directories exist before writing.
 * Uses atomic sibling write and rename to prevent partial writes. A symlinked file
 * stays a symlink (the target is rewritten), an existing file keeps its mode, and
 * a new file is created with mode 0600 because configs can hold tokens.
 */
export function safeWriteFile(filePath: string, content: string): void {
  const target = resolveWriteTarget(filePath);
  ensureDir(path.dirname(target));
  let mode = 0o600;
  try {
    mode = fs.statSync(target).mode & 0o7777;
  } catch {
    // new file
  }
  const tempPath = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, content, { encoding: 'utf-8', mode });
    if (process.platform !== 'win32') fs.chmodSync(tempPath, mode);
    fs.renameSync(tempPath, target);
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
}

/**
 * Finds an executable in the system PATH.
 * On Windows, checks extensions defined in PATHEXT (e.g. .exe, .cmd, .bat).
 */
export function findExecutable(name: string): string | null {
  if (!name) return null;

  const isWindows = process.platform === 'win32';
  const pathEnv = process.env.PATH || '';
  const pathDirs = pathEnv
    .split(path.delimiter)
    .map((p) => p.trim().replace(/^"(.*)"$/, '$1').trim())
    .filter(Boolean);

  const hasPathSep = name.includes('/') || (isWindows && name.includes('\\'));

  const pathextEnv = process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
  const pathextList = pathextEnv.split(';').filter(Boolean);

  function checkFile(candidate: string): string | null {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) {
        if (!isWindows) {
          fs.accessSync(candidate, fs.constants.X_OK);
        }
        return candidate;
      }
    } catch {
      // file does not exist or cannot be accessed
    }
    return null;
  }

  function checkWithExtensions(basePath: string): string | null {
    if (isWindows) {
      const ext = path.extname(basePath).toLowerCase();
      if (ext && pathextList.some((e) => e.toLowerCase() === ext)) {
        const found = checkFile(basePath);
        if (found) return found;
      }
      for (const extCandidate of pathextList) {
        const fullExt = extCandidate.startsWith('.') ? extCandidate : `.${extCandidate}`;
        const withExt = basePath + fullExt;
        const found = checkFile(withExt);
        if (found) return found;
      }
      return checkFile(basePath);
    } else {
      return checkFile(basePath);
    }
  }

  if (hasPathSep) {
    return checkWithExtensions(path.resolve(name));
  }

  for (const dir of pathDirs) {
    const candidate = path.join(dir, name);
    const found = checkWithExtensions(candidate);
    if (found) return found;
  }

  return null;
}

/**
 * True when `p` is `base` or inside it. Case-insensitive on Windows and macOS,
 * whose default file systems ignore case.
 */
export function isWithin(base: string, p: string): boolean {
  const fold = (v: string) => (process.platform === 'win32' || process.platform === 'darwin' ? v.toLowerCase() : v);
  const rel = path.relative(fold(path.resolve(base)), fold(path.resolve(p)));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
