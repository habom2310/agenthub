import fs from 'node:fs';
import path from 'node:path';
import { getHubDir } from './detector.js';
import { parseFrontmatter } from './projector.js';

export interface BudgetAuditResult {
  core_rules_tokens: number;
  skills_count: number;
  skills_registry_tokens: number;
  total_boot_tokens: number;
  budget: number;
  status: 'PASS (LEAN)' | 'EXCEEDED';
}

export const ESTIMATED_CHARS_PER_TOKEN = 4.0;
export const TARGET_BUDGET = 2000;

/**
 * Estimates token count for a given text string or character length.
 */
export function estimateTokens(textOrChars: string | number): number {
  if (typeof textOrChars === 'number') {
    return Math.max(0, Math.floor(textOrChars / ESTIMATED_CHARS_PER_TOKEN));
  }
  return Math.max(0, Math.floor(textOrChars.trim().length / ESTIMATED_CHARS_PER_TOKEN));
}

/**
 * Audits the token overhead of hub rules and skills registry against the boot budget.
 */
export function auditTokenBudget(hubDir?: string): BudgetAuditResult {
  const hub = hubDir || getHubDir();

  // Core rules tokens
  let coreChars = 0;
  const coreRuleFiles = ['rules/common.md', 'rules/code-tools.md', 'rules/handoffs.md'];
  for (const rel of coreRuleFiles) {
    const fullPath = path.join(hub, rel);
    if (fs.existsSync(fullPath)) {
      const text = fs.readFileSync(fullPath, 'utf-8');
      coreChars += text.trim().length;
    }
  }
  const core_rules_tokens = estimateTokens(coreChars);

  // Skills registry tokens
  const skillsDir = path.join(hub, 'skills');
  let skillsCount = 0;
  let skillsChars = 0;

  if (fs.existsSync(skillsDir) && fs.statSync(skillsDir).isDirectory()) {
    const entries = fs.readdirSync(skillsDir);
    for (const entry of entries) {
      const skillFolder = path.join(skillsDir, entry);
      try {
        if (!fs.statSync(skillFolder).isDirectory()) continue;
      } catch {
        continue;
      }
      const skillMd = path.join(skillFolder, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;

      skillsCount++;
      const content = fs.readFileSync(skillMd, 'utf-8');
      const { meta } = parseFrontmatter(content);
      const name = meta.name || entry;
      const description = meta.description || '';
      const registryText = `${name}: ${description}`.trim();
      skillsChars += registryText.length;
    }
  }

  const skills_registry_tokens = estimateTokens(skillsChars);
  const total_boot_tokens = core_rules_tokens + skills_registry_tokens;
  const status: 'PASS (LEAN)' | 'EXCEEDED' =
    total_boot_tokens <= TARGET_BUDGET ? 'PASS (LEAN)' : 'EXCEEDED';

  return {
    core_rules_tokens,
    skills_count: skillsCount,
    skills_registry_tokens,
    total_boot_tokens,
    budget: TARGET_BUDGET,
    status,
  };
}
