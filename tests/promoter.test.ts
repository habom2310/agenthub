import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MarkdownChunk, parseMarkdownChunks } from '../src/core/chunker.js';
import { setCustomHome } from '../src/core/detector.js';
import {
  HEADER_GUARD,
  PLATFORM_RULE_FILES,
  projectClaudeRules,
  projectCodexRules,
  projectGeminiRules,
} from '../src/core/projector.js';
import {
  detectRuleDrift,
  getExpectedRulesText,
  promoteChunk,
} from '../src/core/promoter.js';
import { ensureDir, safeWriteFile } from '../src/utils/fs.js';

describe('promoter', () => {
  let tmpDir: string;
  let homeDir: string;
  let hubDir: string;
  let rulesDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-promoter-test-'));
    homeDir = path.join(tmpDir, 'home');
    hubDir = path.join(tmpDir, 'hub');
    rulesDir = path.join(hubDir, 'rules');
    ensureDir(homeDir);
    ensureDir(rulesDir);
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

  describe('getExpectedRulesText', () => {
    it('starts with HEADER_GUARD and joins platform rule files', () => {
      safeWriteFile(path.join(rulesDir, 'common.md'), '# Common Rules\nAlways test.');
      safeWriteFile(path.join(rulesDir, 'code-tools.md'), '# Code Tools\nUse ripgrep.');
      safeWriteFile(path.join(rulesDir, 'overrides', 'agy.md'), '# Gemini Override\nBe brief.');

      const expected = getExpectedRulesText('gemini', rulesDir);
      expect(expected.startsWith(HEADER_GUARD.trim())).toBe(true);
      expect(expected).toContain('# Common Rules\nAlways test.');
      expect(expected).toContain('# Code Tools\nUse ripgrep.');
      expect(expected).toContain('# Gemini Override\nBe brief.');
      expect(expected.endsWith('\n')).toBe(true);
    });

    it('falls back to default files for unknown platform', () => {
      safeWriteFile(path.join(rulesDir, 'common.md'), '# Universal');
      safeWriteFile(path.join(rulesDir, 'code-tools.md'), '# Tools');
      safeWriteFile(path.join(rulesDir, 'handoffs.md'), '# Handoffs');

      const expected = getExpectedRulesText('unknown_plat', rulesDir);
      expect(expected).toContain('# Universal');
      expect(expected).toContain('# Tools');
      expect(expected).toContain('# Handoffs');
    });

    it('ignores missing files gracefully', () => {
      // Only common.md exists
      safeWriteFile(path.join(rulesDir, 'common.md'), '# Only Common');

      const expected = getExpectedRulesText('codex', rulesDir);
      expect(expected).toContain(HEADER_GUARD.trim());
      expect(expected).toContain('# Only Common');
      expect(expected).not.toContain('code-tools.md');
    });
  });

  describe('detectRuleDrift', () => {
    it('reports exists: false and hasDrift: false when downstream targets do not exist', () => {
      const audit = detectRuleDrift(homeDir, hubDir);
      expect(audit.gemini.exists).toBe(false);
      expect(audit.gemini.hasDrift).toBe(false);
      expect(audit.gemini.added).toHaveLength(0);
      expect(audit.claude.exists).toBe(false);
      expect(audit.claude.hasDrift).toBe(false);
      expect(audit.codex.exists).toBe(false);
      expect(audit.codex.hasDrift).toBe(false);
    });

    it('detects no drift when downstream targets match projected hub rules', () => {
      safeWriteFile(path.join(rulesDir, 'common.md'), '# Common Rules\nRule content.');
      safeWriteFile(path.join(rulesDir, 'code-tools.md'), '# Code Tools\nTool content.');
      safeWriteFile(path.join(rulesDir, 'handoffs.md'), '# Handoffs\nHandoff content.');
      safeWriteFile(path.join(rulesDir, 'overrides', 'agy.md'), '# Gemini Override\nAGY content.');
      safeWriteFile(path.join(rulesDir, 'overrides', 'claude.md'), '# Claude Override\nClaude content.');
      safeWriteFile(path.join(rulesDir, 'overrides', 'codex.md'), '# Codex Override\nCodex content.');

      projectGeminiRules(homeDir, hubDir);
      projectClaudeRules({ homeDir, hubDir, useImports: true });
      projectCodexRules(homeDir, hubDir);

      const audit = detectRuleDrift(homeDir, hubDir);
      expect(audit.gemini.exists).toBe(true);
      expect(audit.gemini.hasDrift).toBe(false);
      expect(audit.claude.exists).toBe(true);
      expect(audit.claude.hasDrift).toBe(false);
      expect(audit.codex.exists).toBe(true);
      expect(audit.codex.hasDrift).toBe(false);
    });

    it('detects downstream drift when content is modified or added', () => {
      safeWriteFile(path.join(rulesDir, 'common.md'), '# Common Rules\nRule content.');
      projectGeminiRules(homeDir, hubDir);

      const geminiFile = path.join(homeDir, '.gemini', 'GEMINI.md');
      const originalContent = fs.readFileSync(geminiFile, 'utf-8');

      // Add a drifted rule downstream
      const driftedContent = originalContent + '\n\n# Downstream Addition\nAlways clean up.\n';
      safeWriteFile(geminiFile, driftedContent);

      const audit = detectRuleDrift(homeDir, hubDir);
      expect(audit.gemini.hasDrift).toBe(true);
      expect(audit.gemini.added).toHaveLength(1);
      expect(audit.gemini.added[0].header).toBe('Downstream Addition');
    });

    it('handles Claude @import manifest detection vs non-manifest full diff', () => {
      safeWriteFile(path.join(rulesDir, 'common.md'), '# Rules\nSome content.');
      safeWriteFile(path.join(rulesDir, 'code-tools.md'), '# Tools\nSome content.');
      safeWriteFile(path.join(rulesDir, 'handoffs.md'), '# Handoffs\nSome content.');
      safeWriteFile(path.join(rulesDir, 'overrides', 'claude.md'), '# Claude\nSome content.');

      // 1. Claude as @import manifest without extra text -> no drift
      const claudeFile = path.join(homeDir, '.claude', 'CLAUDE.md');
      projectClaudeRules({ homeDir, hubDir, useImports: true });

      let audit = detectRuleDrift(homeDir, hubDir);
      expect(audit.claude.hasDrift).toBe(false);
      expect(audit.claude.added).toHaveLength(0);

      // 2. Claude as @import manifest WITH extra unimported rules -> drift detected
      const currentClaude = fs.readFileSync(claudeFile, 'utf-8');
      safeWriteFile(
        claudeFile,
        currentClaude + '\n\n# Custom Claude Rules\nExtra unimported instructions.\n'
      );

      audit = detectRuleDrift(homeDir, hubDir);
      expect(audit.claude.hasDrift).toBe(true);
      expect(audit.claude.added).toHaveLength(1);
      expect(audit.claude.added[0].header).toBe('Custom Claude Rules');

      // 3. Claude as compiled non-manifest -> full chunk diff
      projectClaudeRules({ homeDir, hubDir, useImports: false });
      audit = detectRuleDrift(homeDir, hubDir);
      expect(audit.claude.hasDrift).toBe(false);

      // Mutate one section in non-manifest CLAUDE.md
      const fullClaude = fs.readFileSync(claudeFile, 'utf-8');
      safeWriteFile(claudeFile, fullClaude.replace('Some content.', 'Mutated content downstream.'));

      audit = detectRuleDrift(homeDir, hubDir);
      expect(audit.claude.hasDrift).toBe(true);
      expect(audit.claude.modified).toHaveLength(1);
      expect(audit.claude.modified[0].source.header).toBe('Rules');
    });

    it('detects drift when expected @import rules are missing in Claude manifest', () => {
      const claudeFile = path.join(homeDir, '.claude', 'CLAUDE.md');
      // Manifest missing overrides/claude.md
      const partialManifest = [
        HEADER_GUARD,
        '@' + path.join(rulesDir, 'common.md').replace(/\\/g, '/'),
        '@' + path.join(rulesDir, 'code-tools.md').replace(/\\/g, '/'),
        '@' + path.join(rulesDir, 'handoffs.md').replace(/\\/g, '/'),
      ].join('\n\n') + '\n';
      safeWriteFile(claudeFile, partialManifest);

      const audit = detectRuleDrift(homeDir, hubDir);
      expect(audit.claude.hasDrift).toBe(true);
      expect(audit.claude.removed.length).toBeGreaterThan(0);
      expect(audit.claude.removed.some((r) => r.header.includes('overrides/claude.md'))).toBe(true);
    });

    it('normalizes backslashes when checking Claude @import manifest', () => {
      const claudeFile = path.join(homeDir, '.claude', 'CLAUDE.md');
      const windowsManifest = [
        HEADER_GUARD,
        `@C:\\users\\test\\.agentrc\\rules\\common.md`,
        `@C:\\users\\test\\.agentrc\\rules\\code-tools.md`,
        `@C:\\users\\test\\.agentrc\\rules\\handoffs.md`,
        `@C:\\users\\test\\.agentrc\\rules\\overrides\\claude.md`,
      ].join('\n\n') + '\n';
      safeWriteFile(claudeFile, windowsManifest);

      const audit = detectRuleDrift(homeDir, hubDir);
      expect(audit.claude.hasDrift).toBe(false);
      expect(audit.claude.removed).toHaveLength(0);
    });
  });

  describe('promoteChunk', () => {
    it('performs end-to-end promotion with auto-reproject resolving downstream drift', () => {
      safeWriteFile(path.join(rulesDir, 'common.md'), '# Common Rules\nRule content.');
      projectGeminiRules(homeDir, hubDir);

      const geminiFile = path.join(homeDir, '.gemini', 'GEMINI.md');
      safeWriteFile(
        geminiFile,
        fs.readFileSync(geminiFile, 'utf-8') + '\n\n# New Best Practice\nAlways write tests.\n'
      );

      // Drift is detected
      let audit = detectRuleDrift(homeDir, hubDir);
      expect(audit.gemini.hasDrift).toBe(true);
      const driftedChunk = audit.gemini.added[0];
      expect(driftedChunk.header).toBe('New Best Practice');

      // Promote the drifted chunk into common.md with auto-reproject (default)
      const res = promoteChunk(driftedChunk, { hubDir, homeDir });
      expect(res.success).toBe(true);
      expect(res.message).toBe("Promoted rule 'New Best Practice' into common.md");

      // Verify hub rules updated
      const commonContent = fs.readFileSync(path.join(rulesDir, 'common.md'), 'utf-8');
      expect(commonContent).toContain('# New Best Practice\nAlways write tests.');

      // Verify reprojected downstream matches and drift is now resolved
      audit = detectRuleDrift(homeDir, hubDir);
      expect(audit.gemini.hasDrift).toBe(false);
    });

    it('creates a new target rule file if it does not exist', () => {
      const chunk: MarkdownChunk = {
        header: 'New Brand Rule',
        level: 1,
        path: ['New Brand Rule'],
        content: 'Brand rules content.',
        raw: '# New Brand Rule\nBrand rules content.\n',
        normalizedHash: 'abc',
        codeBlocks: [],
      };

      const res = promoteChunk(chunk, {
        hubDir,
        homeDir,
        targetRuleFile: 'brand.md',
        reproject: false,
      });

      expect(res.success).toBe(true);
      expect(res.message).toBe("Promoted rule 'New Brand Rule' into brand.md");

      const created = fs.readFileSync(path.join(rulesDir, 'brand.md'), 'utf-8');
      expect(created).toBe('# New Brand Rule\nBrand rules content.\n');
    });

    it('preserves spacing and handles CRLF in-place modification of existing section', () => {
      const initialCommon =
        '# Section 1\r\nContent line 1.\r\nContent line 2.\r\n\r\n# Section 2\r\nContent 2.\r\n';
      safeWriteFile(path.join(rulesDir, 'common.md'), initialCommon);

      const updatedChunk: MarkdownChunk = {
        header: 'Section 1',
        level: 1,
        path: ['Section 1'],
        content: 'Updated content line 1.\nUpdated content line 2.',
        raw: '# Section 1\nUpdated content line 1.\nUpdated content line 2.\n',
        normalizedHash: 'def',
        codeBlocks: [],
      };

      const res = promoteChunk(updatedChunk, {
        hubDir,
        homeDir,
        targetRuleFile: 'common.md',
        reproject: false,
      });

      expect(res.success).toBe(true);
      const updatedText = fs.readFileSync(path.join(rulesDir, 'common.md'), 'utf-8');
      expect(updatedText).toBe(
        '# Section 1\nUpdated content line 1.\nUpdated content line 2.\n\n# Section 2\nContent 2.\n'
      );
    });

    it('places nested child subsection after parent and its descendants, before next root section', () => {
      const initialCommon = [
        '# Section A',
        'Content A.',
        '',
        '## Subsection A.1',
        'Content A.1.',
        '',
        '# Section B',
        'Content B.',
        '',
      ].join('\n');
      safeWriteFile(path.join(rulesDir, 'common.md'), initialCommon);

      const childChunk: MarkdownChunk = {
        header: 'Subsection A.2',
        level: 2,
        path: ['Section A', 'Subsection A.2'],
        content: 'Content A.2.',
        raw: '## Subsection A.2\nContent A.2.\n',
        normalizedHash: 'ghi',
        codeBlocks: [],
      };

      const res = promoteChunk(childChunk, {
        hubDir,
        homeDir,
        targetRuleFile: 'common.md',
        reproject: false,
      });

      expect(res.success).toBe(true);
      const updatedText = fs.readFileSync(path.join(rulesDir, 'common.md'), 'utf-8');
      const chunks = parseMarkdownChunks(updatedText);

      expect(chunks.map((c) => c.header)).toEqual([
        'Section A',
        'Subsection A.1',
        'Subsection A.2',
        'Section B',
      ]);
      expect(updatedText).not.toContain('\n\n\n');
      expect(updatedText).toContain('## Subsection A.2\nContent A.2.\n\n# Section B');
    });

    it('places child subsection immediately after parent when parent has no existing descendants', () => {
      const initialCommon = [
        '# Section A',
        'Content A.',
        '',
        '# Section B',
        'Content B.',
        '',
      ].join('\n');
      safeWriteFile(path.join(rulesDir, 'common.md'), initialCommon);

      const childChunk: MarkdownChunk = {
        header: 'Subsection A.1',
        level: 2,
        path: ['Section A', 'Subsection A.1'],
        content: 'Content A.1.',
        raw: '## Subsection A.1\nContent A.1.\n',
        normalizedHash: 'jkl',
        codeBlocks: [],
      };

      const res = promoteChunk(childChunk, {
        hubDir,
        homeDir,
        targetRuleFile: 'common.md',
        reproject: false,
      });

      expect(res.success).toBe(true);
      const updatedText = fs.readFileSync(path.join(rulesDir, 'common.md'), 'utf-8');
      const chunks = parseMarkdownChunks(updatedText);

      expect(chunks.map((c) => c.header)).toEqual([
        'Section A',
        'Subsection A.1',
        'Section B',
      ]);
    });

    it('correctly inserts deeply nested siblings', () => {
      const initialCommon = [
        '# Architecture',
        'Root overview.',
        '',
        '## Backend',
        'Backend guidelines.',
        '',
        '### Database',
        'DB guidelines.',
        '',
        '#### Migrations',
        'Run migrations safely.',
        '',
        '## Frontend',
        'Frontend guidelines.',
        '',
      ].join('\n');
      safeWriteFile(path.join(rulesDir, 'common.md'), initialCommon);

      const siblingChunk: MarkdownChunk = {
        header: 'Seeding',
        level: 4,
        path: ['Architecture', 'Backend', 'Database', 'Seeding'],
        content: 'Seed only idempotent fixtures.',
        raw: '#### Seeding\nSeed only idempotent fixtures.\n',
        normalizedHash: 'mno',
        codeBlocks: [],
      };

      const res = promoteChunk(siblingChunk, {
        hubDir,
        homeDir,
        targetRuleFile: 'common.md',
        reproject: false,
      });

      expect(res.success).toBe(true);
      const updatedText = fs.readFileSync(path.join(rulesDir, 'common.md'), 'utf-8');
      const chunks = parseMarkdownChunks(updatedText);

      expect(chunks.map((c) => c.header)).toEqual([
        'Architecture',
        'Backend',
        'Database',
        'Migrations',
        'Seeding',
        'Frontend',
      ]);
    });

    it('prevents path traversal and returns success: false with informative message', () => {
      const chunk: MarkdownChunk = {
        header: 'Hacked Rule',
        level: 1,
        path: ['Hacked Rule'],
        content: 'Malicious content',
        raw: '# Hacked Rule\nMalicious content\n',
        normalizedHash: 'pqr',
        codeBlocks: [],
      };

      // Relative path escaping rulesDir
      const res1 = promoteChunk(chunk, {
        hubDir,
        homeDir,
        targetRuleFile: '../../escaped.md',
        reproject: false,
      });

      expect(res1.success).toBe(false);
      expect(res1.message).toContain('Target file must reside inside hub rules directory');
      expect(fs.existsSync(path.join(tmpDir, 'escaped.md'))).toBe(false);

      // Absolute path escaping rulesDir
      const absEscape = path.resolve(tmpDir, 'other', 'escaped.md');
      const res2 = promoteChunk(chunk, {
        hubDir,
        homeDir,
        targetRuleFile: absEscape,
        reproject: false,
      });

      expect(res2.success).toBe(false);
      expect(res2.message).toContain('Target file must reside inside hub rules directory');
    });

    it('promotes chunk into a subfolder like overrides/custom.md and appends .md if missing', () => {
      const chunk: MarkdownChunk = {
        header: 'Special Override',
        level: 1,
        path: ['Special Override'],
        content: 'Override details.',
        raw: '# Special Override\nOverride details.\n',
        normalizedHash: 'stu',
        codeBlocks: [],
      };

      // Without .md extension
      const res = promoteChunk(chunk, {
        hubDir,
        homeDir,
        targetRuleFile: 'overrides/custom',
        reproject: false,
      });

      expect(res.success).toBe(true);
      expect(res.message).toBe("Promoted rule 'Special Override' into overrides/custom.md");

      const targetFile = path.join(rulesDir, 'overrides', 'custom.md');
      expect(fs.existsSync(targetFile)).toBe(true);
      expect(fs.readFileSync(targetFile, 'utf-8')).toBe(
        '# Special Override\nOverride details.\n'
      );
    });

    it('falls back to appending root section when chunk path parent is not found', () => {
      const initialCommon = '# Existing Root\nExisting content.\n';
      safeWriteFile(path.join(rulesDir, 'common.md'), initialCommon);

      const orphanChild: MarkdownChunk = {
        header: 'Orphan Child',
        level: 2,
        path: ['NonExistentParent', 'Orphan Child'],
        content: 'Orphan content.',
        raw: '## Orphan Child\nOrphan content.\n',
        normalizedHash: 'vwx',
        codeBlocks: [],
      };

      const res = promoteChunk(orphanChild, {
        hubDir,
        homeDir,
        targetRuleFile: 'common.md',
        reproject: false,
      });

      expect(res.success).toBe(true);
      const updatedText = fs.readFileSync(path.join(rulesDir, 'common.md'), 'utf-8');
      expect(updatedText).toBe(
        '# Existing Root\nExisting content.\n\n## Orphan Child\nOrphan content.\n'
      );
    });
  });
});
