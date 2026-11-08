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
// Newer git starts detached auto-maintenance after commit, fetch and push. It can still be writing
// in a test's temp repo during cleanup, and rmSync then fails with ENOTEMPTY.
const gitConfig = path.join(home, '.gitconfig');
fs.writeFileSync(gitConfig, '[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n');
process.env.GIT_CONFIG_GLOBAL = gitConfig;

// A `pi` or `copilot` binary on the developer's PATH would make every temp home look like it has Pi or Copilot installed.
const DETECTED_BINARIES = ['pi', 'copilot'].flatMap((b) => [b, `${b}.cmd`, `${b}.exe`, `${b}.bat`]);
process.env.PATH = (process.env.PATH ?? '')
  .split(path.delimiter)
  .filter((dir) => !DETECTED_BINARIES.some((n) => fs.existsSync(path.join(dir, n))))
  .join(path.delimiter);

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});
