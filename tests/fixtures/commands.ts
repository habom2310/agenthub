import fs from 'node:fs';
import path from 'node:path';
import { safeWriteFile } from '../../src/utils/fs.js';

/** Discoverable fixture commands for sync tests that never start MCP servers. */
export function createTestCommands(bin: string, names: string[]): void {
  for (const name of names) {
    const file = path.join(bin, name + (process.platform === 'win32' ? '.cmd' : ''));
    safeWriteFile(file, process.platform === 'win32' ? '@exit /b 0\n' : '#!/bin/sh\nexit 0\n');
    fs.chmodSync(file, 0o755);
  }
}
