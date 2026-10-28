import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setCustomHome } from '../src/core/detector.js';
import {
  HEADER_GUARD,
  PLATFORM_RULE_FILES,
  getAddonRuleFiles,
  parseFrontmatter,
  projectAll,
  projectClaudeRules,
  projectCodexRules,
  projectCursorRules,
  projectGeminiRules,
  projectRules,
  projectSubagents,
  projectWindsurfRules,
} from '../src/core/projector.js';
import { ensureDir, safeWriteFile } from '../src/utils/fs.js';

describe('projector', () => {
  let tmpDir: string;
  let homeDir: string;
  let hubDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-projector-test-'));
    homeDir = path.join(tmpDir, 'home');
    hubDir = path.join(tmpDir, 'hub');
    ensureDir(homeDir);
    ensureDir(hubDir);
    setCustomHome(homeDir, hubDir);
  });

  afterEach(() => {
    setCustomHome(null, null);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe('parseFrontmatter', () => {
    it('returns empty meta and body for content without frontmatter', () => {
      const content = 'No frontmatter here\nJust markdown body';
      const parsed = parseFrontmatter(content);
      expect(parsed.meta).toEqual({});
      expect(parsed.body).toBe(content);
    });

    it('returns empty meta when fewer than 3 parts (unclosed frontmatter)', () => {
      const content = '---\nname: unclosed\ntier: pro\n';
      const parsed = parseFrontmatter(content);
      expect(parsed.meta).toEqual({});
      expect(parsed.body).toBe(content);
    });

    it('parses single-line key-value pairs', () => {
      const content = `---
name: sample-agent
tier: pro
effort: medium
---

Agent prompt body.`;

      const { meta, body } = parseFrontmatter(content);
      expect(meta.name).toBe('sample-agent');
      expect(meta.tier).toBe('pro');
      expect(meta.effort).toBe('medium');
      expect(body).toContain('Agent prompt body.');
    });

    it('strips surrounding single and double quotes', () => {
      const content = `---
name: "quoted-agent"
description: 'Single quoted description'
tier: "fast"
mode: 'read-write'
---

Body text.`;

      const { meta } = parseFrontmatter(content);
      expect(meta.name).toBe('quoted-agent');
      expect(meta.description).toBe('Single quoted description');
      expect(meta.tier).toBe('fast');
      expect(meta.mode).toBe('read-write');
    });

    it('supports folded block scalars (>) with indented continuation lines', () => {
      const content = `---
name: folded-agent
description: >
  First line of description.
  Second line of description.
tier: fast
---

Agent prompt body.`;

      const { meta, body } = parseFrontmatter(content);
      expect(meta.name).toBe('folded-agent');
      expect(meta.description).toBe('First line of description. Second line of description.');
      expect(meta.tier).toBe('fast');
      expect(body).toContain('Agent prompt body.');
    });

    it('supports literal block scalars (|), (>-), and (|-) with indented lines', () => {
      const content = `---
name: literal-agent
description: |
  Literal line one.
  Literal line two.
notes: >-
  Folded stripped note.
  Second note line.
rules: |-
  Rule A.
  Rule B.
---

Body text.`;

      const { meta } = parseFrontmatter(content);
      expect(meta.name).toBe('literal-agent');
      expect(meta.description).toBe('Literal line one.\nLiteral line two.');
      expect(meta.notes).toBe('Folded stripped note. Second note line.');
      expect(meta.rules).toBe('Rule A.\nRule B.');
    });

    it('supports inline and line comments (#) in YAML frontmatter', () => {
      const content = `---
# Top comment
name: commented-agent # Inline comment
tier: pro
# Middle comment
effort: max # Another inline comment
---

Body text with # not a comment.`;

      const { meta, body } = parseFrontmatter(content);
      expect(meta.name).toBe('commented-agent');
      expect(meta.tier).toBe('pro');
      expect(meta.effort).toBe('max');
      expect(body).toContain('Body text with # not a comment.');
    });

    it('supports unquoted colons in YAML values such as URLs and timestamps', () => {
      const content = `---
name: url-agent
endpoint: http://localhost:8080/v1
timestamp: 2026-10-27T12:00:00Z
---

Body text.`;

      const { meta } = parseFrontmatter(content);
      expect(meta.name).toBe('url-agent');
      expect(meta.endpoint).toBe('http://localhost:8080/v1');
      expect(meta.timestamp).toBe('2026-10-27T12:00:00Z');
    });

    it('returns empty meta and full content if YAML parsing fails', () => {
      const content = `---
name: broken
: : invalid yaml :
---

Body text.`;

      const { meta, body } = parseFrontmatter(content);
      expect(meta).toEqual({});
      expect(body).toBe(content);
    });

    it('preserves horizontal rule (---) inside the markdown body', () => {
      const content = `---
name: hr-agent
---

# Title
---
Section after horizontal rule`;

      const { meta, body } = parseFrontmatter(content);
      expect(meta.name).toBe('hr-agent');
      expect(body).toContain('# Title\n---\nSection after horizontal rule');
    });
  });

  describe('projectGeminiRules', () => {
    it('fails if rules directory does not exist in hub', () => {
      const res = projectGeminiRules(homeDir, hubDir);
      expect(res.success).toBe(false);
      expect(res.message).toContain('Rules directory not found');
    });

    it('concatenates gemini rules with header guard and writes to ~/.gemini/GEMINI.md', () => {
      const rulesDir = path.join(hubDir, 'rules');
      safeWriteFile(path.join(rulesDir, 'common.md'), '# Common Guidelines');
      safeWriteFile(path.join(rulesDir, 'code-tools.md'), '# Code Tools');
      safeWriteFile(path.join(rulesDir, 'handoffs.md'), '# Handoffs');
      safeWriteFile(path.join(rulesDir, 'overrides', 'agy.md'), '# AGY Overrides');

      const res = projectGeminiRules(homeDir, hubDir);
      expect(res.success).toBe(true);

      const targetPath = path.join(homeDir, '.gemini', 'GEMINI.md');
      expect(fs.existsSync(targetPath)).toBe(true);

      const content = fs.readFileSync(targetPath, 'utf-8');
      expect(content).toContain(HEADER_GUARD);
      expect(content).toContain('# Common Guidelines');
      expect(content).toContain('# Code Tools');
      expect(content).toContain('# Handoffs');
      expect(content).toContain('# AGY Overrides');
    });

    it('unlinks ~/.gemini/config/GEMINI.md if it exists with autogenerated header guard', () => {
      const rulesDir = path.join(hubDir, 'rules');
      safeWriteFile(path.join(rulesDir, 'common.md'), '# Common Rules');

      const duplicateConfig = path.join(homeDir, '.gemini', 'config', 'GEMINI.md');
      safeWriteFile(duplicateConfig, `${HEADER_GUARD}\n# Old Duplicate Config`);
      expect(fs.existsSync(duplicateConfig)).toBe(true);

      const res = projectGeminiRules(homeDir, hubDir);
      expect(res.success).toBe(true);

      // Target was written
      expect(fs.existsSync(path.join(homeDir, '.gemini', 'GEMINI.md'))).toBe(true);
      // Duplicate file was unlinked without backup
      expect(fs.existsSync(duplicateConfig)).toBe(false);
      expect(fs.existsSync(`${duplicateConfig}.backup`)).toBe(false);
    });

    it('backs up ~/.gemini/config/GEMINI.md to .backup if it is a custom file without header guard', () => {
      const rulesDir = path.join(hubDir, 'rules');
      safeWriteFile(path.join(rulesDir, 'common.md'), '# Common Rules');

      const customConfig = path.join(homeDir, '.gemini', 'config', 'GEMINI.md');
      safeWriteFile(customConfig, '# My Custom Rules');
      expect(fs.existsSync(customConfig)).toBe(true);

      const res = projectGeminiRules(homeDir, hubDir);
      expect(res.success).toBe(true);

      expect(fs.existsSync(path.join(homeDir, '.gemini', 'GEMINI.md'))).toBe(true);
      expect(fs.existsSync(customConfig)).toBe(false);
      expect(fs.existsSync(`${customConfig}.backup`)).toBe(true);
      expect(fs.readFileSync(`${customConfig}.backup`, 'utf-8')).toBe('# My Custom Rules');
    });
  });

  describe('projectClaudeRules', () => {
    it('outputs modular @import with posix paths when useImports is true (default)', () => {
      const rulesDir = path.join(hubDir, 'rules');
      for (const ruleFile of PLATFORM_RULE_FILES.claude) {
        safeWriteFile(path.join(rulesDir, ruleFile), `# ${ruleFile}`);
      }

      const res = projectClaudeRules({ homeDir, hubDir });
      expect(res.success).toBe(true);

      const targetPath = path.join(homeDir, '.claude', 'CLAUDE.md');
      expect(fs.existsSync(targetPath)).toBe(true);

      const content = fs.readFileSync(targetPath, 'utf-8');
      expect(content).toContain(HEADER_GUARD);

      for (const ruleFile of PLATFORM_RULE_FILES.claude) {
        const expectedPosix = path.join(rulesDir, ruleFile).replace(/\\/g, '/');
        expect(content).toContain(`@${expectedPosix}`);
      }
      // Ensure no windows backslashes exist in the @import lines
      expect(content).not.toMatch(/@.*\\.*/);
    });

    it('only imports existing rule files when useImports is true', () => {
      const rulesDir = path.join(hubDir, 'rules');
      safeWriteFile(path.join(rulesDir, 'common.md'), '# Common');

      const res = projectClaudeRules({ homeDir, hubDir });
      expect(res.success).toBe(true);

      const targetPath = path.join(homeDir, '.claude', 'CLAUDE.md');
      const content = fs.readFileSync(targetPath, 'utf-8');

      const commonPosix = path.join(rulesDir, 'common.md').replace(/\\/g, '/');
      expect(content).toContain(`@${commonPosix}`);

      const codeToolsPosix = path.join(rulesDir, 'code-tools.md').replace(/\\/g, '/');
      expect(content).not.toContain(`@${codeToolsPosix}`);
    });

    it('returns false when useImports is true and rules directory is missing', () => {
      const res = projectClaudeRules({ useImports: true, homeDir, hubDir });
      expect(res.success).toBe(false);
      expect(res.message).toContain('Rules directory not found');
    });

    it('returns false when useImports is true and no rule files exist in rules directory', () => {
      const rulesDir = path.join(hubDir, 'rules');
      ensureDir(rulesDir);

      const res = projectClaudeRules({ useImports: true, homeDir, hubDir });
      expect(res.success).toBe(false);
      expect(res.message).toContain('No rule files found to project in');
    });

    it('concatenates full markdown when useImports is false', () => {
      const rulesDir = path.join(hubDir, 'rules');
      safeWriteFile(path.join(rulesDir, 'common.md'), '# Claude Common Rules');
      safeWriteFile(path.join(rulesDir, 'code-tools.md'), '# Claude Tools');
      safeWriteFile(path.join(rulesDir, 'handoffs.md'), '# Claude Handoffs');
      safeWriteFile(path.join(rulesDir, 'overrides', 'claude.md'), '# Claude Specifics');

      const res = projectClaudeRules({ useImports: false, homeDir, hubDir });
      expect(res.success).toBe(true);

      const targetPath = path.join(homeDir, '.claude', 'CLAUDE.md');
      const content = fs.readFileSync(targetPath, 'utf-8');
      expect(content).toContain(HEADER_GUARD);
      expect(content).toContain('# Claude Common Rules');
      expect(content).toContain('# Claude Specifics');
      expect(content).not.toContain('@');
    });

    it('returns false when useImports is false and rules directory is missing', () => {
      const res = projectClaudeRules({ useImports: false, homeDir, hubDir });
      expect(res.success).toBe(false);
      expect(res.message).toContain('Rules directory not found');
    });
  });

  describe('projectCodexRules', () => {
    it('fails if rules directory does not exist', () => {
      const res = projectCodexRules(homeDir, hubDir);
      expect(res.success).toBe(false);
      expect(res.message).toContain('Rules directory not found');
    });

    it('projects AGENTS.md and creates ChatGPT custom instructions export', () => {
      const rulesDir = path.join(hubDir, 'rules');
      safeWriteFile(path.join(rulesDir, 'common.md'), '# Codex Common');
      safeWriteFile(path.join(rulesDir, 'overrides', 'codex.md'), '# Codex Overrides');

      const res = projectCodexRules(homeDir, hubDir);
      expect(res.success).toBe(true);

      const target = path.join(homeDir, '.codex', 'AGENTS.md');
      const exportFile = path.join(hubDir, 'export', 'chatgpt_custom_instructions.md');

      expect(fs.existsSync(target)).toBe(true);
      expect(fs.existsSync(exportFile)).toBe(true);

      const targetContent = fs.readFileSync(target, 'utf-8');
      const exportContent = fs.readFileSync(exportFile, 'utf-8');

      expect(targetContent).toBe(exportContent);
      expect(targetContent).toContain(HEADER_GUARD);
      expect(targetContent).toContain('# Codex Common');
      expect(targetContent).toContain('# Codex Overrides');
    });
  });

  describe('projectCursorRules', () => {
    it('skips projection when cursor directory and .cursorrules do not exist', () => {
      const res = projectCursorRules(undefined, homeDir, hubDir);
      expect(res.success).toBe(true);
      expect(res.message).toBe('Cursor not detected/connected; skipped projection');

      expect(fs.existsSync(path.join(homeDir, '.cursor'))).toBe(false);
      expect(fs.existsSync(path.join(homeDir, '.cursorrules'))).toBe(false);
    });

    it('projects cursor rules when ~/.cursor exists', () => {
      const cursorDir = path.join(homeDir, '.cursor');
      ensureDir(cursorDir);

      const rulesDir = path.join(hubDir, 'rules');
      safeWriteFile(path.join(rulesDir, 'common.md'), '# Cursor Common');
      safeWriteFile(path.join(rulesDir, 'overrides', 'cursor.md'), '# Cursor Specific');

      const res = projectCursorRules(cursorDir, homeDir, hubDir);
      expect(res.success).toBe(true);

      const mdcFile = path.join(cursorDir, 'rules', 'agenthub.mdc');
      const cursorRulesFile = path.join(homeDir, '.cursorrules');

      expect(fs.existsSync(mdcFile)).toBe(true);
      expect(fs.existsSync(cursorRulesFile)).toBe(true);

      const mdcContent = fs.readFileSync(mdcFile, 'utf-8');
      expect(mdcContent).toContain('description: Global multi-assistant heuristics and engineering guidelines');
      expect(mdcContent).toContain('globs: *');
      expect(mdcContent).toContain(HEADER_GUARD);
      expect(mdcContent).toContain('# Cursor Common');
      expect(mdcContent).toContain('# Cursor Specific');

      const rulesContent = fs.readFileSync(cursorRulesFile, 'utf-8');
      expect(rulesContent).toContain(HEADER_GUARD);
      expect(rulesContent).toContain('# Cursor Common');
    });

    it('projects cursor rules when ~/.cursorrules exists even without .cursor dir', () => {
      const cursorRulesFile = path.join(homeDir, '.cursorrules');
      safeWriteFile(cursorRulesFile, 'old cursorrules');

      const rulesDir = path.join(hubDir, 'rules');
      safeWriteFile(path.join(rulesDir, 'common.md'), '# Common');

      const res = projectCursorRules(undefined, homeDir, hubDir);
      expect(res.success).toBe(true);

      expect(fs.existsSync(path.join(homeDir, '.cursor', 'rules', 'agenthub.mdc'))).toBe(true);
    });
  });

  describe('projectWindsurfRules', () => {
    it('skips projection when Windsurf is not detected', () => {
      const res = projectWindsurfRules(undefined, homeDir, hubDir);
      expect(res.success).toBe(true);
      expect(res.message).toBe('Windsurf not detected/connected; skipped projection');
    });

    it('projects windsurf rules when ~/.codeium/windsurf directory exists', () => {
      const codeiumDir = path.join(homeDir, '.codeium', 'windsurf');
      ensureDir(codeiumDir);

      const rulesDir = path.join(hubDir, 'rules');
      safeWriteFile(path.join(rulesDir, 'common.md'), '# Windsurf Common');
      safeWriteFile(path.join(rulesDir, 'overrides', 'windsurf.md'), '# Windsurf Specific');

      const res = projectWindsurfRules(undefined, homeDir, hubDir);
      expect(res.success).toBe(true);

      const globalRules = path.join(codeiumDir, 'memories', 'global_rules.md');
      const wsRules = path.join(homeDir, '.windsurfrules');

      expect(fs.existsSync(globalRules)).toBe(true);
      expect(fs.existsSync(wsRules)).toBe(true);

      const content = fs.readFileSync(globalRules, 'utf-8');
      expect(content).toContain(HEADER_GUARD);
      expect(content).toContain('# Windsurf Common');
      expect(content).toContain('# Windsurf Specific');
    });

    it('projects windsurf rules when windsurfDir is passed explicitly', () => {
      const customWsDir = path.join(tmpDir, 'custom-windsurf');
      ensureDir(customWsDir);

      const rulesDir = path.join(hubDir, 'rules');
      safeWriteFile(path.join(rulesDir, 'common.md'), '# Custom WS Common');

      const res = projectWindsurfRules(customWsDir, homeDir, hubDir);
      expect(res.success).toBe(true);

      expect(fs.existsSync(path.join(customWsDir, 'memories', 'global_rules.md'))).toBe(true);
      expect(fs.existsSync(path.join(homeDir, '.windsurfrules'))).toBe(true);
    });
  });

  describe('projectSubagents', () => {
    it('fails when hub agents directory is missing', () => {
      const res = projectSubagents(homeDir, hubDir);
      expect(res.success).toBe(false);
      expect(res.results).toEqual(['No agents directory in hub']);
    });

    it('generates Gemini and Claude subagent configurations with correct model and tools mapping', () => {
      const agentsDir = path.join(hubDir, 'agents');

      // 1. implementer: mode=read-write, tier=inherit
      safeWriteFile(
        path.join(agentsDir, 'implementer.md'),
        `---
name: implementer
description: Implementation subagent
tier: inherit
effort: medium
mode: read-write
---

You are the implementer.`
      );

      // 2. reviewer: mode=read-only, tier=pro, effort=high
      safeWriteFile(
        path.join(agentsDir, 'reviewer.md'),
        `---
name: reviewer
description: Reviewer subagent
tier: pro
effort: high
mode: read-only
---

You are the reviewer.`
      );

      // 3. scout: mode=read-only, tier=fast
      safeWriteFile(
        path.join(agentsDir, 'scout.md'),
        `---
name: scout
description: Scout subagent
tier: fast
mode: read-only
---

You are the scout.`
      );

      // 4. writer: enable_write_tools=true, tier=smart
      safeWriteFile(
        path.join(agentsDir, 'writer.md'),
        `---
name: writer
description: Writer subagent
tier: smart
enable_write_tools: true
---

You are the writer.`
      );

      const res = projectSubagents(homeDir, hubDir);
      expect(res.success).toBe(true);
      expect(res.results).toHaveLength(4);

      // Check Gemini Implementer
      const geminiImplPath = path.join(homeDir, '.gemini', 'config', 'agents', 'implementer.md');
      expect(fs.existsSync(geminiImplPath)).toBe(true);
      const geminiImplContent = fs.readFileSync(geminiImplPath, 'utf-8');
      expect(geminiImplContent).toContain('model: inherit');
      expect(geminiImplContent).toContain('effort: medium');
      expect(geminiImplContent).toContain('subagent: true');
      expect(geminiImplContent).toContain('- run_command');
      expect(geminiImplContent).toContain('- write_file');
      expect(geminiImplContent).toContain('- edit_file');
      expect(geminiImplContent).toContain('- read_file');
      expect(geminiImplContent).toContain('You are the implementer.');

      // Check Claude Implementer
      const claudeImplPath = path.join(homeDir, '.claude', 'agents', 'implementer.md');
      expect(fs.existsSync(claudeImplPath)).toBe(true);
      const claudeImplContent = fs.readFileSync(claudeImplPath, 'utf-8');
      expect(claudeImplContent).toContain('model: haiku'); // inherit -> haiku
      expect(claudeImplContent).toContain('tools: Bash, Read, Edit, Write, Glob, Grep');
      expect(claudeImplContent).toContain('effort: medium');
      expect(claudeImplContent).toContain('You are the implementer.');

      // Check Reviewer
      const geminiRevContent = fs.readFileSync(path.join(homeDir, '.gemini', 'config', 'agents', 'reviewer.md'), 'utf-8');
      expect(geminiRevContent).toContain('model: pro');
      expect(geminiRevContent).toContain('effort: high');
      expect(geminiRevContent).not.toContain('- write_file');
      expect(geminiRevContent).toContain('- run_command');
      expect(geminiRevContent).toContain('- read_file');

      const claudeRevContent = fs.readFileSync(path.join(homeDir, '.claude', 'agents', 'reviewer.md'), 'utf-8');
      expect(claudeRevContent).toContain('model: sonnet'); // pro -> sonnet
      expect(claudeRevContent).toContain('tools: Bash, Read, Glob, Grep');

      // Check Scout (tier: fast)
      const geminiScoutContent = fs.readFileSync(path.join(homeDir, '.gemini', 'config', 'agents', 'scout.md'), 'utf-8');
      expect(geminiScoutContent).toContain('model: flash');

      const claudeScoutContent = fs.readFileSync(path.join(homeDir, '.claude', 'agents', 'scout.md'), 'utf-8');
      expect(claudeScoutContent).toContain('model: haiku');

      // Check Writer (tier: smart, enable_write_tools: true)
      const geminiWriterContent = fs.readFileSync(path.join(homeDir, '.gemini', 'config', 'agents', 'writer.md'), 'utf-8');
      expect(geminiWriterContent).toContain('model: pro'); // smart -> pro
      expect(geminiWriterContent).toContain('- write_file');
    });

    it('applies claude_model, claude_tools and permissionMode to the Claude agent only', () => {
      safeWriteFile(
        path.join(hubDir, 'agents', 'custom.md'),
        `---
name: custom
description: Custom agent
tier: inherit
permissionMode: auto
claude_model: claude-haiku-5-5
claude_tools: Bash, Read, Edit, Write, Grep, Glob, ToolSearch
---

Body.`
      );

      expect(projectSubagents(homeDir, hubDir).success).toBe(true);

      const claude = fs.readFileSync(path.join(homeDir, '.claude', 'agents', 'custom.md'), 'utf-8');
      expect(claude).toContain('model: claude-haiku-5-5');
      expect(claude).toContain('permissionMode: auto');
      expect(claude).toContain('tools: Bash, Read, Edit, Write, Grep, Glob, ToolSearch');
      expect(claude).not.toContain('claude_');

      const gemini = fs.readFileSync(path.join(homeDir, '.gemini', 'config', 'agents', 'custom.md'), 'utf-8');
      expect(gemini).toContain('model: inherit');
      expect(gemini).not.toContain('permissionMode');
      expect(gemini).not.toContain('ToolSearch');
    });

    it('projects <!-- claude-only --> blocks to Claude and strips them for Gemini', () => {
      safeWriteFile(
        path.join(hubDir, 'agents', 'sample.md'),
        `---
name: sample
description: Sample agent
---

Shared intro.

<!-- claude-only -->
Claude-only text.
<!-- /claude-only -->

Shared outro.`
      );

      expect(projectSubagents(homeDir, hubDir).success).toBe(true);

      const claude = fs.readFileSync(path.join(homeDir, '.claude', 'agents', 'sample.md'), 'utf-8');
      expect(claude).toContain('Shared intro.\n\nClaude-only text.\n\nShared outro.');
      expect(claude).not.toContain('claude-only');

      const gemini = fs.readFileSync(path.join(homeDir, '.gemini', 'config', 'agents', 'sample.md'), 'utf-8');
      expect(gemini).toContain('Shared intro.\n\n\nShared outro.');
      expect(gemini).not.toContain('Claude-only text.');
      expect(gemini).not.toContain('claude-only');
    });

    it('handles CRLF line endings and several claude-only blocks', () => {
      safeWriteFile(
        path.join(hubDir, 'agents', 'multi.md'),
        '---\r\nname: multi\r\ndescription: Multi agent\r\n---\r\n\r\nA\r\n<!-- claude-only -->\r\nOne\r\n<!-- /claude-only -->\r\nB\r\n<!-- claude-only -->\r\nTwo\r\n<!-- /claude-only -->\r\nC\r\n'
      );

      const res = projectSubagents(homeDir, hubDir);
      expect(res.results.some((r) => r.startsWith('Warning'))).toBe(false);

      const claude = fs.readFileSync(path.join(homeDir, '.claude', 'agents', 'multi.md'), 'utf-8');
      expect(claude).toContain('A\r\nOne\r\nB\r\nTwo\r\nC');
      expect(claude).not.toContain('claude-only');

      const gemini = fs.readFileSync(path.join(homeDir, '.gemini', 'config', 'agents', 'multi.md'), 'utf-8');
      expect(gemini).toContain('A\r\nB\r\nC');
      expect(gemini).not.toContain('One');
      expect(gemini).not.toContain('Two');
    });

    it('warns when a claude-only block is not closed', () => {
      safeWriteFile(
        path.join(hubDir, 'agents', 'open.md'),
        '---\nname: open\ndescription: Open agent\n---\n\nShared.\n<!-- claude-only -->\nClaude-only text.\n'
      );

      const res = projectSubagents(homeDir, hubDir);
      expect(res.results).toContain(
        'Warning: open has a malformed claude-only block (put each marker on its own line, no nesting); its text was projected to Gemini too'
      );
    });

    it('handles a claude-only block that ends the file without a trailing newline', () => {
      safeWriteFile(
        path.join(hubDir, 'agents', 'tail.md'),
        '---\nname: tail\ndescription: Tail agent\n---\n\nShared.\n\n<!-- claude-only -->\nClaude-only text.\n<!-- /claude-only -->'
      );

      expect(projectSubagents(homeDir, hubDir).success).toBe(true);

      const claude = fs.readFileSync(path.join(homeDir, '.claude', 'agents', 'tail.md'), 'utf-8');
      expect(claude).toContain('Shared.\n\nClaude-only text.\n');
      expect(claude).not.toContain('claude-only');

      const gemini = fs.readFileSync(path.join(homeDir, '.gemini', 'config', 'agents', 'tail.md'), 'utf-8');
      expect(gemini).not.toContain('Claude-only text.');
      expect(gemini).not.toContain('claude-only');
    });
  });

  describe('projectRules and projectAll', () => {
    it('aggregates messages across all projections', () => {
      const rulesDir = path.join(hubDir, 'rules');
      safeWriteFile(path.join(rulesDir, 'common.md'), '# Common');
      safeWriteFile(path.join(rulesDir, 'code-tools.md'), '# Code Tools');
      safeWriteFile(path.join(rulesDir, 'handoffs.md'), '# Handoffs');
      safeWriteFile(path.join(rulesDir, 'overrides', 'agy.md'), '# AGY');
      safeWriteFile(path.join(rulesDir, 'overrides', 'claude.md'), '# Claude');
      safeWriteFile(path.join(rulesDir, 'overrides', 'codex.md'), '# Codex');

      const rulesRes = projectRules({ homeDir, hubDir });
      expect(rulesRes.success).toBe(true);
      expect(rulesRes.messages.length).toBe(5);

      const agentsDir = path.join(hubDir, 'agents');
      safeWriteFile(path.join(agentsDir, 'test.md'), '---\nname: test\n---\nPrompt');

      const allRes = projectAll({ homeDir, hubDir });
      expect(allRes.success).toBe(true);
      expect(allRes.messages.some((m) => m.includes('Projected GEMINI.md'))).toBe(true);
      expect(allRes.messages.some((m) => m.includes('Projected CLAUDE.md'))).toBe(true);
      expect(allRes.messages.some((m) => m.includes('Projected AGENTS.md'))).toBe(true);
      expect(allRes.messages.some((m) => m.includes('Projected subagent: test'))).toBe(true);
    });
  });

  describe('addon rules projection', () => {
    beforeEach(() => {
      // Create base rules
      safeWriteFile(path.join(hubDir, 'rules', 'common.md'), '# Base Common Rules');
      // Create addon rules
      safeWriteFile(
        path.join(hubDir, 'rules', 'addons', 'security.md'),
        '# Security Addon Rules\nAlways sanitize input.'
      );
      safeWriteFile(
        path.join(hubDir, 'rules', 'addons', 'testing.md'),
        '# Testing Addon Rules\nAlways write tests.'
      );
      // Non-markdown or hidden file should be ignored
      safeWriteFile(path.join(hubDir, 'rules', 'addons', '.hidden.md'), '# Hidden');
      safeWriteFile(path.join(hubDir, 'rules', 'addons', 'notes.txt'), 'Not markdown');
      fs.mkdirSync(path.join(hubDir, 'rules', 'addons', 'subfolder.md'));
    });

    it('getAddonRuleFiles returns sorted relative paths and ignores non-markdown/hidden files and directories', () => {
      const files = getAddonRuleFiles(hubDir);
      expect(files).toEqual(['addons/security.md', 'addons/testing.md']);
    });

    it('projects addon rules into Gemini (~/.gemini/GEMINI.md)', () => {
      const res = projectGeminiRules(homeDir, hubDir);
      expect(res.success).toBe(true);

      const targetPath = path.join(homeDir, '.gemini', 'GEMINI.md');
      expect(fs.existsSync(targetPath)).toBe(true);

      const content = fs.readFileSync(targetPath, 'utf-8');
      expect(content).toContain('# Base Common Rules');
      expect(content).toContain('# Security Addon Rules');
      expect(content).toContain('Always sanitize input.');
      expect(content).toContain('# Testing Addon Rules');
      expect(content).not.toContain('# Hidden');
      expect(content).not.toContain('Not markdown');
    });

    it('projects addon rules to Claude with imports (useImports: true)', () => {
      const res = projectClaudeRules({ useImports: true, homeDir, hubDir });
      expect(res.success).toBe(true);

      const targetPath = path.join(homeDir, '.claude', 'CLAUDE.md');
      const content = fs.readFileSync(targetPath, 'utf-8');

      const securityPosix = path.join(hubDir, 'rules', 'addons', 'security.md').replace(/\\/g, '/');
      const testingPosix = path.join(hubDir, 'rules', 'addons', 'testing.md').replace(/\\/g, '/');

      expect(content).toContain(`@${securityPosix}`);
      expect(content).toContain(`@${testingPosix}`);
      expect(content).not.toMatch(/@.*\\.*/);
    });

    it('projects addon rules to Claude without imports (useImports: false)', () => {
      const res = projectClaudeRules({ useImports: false, homeDir, hubDir });
      expect(res.success).toBe(true);

      const targetPath = path.join(homeDir, '.claude', 'CLAUDE.md');
      const content = fs.readFileSync(targetPath, 'utf-8');

      expect(content).toContain('# Base Common Rules');
      expect(content).toContain('# Security Addon Rules');
      expect(content).toContain('# Testing Addon Rules');
    });

    it('projects addon rules to Codex (~/.codex/AGENTS.md and ChatGPT export)', () => {
      const res = projectCodexRules(homeDir, hubDir);
      expect(res.success).toBe(true);

      const codexPath = path.join(homeDir, '.codex', 'AGENTS.md');
      const codexContent = fs.readFileSync(codexPath, 'utf-8');
      expect(codexContent).toContain('# Base Common Rules');
      expect(codexContent).toContain('# Security Addon Rules');
      expect(codexContent).toContain('# Testing Addon Rules');

      const exportPath = path.join(hubDir, 'export', 'chatgpt_custom_instructions.md');
      const exportContent = fs.readFileSync(exportPath, 'utf-8');
      expect(exportContent).toContain('# Security Addon Rules');
      expect(exportContent).toContain('# Testing Addon Rules');
    });

    it('projects addon rules to Cursor (.cursor/rules/agenthub.mdc and .cursorrules)', () => {
      const cursorDir = path.join(homeDir, '.cursor');
      ensureDir(cursorDir);

      const res = projectCursorRules(cursorDir, homeDir, hubDir);
      expect(res.success).toBe(true);

      const mdcPath = path.join(cursorDir, 'rules', 'agenthub.mdc');
      const mdcContent = fs.readFileSync(mdcPath, 'utf-8');
      expect(mdcContent).toContain('# Security Addon Rules');
      expect(mdcContent).toContain('# Testing Addon Rules');

      const cursorrulesPath = path.join(homeDir, '.cursorrules');
      const cursorrulesContent = fs.readFileSync(cursorrulesPath, 'utf-8');
      expect(cursorrulesContent).toContain('# Security Addon Rules');
      expect(cursorrulesContent).toContain('# Testing Addon Rules');
    });

    it('projects addon rules to Windsurf (.windsurf/memories/global_rules.md and .windsurfrules)', () => {
      const windsurfDir = path.join(homeDir, '.windsurf');
      ensureDir(windsurfDir);

      const res = projectWindsurfRules(windsurfDir, homeDir, hubDir);
      expect(res.success).toBe(true);

      const memoryPath = path.join(windsurfDir, 'memories', 'global_rules.md');
      const memoryContent = fs.readFileSync(memoryPath, 'utf-8');
      expect(memoryContent).toContain('# Security Addon Rules');
      expect(memoryContent).toContain('# Testing Addon Rules');

      const windsurfRulesPath = path.join(homeDir, '.windsurfrules');
      const windsurfRulesContent = fs.readFileSync(windsurfRulesPath, 'utf-8');
      expect(windsurfRulesContent).toContain('# Security Addon Rules');
      expect(windsurfRulesContent).toContain('# Testing Addon Rules');
    });
  });
});
