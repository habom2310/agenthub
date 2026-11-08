import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { safeWriteFile } from '../utils/fs.js';
import { byCodeUnit } from '../utils/sort.js';
import { stateFile } from './state.js';
import type { SourceKind } from './sources.js';

/** A command the hub declares, identified for approval by item and the exact text. */
export interface CommandRef {
  kind: SourceKind;
  item: string;
  /** What the command is for: check, install, build, fetch, probe */
  role: string;
  text: string;
}

export interface ApprovalEntry {
  kind: SourceKind;
  item: string;
  role: string;
  sha256: string;
  command: string;
}

/** Machine-local, gitignored: what this machine's user has approved to run. */
export function approvalsPath(hub: string): string {
  return stateFile(hub, 'approvals.json');
}

export const commandHash = (text: string): string => createHash('sha256').update(text).digest('hex');

const keyOf = (e: { kind: string; item: string; role: string }): string => `${e.kind}\0${e.item}\0${e.role}`;
const byKey = (a: ApprovalEntry, b: ApprovalEntry): number => byCodeUnit(keyOf(a), keyOf(b));

export function loadApprovals(hub: string): ApprovalEntry[] {
  try {
    const list = JSON.parse(fs.readFileSync(approvalsPath(hub), 'utf-8'))?.approved;
    if (!Array.isArray(list)) return [];
    return list.filter(
      (e): e is ApprovalEntry =>
        e &&
        (e.kind === 'skills' || e.kind === 'mcp') &&
        [e.item, e.role, e.sha256, e.command].every((v) => typeof v === 'string') &&
        // an entry that does not match its own command was edited by hand or by someone else
        e.sha256 === commandHash(e.command)
    );
  } catch {
    return [];
  }
}

export function isApproved(list: ApprovalEntry[], ref: CommandRef): boolean {
  const sha = commandHash(ref.text);
  return list.some((e) => keyOf(e) === keyOf(ref) && e.sha256 === sha);
}

/** Records approvals; a changed command replaces the earlier approval of the same item and role. */
export function recordApprovals(hub: string, refs: CommandRef[]): void {
  if (refs.length === 0) return;
  const fresh = refs.map((r): ApprovalEntry => ({ kind: r.kind, item: r.item, role: r.role, sha256: commandHash(r.text), command: r.text }));
  const kept = loadApprovals(hub).filter((e) => !fresh.some((f) => keyOf(e) === keyOf(f)));
  safeWriteFile(approvalsPath(hub), JSON.stringify({ version: 1, approved: [...kept, ...fresh].sort(byKey) }, null, 2) + '\n');
}

/** Forgets every approval. Returns how many there were. */
export function resetApprovals(hub: string): number {
  const count = loadApprovals(hub).length;
  fs.rmSync(approvalsPath(hub), { force: true });
  return count;
}
