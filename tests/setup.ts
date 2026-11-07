import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

// Point every test at a throwaway home so nothing can write to the real
// ~/.agenthub, ~/.claude or ~/.gemini, even a test that forgets setCustomHome.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-test-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.AGENTHUB_HOME;
delete process.env.AGENTHUB_HUB;
// CI forces colour; output assertions expect plain text.
process.env.NO_COLOR = '1';
delete process.env.FORCE_COLOR;

// A `pi` binary on the developer's PATH would make every temp home look like it has Pi installed.
process.env.PATH = (process.env.PATH ?? '')
  .split(path.delimiter)
  .filter((dir) => !['pi', 'pi.cmd', 'pi.exe', 'pi.bat'].some((n) => fs.existsSync(path.join(dir, n))))
  .join(path.delimiter);

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});
