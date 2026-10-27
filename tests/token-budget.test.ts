import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setCustomHome } from '../src/core/detector.js';
import {
  auditTokenBudget,
  ESTIMATED_CHARS_PER_TOKEN,
  estimateTokens,
  TARGET_BUDGET,
} from '../src/core/token-budget.js';
import { ensureDir, safeWriteFile } from '../src/utils/fs.js';

describe('token-budget', () => {
  let tmpDir: string;
  let homeDir: string;
  let hubDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-budget-test-'));
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

  describe('estimateTokens', () => {
    it('estimates token count from character count (number)', () => {
      expect(estimateTokens(100)).toBe(25);
      expect(estimateTokens(0)).toBe(0);
      expect(estimateTokens(-10)).toBe(0);
      expect(estimateTokens(7)).toBe(1);
      expect(estimateTokens(8)).toBe(2);
    });

    it('estimates token count from string content', () => {
      expect(estimateTokens('abcd')).toBe(1);
      expect(estimateTokens('12345678')).toBe(2);
      expect(estimateTokens('  12345678  ')).toBe(2); // trims input
      expect(estimateTokens('')).toBe(0);
      expect(estimateTokens('   ')).toBe(0);
    });

    it('uses ESTIMATED_CHARS_PER_TOKEN = 4.0 and TARGET_BUDGET = 2000', () => {
      expect(ESTIMATED_CHARS_PER_TOKEN).toBe(4.0);
      expect(TARGET_BUDGET).toBe(2000);
    });
  });

  describe('auditTokenBudget with lean rules', () => {
    it('reports PASS (LEAN) when rules and skills are well within budget', () => {
      // Setup lean rules (approx 400 chars each = ~1200 chars = ~300 tokens)
      safeWriteFile(path.join(hubDir, 'rules', 'common.md'), 'a'.repeat(400));
      safeWriteFile(path.join(hubDir, 'rules', 'code-tools.md'), 'b'.repeat(400));
      safeWriteFile(path.join(hubDir, 'rules', 'handoffs.md'), 'c'.repeat(400));

      // Setup 2 skills
      const skill1Dir = path.join(hubDir, 'skills', 'skill-one');
      safeWriteFile(
        path.join(skill1Dir, 'SKILL.md'),
        '---\nname: skill-one\ndescription: First helpful skill\n---\n# Docs'
      );

      const skill2Dir = path.join(hubDir, 'skills', 'skill-two');
      safeWriteFile(
        path.join(skill2Dir, 'SKILL.md'),
        '---\nname: skill-two\ndescription: Second helpful skill\n---\n# Docs'
      );

      const report = auditTokenBudget(hubDir);

      expect(report.core_rules_tokens).toBe(300); // 1200 / 4
      expect(report.skills_count).toBe(2);
      expect(report.skills_registry_tokens).toBeGreaterThan(0);
      expect(report.total_boot_tokens).toBeLessThan(TARGET_BUDGET);
      expect(report.budget).toBe(TARGET_BUDGET);
      expect(report.status).toBe('PASS (LEAN)');
    });

    it('handles empty hub gracefully', () => {
      const report = auditTokenBudget(hubDir);

      expect(report.core_rules_tokens).toBe(0);
      expect(report.skills_count).toBe(0);
      expect(report.skills_registry_tokens).toBe(0);
      expect(report.total_boot_tokens).toBe(0);
      expect(report.budget).toBe(TARGET_BUDGET);
      expect(report.status).toBe('PASS (LEAN)');
    });

    it('defaults to getHubDir() when no argument is supplied', () => {
      safeWriteFile(path.join(hubDir, 'rules', 'common.md'), 'a'.repeat(100));
      const report = auditTokenBudget();
      expect(report.core_rules_tokens).toBe(25);
    });
  });

  describe('auditTokenBudget with oversized content', () => {
    it('reports EXCEEDED when rules or skills breach TARGET_BUDGET', () => {
      // Create bulky rules: 9,000 characters = 2,250 tokens (> 2,000)
      safeWriteFile(path.join(hubDir, 'rules', 'common.md'), 'x'.repeat(9000));

      const report = auditTokenBudget(hubDir);

      expect(report.core_rules_tokens).toBe(2250);
      expect(report.total_boot_tokens).toBe(2250);
      expect(report.status).toBe('EXCEEDED');
    });

    it('reports EXCEEDED when registry text from many skills breaches budget', () => {
      safeWriteFile(path.join(hubDir, 'rules', 'common.md'), 'x'.repeat(4000)); // 1000 tokens

      // Add a skill with a huge description (4,500 chars = 1,125 tokens)
      const bigSkillDir = path.join(hubDir, 'skills', 'verbose-skill');
      safeWriteFile(
        path.join(bigSkillDir, 'SKILL.md'),
        `---\nname: verbose-skill\ndescription: ${'y'.repeat(4500)}\n---\n# Big Skill`
      );

      const report = auditTokenBudget(hubDir);

      expect(report.core_rules_tokens).toBe(1000);
      expect(report.skills_count).toBe(1);
      expect(report.skills_registry_tokens).toBeGreaterThanOrEqual(1125);
      expect(report.total_boot_tokens).toBeGreaterThan(TARGET_BUDGET);
      expect(report.status).toBe('EXCEEDED');
    });
  });

  describe('auditTokenBudget with addon rules', () => {
    it('counts addon rules tokens and adds them to total_boot_tokens', () => {
      // 400 chars core = 100 tokens
      safeWriteFile(path.join(hubDir, 'rules', 'common.md'), 'a'.repeat(400));

      // 2 addon files: 400 chars each = 800 chars = 200 tokens
      safeWriteFile(path.join(hubDir, 'rules', 'addons', 'security.md'), 's'.repeat(400));
      safeWriteFile(path.join(hubDir, 'rules', 'addons', 'testing.md'), 't'.repeat(400));

      const report = auditTokenBudget(hubDir);

      expect(report.core_rules_tokens).toBe(100);
      expect(report.addons_rules_tokens).toBe(200);
      expect(report.total_boot_tokens).toBe(300);
      expect(report.status).toBe('PASS (LEAN)');
    });

    it('reports EXCEEDED when addon rules push total over TARGET_BUDGET', () => {
      // 400 chars core = 100 tokens
      safeWriteFile(path.join(hubDir, 'rules', 'common.md'), 'a'.repeat(400));

      // Addon with 8,000 chars = 2,000 tokens (total 2,100 tokens > 2,000)
      safeWriteFile(path.join(hubDir, 'rules', 'addons', 'bloated.md'), 'z'.repeat(8000));

      const report = auditTokenBudget(hubDir);

      expect(report.core_rules_tokens).toBe(100);
      expect(report.addons_rules_tokens).toBe(2000);
      expect(report.total_boot_tokens).toBe(2100);
      expect(report.status).toBe('EXCEEDED');
    });

    it('ignores non-markdown or hidden files in rules/addons', () => {
      safeWriteFile(path.join(hubDir, 'rules', 'addons', 'security.md'), 's'.repeat(400)); // 100 tokens
      safeWriteFile(path.join(hubDir, 'rules', 'addons', '.hidden.md'), 'h'.repeat(400));
      safeWriteFile(path.join(hubDir, 'rules', 'addons', 'notes.txt'), 'n'.repeat(400));

      const report = auditTokenBudget(hubDir);
      expect(report.addons_rules_tokens).toBe(100);
    });
  });
});
