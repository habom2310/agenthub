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
// CI makes install default to a frozen lockfile; tests opt in explicitly.
delete process.env.CI;
// machine-local state goes under the throwaway home too
delete process.env.XDG_STATE_HOME;
process.env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});
