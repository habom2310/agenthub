import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setCustomHome } from '../src/core/detector.js';
import { EXPORT_TARGETS, exportRules } from '../src/core/exporter.js';
import { ensureDir, safeWriteFile } from '../src/utils/fs.js';

describe('exporter', () => {
  let tmpDir: string;
  let homeDir: string;
  let hubDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-exporter-test-'));
    homeDir = path.join(tmpDir, 'home');
    hubDir = path.join(tmpDir, 'hub');
    ensureDir(homeDir);
    ensureDir(hubDir);
    setCustomHome(homeDir, hubDir);

    // Setup basic rules in hub
    safeWriteFile(path.join(hubDir, 'rules', 'common.md'), '# Core Rules\nCommon rule text.');
    safeWriteFile(
      path.join(hubDir, 'rules', 'code-tools.md'),
      '# Code Tools\nCode tool guidelines.'
    );
    safeWriteFile(path.join(hubDir, 'rules', 'handoffs.md'), '# Handoffs\nHandoff procedures.');
    safeWriteFile(
      path.join(hubDir, 'rules', 'overrides', 'codex.md'),
      '# Codex Override\nCodex instructions.'
    );
    safeWriteFile(
      path.join(hubDir, 'rules', 'overrides', 'claude.md'),
      '# Claude Override\nClaude instructions.'
    );
    safeWriteFile(
      path.join(hubDir, 'rules', 'overrides', 'cursor.md'),
      '# Cursor Override\nCursor instructions.'
    );
  });

  afterEach(() => {
    setCustomHome(null, null);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe('EXPORT_TARGETS constant', () => {
    it('defines configurations for chatgpt, claude, and cursor', () => {
      expect(EXPORT_TARGETS.chatgpt).toBeDefined();
      expect(EXPORT_TARGETS.claude).toBeDefined();
      expect(EXPORT_TARGETS.cursor).toBeDefined();

      expect(EXPORT_TARGETS.chatgpt.title).toContain('ChatGPT');
      expect(EXPORT_TARGETS.claude.title).toContain('Claude');
      expect(EXPORT_TARGETS.cursor.title).toContain('Cursor');
    });
  });

  describe('exportRules for standard targets', () => {
    it('exports rules for chatgpt to default destination', () => {
      const res = exportRules('chatgpt', { hubDir });
      expect(res.ok).toBe(true);

      const expectedDest = path.join(hubDir, 'export', 'chatgpt_custom_instructions.md');
      expect(res.destination).toBe(expectedDest);
      expect(fs.existsSync(expectedDest)).toBe(true);

      const fileContent = fs.readFileSync(expectedDest, 'utf-8');
      expect(fileContent).toBe(res.content);
      expect(res.content).toContain('ChatGPT Custom Instructions');
      expect(res.content).toContain('# Multi-Agent Guidelines & Operational Heuristics');
      expect(res.content).toContain('Common rule text.');
      expect(res.content).toContain('Code tool guidelines.');
      expect(res.content).toContain('Handoff procedures.');
      expect(res.content).toContain('Codex instructions.');
    });

    it('exports rules for claude to default destination', () => {
      const res = exportRules('claude', { hubDir });
      expect(res.ok).toBe(true);

      const expectedDest = path.join(hubDir, 'export', 'claude_project_instructions.md');
      expect(res.destination).toBe(expectedDest);
      expect(fs.existsSync(expectedDest)).toBe(true);

      expect(res.content).toContain('Claude Web Project System Instructions');
      expect(res.content).toContain('Claude instructions.');
    });

    it('exports rules for cursor to default destination', () => {
      const res = exportRules('cursor', { hubDir });
      expect(res.ok).toBe(true);

      const expectedDest = path.join(hubDir, 'export', 'cursor_rules_export.md');
      expect(res.destination).toBe(expectedDest);
      expect(fs.existsSync(expectedDest)).toBe(true);

      expect(res.content).toContain('Cursor .cursorrules Export');
      expect(res.content).toContain('Cursor instructions.');
    });

    it('handles case-insensitive target naming', () => {
      const res = exportRules('ChatGPT', { stdout: true, hubDir });
      expect(res.ok).toBe(true);
      expect(res.content).toContain('ChatGPT Custom Instructions');
    });
  });

  describe('export options', () => {
    it('writes to custom output path when output option is specified', () => {
      const customPath = path.join(tmpDir, 'custom-dir', 'exported_rules.md');
      const res = exportRules('chatgpt', { output: customPath, hubDir });

      expect(res.ok).toBe(true);
      expect(res.destination).toBe(path.resolve(customPath));
      expect(fs.existsSync(customPath)).toBe(true);
      expect(fs.readFileSync(customPath, 'utf-8')).toBe(res.content);
    });

    it('does not write file when stdout is true and no output is specified', () => {
      const res = exportRules('chatgpt', { stdout: true, hubDir });

      expect(res.ok).toBe(true);
      expect(res.destination).toBeNull();

      const exportDir = path.join(hubDir, 'export');
      expect(fs.existsSync(exportDir)).toBe(false);
    });

    it('defaults to getHubDir when hubDir is not provided', () => {
      const res = exportRules('claude');
      expect(res.ok).toBe(true);
      expect(res.destination).toBe(path.join(hubDir, 'export', 'claude_project_instructions.md'));
    });
  });

  describe('error handling and edge cases', () => {
    it('rejects unsupported targets with supported targets list', () => {
      const res = exportRules('unknown-assistant');
      expect(res.ok).toBe(false);
      expect(res.destination).toBeNull();
      expect(res.content).toContain("Unsupported export target 'unknown-assistant'");
      expect(res.content).toContain('chatgpt');
      expect(res.content).toContain('claude');
      expect(res.content).toContain('cursor');
    });

    it('tolerates missing rule files and exports available ones with header', () => {
      const emptyHub = path.join(tmpDir, 'empty-hub');
      ensureDir(emptyHub);

      const res = exportRules('cursor', { stdout: true, hubDir: emptyHub });
      expect(res.ok).toBe(true);
      expect(res.content).toContain('Cursor .cursorrules Export');
      expect(res.content).toContain('# Multi-Agent Guidelines & Operational Heuristics');
    });
  });
});
