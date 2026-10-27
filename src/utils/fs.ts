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
 * Safely writes a UTF-8 file, ensuring parent directories exist before writing.
 * Uses atomic sibling write and rename to prevent partial writes.
 */
export function safeWriteFile(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, content, 'utf-8');
    fs.renameSync(tempPath, filePath);
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
