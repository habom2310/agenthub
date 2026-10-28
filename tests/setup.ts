import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point every test at a throwaway home so nothing can write to the real
// ~/.agenthub, ~/.claude or ~/.gemini, even a test that forgets setCustomHome.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-test-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.AGENTHUB_HOME;
