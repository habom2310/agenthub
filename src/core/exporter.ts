import fs from 'node:fs';
import path from 'node:path';
import { safeWriteFile } from '../utils/fs.js';
import { getHubDir } from './detector.js';
import { getAddonRuleFiles } from './projector.js';

export interface ExportTargetConfig {
  title: string;
  overrides_file: string;
  default_filename: string;
}

export interface ExportResult {
  ok: boolean;
  content: string;
  destination: string | null;
}

export const EXPORT_TARGETS: Record<string, ExportTargetConfig> = {
  chatgpt: {
    title: 'ChatGPT Custom Instructions & Project System Prompt',
    overrides_file: 'overrides/codex.md',
    default_filename: 'chatgpt_custom_instructions.md',
  },
  claude: {
    title: 'Claude Web Project System Instructions',
    overrides_file: 'overrides/claude.md',
    default_filename: 'claude_project_instructions.md',
  },
  cursor: {
    title: 'Cursor .cursorrules Export',
    overrides_file: 'overrides/cursor.md',
    default_filename: 'cursor_rules_export.md',
  },
};

/**
 * Exports concatenated hub rules tailored for third-party platforms.
 */
export function exportRules(
  target: string,
  options?: { output?: string; stdout?: boolean; hubDir?: string }
): ExportResult {
  const normalizedTarget = (target || '').toLowerCase().trim();
  const cfg = EXPORT_TARGETS[normalizedTarget];

  if (!cfg) {
    const supported = Object.keys(EXPORT_TARGETS).join(', ');
    return {
      ok: false,
      content: `Unsupported export target '${target}'. Supported: ${supported}`,
      destination: null,
    };
  }

  const hub = options?.hubDir || getHubDir();
  const header = `<!-- Exported by agenthub for ${cfg.title} -->\n# Multi-Agent Guidelines & Operational Heuristics`;

  const filesToRead = [
    'rules/common.md',
    'rules/code-tools.md',
    'rules/handoffs.md',
    path.join('rules', cfg.overrides_file),
  ];

  const parts: string[] = [header];
  for (const rel of filesToRead) {
    const fullPath = path.join(hub, rel);
    if (fs.existsSync(fullPath)) {
      const text = fs.readFileSync(fullPath, 'utf-8').trim();
      if (text) {
        parts.push(text);
      }
    }
  }

  const addonFiles = getAddonRuleFiles(hub);
  for (const addonFile of addonFiles) {
    const fullPath = path.join(hub, 'rules', addonFile);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      const text = fs.readFileSync(fullPath, 'utf-8').trim();
      if (text) {
        parts.push(text);
      }
    }
  }

  const content = parts.join('\n\n') + '\n';

  let destination: string | null = null;
  if (options?.output) {
    destination = path.resolve(options.output);
    safeWriteFile(destination, content);
  } else if (!options?.stdout) {
    destination = path.join(hub, 'export', cfg.default_filename);
    safeWriteFile(destination, content);
  }

  return {
    ok: true,
    content,
    destination,
  };
}
