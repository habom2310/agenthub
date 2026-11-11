import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { connectPlatform } from '../src/core/connector.js';
import { setCustomHome, SKILL_PLATFORMS } from '../src/core/detector.js';
import { runDoctor } from '../src/core/doctor.js';
import { skillItems } from '../src/core/doctor-full.js';
import { gitInitHub, ignoreMachineSpecificSkills } from '../src/core/git-sync.js';
import { linkSkillsForAllAssistants, linkSkillsForClaude, linkSkillsForCodex, skillsProvider } from '../src/core/linker.js';
import { uninstallHub } from '../src/core/uninstaller.js';
import { createJunction, ensureDir, isJunctionOrSymlink, safeWriteFile } from '../src/utils/fs.js';

describe('~/.agents/skills, the cross-agent skills folder', () => {
  let tmp: string;
  let home: string;
  let hub: string;
  const skill = (dir: string, name: string) => safeWriteFile(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n`);
  const agents = () => path.join(home, '.agents', 'skills');
  const isHubLink = (p: string) => isJunctionOrSymlink(p) && fs.realpathSync(p) === fs.realpathSync(path.join(hub, 'skills'));
  const mkdirs = (...dirs: string[]) => dirs.forEach((d) => ensureDir(path.join(home, d)));

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-agents-dir-'));
    home = path.join(tmp, 'home');
    hub = path.join(tmp, 'hub');
    ensureDir(home);
    skill(path.join(hub, 'skills'), 'hub-skill');
    setCustomHome(home, hub);
  });
  afterEach(() => {
    setCustomHome(null, null);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('is not created when no detected assistant needs it', () => {
    mkdirs('.claude', '.cursor', '.copilot', path.join('.codeium', 'windsurf'));
    const res = linkSkillsForAllAssistants({ homeDir: home, hubDir: hub });
    expect(res.agents).toBeUndefined();
    expect(fs.existsSync(path.join(home, '.agents'))).toBe(false);
    // Claude, Windsurf and Copilot keep their own folders; Cursor reads Claude's
    expect(isHubLink(path.join(home, '.claude', 'skills'))).toBe(true);
    expect(isHubLink(path.join(home, '.copilot', 'skills'))).toBe(true);
    expect(isHubLink(path.join(home, '.codeium', 'windsurf', 'skills'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.cursor', 'skills'))).toBe(false);
  });

  it('is created for Codex, which then gets no ~/.codex/skills link', () => {
    mkdirs('.claude', '.codex');
    const res = linkSkillsForAllAssistants({ homeDir: home, hubDir: hub });
    expect(res.agents?.success).toBe(true);
    expect(isHubLink(agents())).toBe(true);
    expect(res.codex?.message).toContain('through');
    expect(fs.existsSync(path.join(home, '.codex', 'skills'))).toBe(false);
  });

  it('is created for Pi alone, and Pi gets no link of its own', () => {
    mkdirs(path.join('.pi', 'agent'));
    const res = linkSkillsForAllAssistants({ homeDir: home, hubDir: hub });
    expect(res.pi?.success).toBe(true);
    expect(isHubLink(agents())).toBe(true);
    expect(fs.existsSync(path.join(home, '.pi', 'agent', 'skills'))).toBe(false);
  });

  it('is not created for an assistant that is not detected', () => {
    mkdirs('.claude');
    linkSkillsForAllAssistants({ homeDir: home, hubDir: hub });
    expect(fs.existsSync(agents())).toBe(false);
  });

  it('migrates a real folder (npx skills installs) into the hub and keeps skills.old', () => {
    mkdirs('.codex');
    skill(agents(), 'from-npx-skills');
    linkSkillsForAllAssistants({ homeDir: home, hubDir: hub });
    expect(isHubLink(agents())).toBe(true);
    expect(fs.existsSync(path.join(hub, 'skills', 'from-npx-skills', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.agents', 'skills.old', 'from-npx-skills', 'SKILL.md'))).toBe(true);
  });

  it('no assistant is linked to the hub through two roots', () => {
    mkdirs('.claude', '.codex', '.cursor', '.copilot', path.join('.codeium', 'windsurf'), path.join('.pi', 'agent'));
    // old links from before ~/.agents/skills was used
    for (const d of [path.join('.codex', 'skills'), path.join('.copilot', 'skills'), path.join('.codeium', 'windsurf', 'skills'), path.join('.cursor', 'skills')]) {
      createJunction(path.join(hub, 'skills'), path.join(home, d));
    }
    linkSkillsForAllAssistants({ homeDir: home, hubDir: hub });

    expect(isHubLink(agents())).toBe(true);
    expect(isHubLink(path.join(home, '.claude', 'skills'))).toBe(true);
    for (const d of [path.join('.codex', 'skills'), path.join('.copilot', 'skills'), path.join('.codeium', 'windsurf', 'skills'), path.join('.cursor', 'skills')]) {
      expect(isJunctionOrSymlink(path.join(home, d))).toBe(false);
    }
    // each assistant's own readers (other than Cursor, which also reads Claude's) resolve each hub skill once
    for (const p of SKILL_PLATFORMS.filter((x) => x.id !== 'claude' && x.id !== 'cursor')) {
      const roots = [p.skillsDir(home), ...p.alsoReads(home)].filter((r) => isHubLink(r));
      expect(roots, p.id).toEqual([agents()]);
    }
    expect(skillsProvider(SKILL_PLATFORMS.find((x) => x.id === 'windsurf')!, home, hub)).toBe(agents());
  });

  it('keeps a real folder of an assistant that reads it', () => {
    mkdirs('.codex', '.copilot');
    skill(path.join(home, '.copilot', 'skills'), 'mine');
    linkSkillsForAllAssistants({ homeDir: home, hubDir: hub });
    expect(isJunctionOrSymlink(path.join(home, '.copilot', 'skills'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.copilot', 'skills', 'mine', 'SKILL.md'))).toBe(true);
  });

  it('doctor passes and reports no duplicates; it fails when the link is gone', () => {
    mkdirs('.claude', '.codex', '.copilot', path.join('.pi', 'agent'));
    safeWriteFile(path.join(hub, 'agenthub.json'), '{"version":"0.1.0","platforms":{}}');
    linkSkillsForAllAssistants({ homeDir: home, hubDir: hub });
    const dry = runDoctor({ homeDir: home, hubDir: hub });
    expect(dry.passed_checks).toEqual(expect.arrayContaining(['Codex skills junction verified', 'Copilot skills provided through ' + agents(), 'Pi skills junction verified']));

    const items = skillItems(home, hub);
    expect(items.filter((i) => i.level === 'FAIL' || i.level === 'WARN')).toEqual([]);
    expect(items.map((i) => i.name)).toEqual(expect.arrayContaining(['Codex skills', 'Pi skills', 'Copilot duplicates']));

    fs.rmSync(agents(), { recursive: true, force: true }); // removes the link, not the hub
    expect(runDoctor({ homeDir: home, hubDir: hub }).issues.some((m) => m.startsWith('Codex skills junction missing'))).toBe(true);
    expect(skillItems(home, hub).some((i) => i.level === 'FAIL' && i.name === 'Codex skills')).toBe(true);

    const fixed = runDoctor({ fix: true, homeDir: home, hubDir: hub });
    expect(fixed.issues.filter((m) => /skills junction/.test(m))).toEqual([]);
    expect(isHubLink(agents())).toBe(true);
  });

  it('doctor warns when an assistant lists a skill twice through its own link and ~/.agents/skills', () => {
    mkdirs('.codex', '.copilot');
    linkSkillsForAllAssistants({ homeDir: home, hubDir: hub });
    createJunction(path.join(hub, 'skills'), path.join(home, '.copilot', 'skills'));
    expect(skillItems(home, hub).some((i) => i.level === 'WARN' && i.name === 'Copilot duplicate hub-skill')).toBe(true);
  });

  describe('the `npx skills` layout: ~/.claude/skills/foo links to ~/.agents/skills/foo', () => {
    const layout = () => {
      mkdirs('.claude', '.codex');
      skill(agents(), 'foo');
      createJunction(path.join(agents(), 'foo'), path.join(home, '.claude', 'skills', 'foo'));
      safeWriteFile(path.join(hub, 'agenthub.json'), '{"version":"0.1.0","platforms":{}}');
      safeWriteFile(path.join(hub, 'rules', 'common.md'), '# Common');
    };
    const expectNoLoop = (hubDir = hub) => {
      const foo = path.join(hubDir, 'skills', 'foo');
      expect(isJunctionOrSymlink(foo)).toBe(false);
      expect(fs.readFileSync(path.join(foo, 'SKILL.md'), 'utf-8')).toContain('name: foo');
      expect(fs.realpathSync(path.join(home, '.claude', 'skills', 'foo', 'SKILL.md'))).toBe(fs.realpathSync(path.join(foo, 'SKILL.md')));
      expect(isHubLink(agents())).toBe(true);
      expect(isHubLink(path.join(home, '.claude', 'skills'))).toBe(true);
    };

    it('doctor --fix copies the content, so nothing loops', () => {
      layout();
      const res = runDoctor({ fix: true, homeDir: home, hubDir: hub });
      expectNoLoop();
      expect(res.repairs.some((r) => r.includes('npx skills'))).toBe(true);
    });

    it('connect claude and connect codex do too', () => {
      layout();
      expect(connectPlatform('claude', undefined, home, hub).success).toBe(true);
      expect(connectPlatform('codex', undefined, home, hub).success).toBe(true);
      expectNoLoop();
    });

    it('linkSkillsForAllAssistants does too', () => {
      layout();
      linkSkillsForAllAssistants({ homeDir: home, hubDir: hub });
      expectNoLoop();
    });

    it('setup does too, and tells the user about the move', async () => {
      hub = path.join(home, '.agenthub'); // where -H puts it
      setCustomHome(home, hub);
      layout();
      const logs: string[] = [];
      safeWriteFile(path.join(hub, 'mcp', 'servers.json'), JSON.stringify({ mcpServers: {} }));
      vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
      await runCli(['-H', home, 'setup', '--yes']);
      vi.restoreAllMocks();
      process.exitCode = undefined;
      expectNoLoop();
      expect(logs.join('\n')).toContain('moved into the hub');
    });

    it('Claude linked first and Codex detected later does not loop either', () => {
      fs.rmSync(path.join(home, '.codex'), { recursive: true, force: true });
      mkdirs('.claude');
      skill(agents(), 'foo');
      createJunction(path.join(agents(), 'foo'), path.join(home, '.claude', 'skills', 'foo'));
      linkSkillsForClaude(home, hub);
      mkdirs('.codex');
      linkSkillsForCodex(home, hub);
      expectNoLoop();
    });

    it('a link to a tool-managed folder stays a link', () => {
      mkdirs('.claude', '.codex');
      const tool = path.join(home, '.local', 'share', 'tool', 'skills', 'bar');
      skill(path.dirname(tool), 'bar');
      createJunction(tool, path.join(home, '.claude', 'skills', 'bar'));
      linkSkillsForAllAssistants({ homeDir: home, hubDir: hub });
      expect(isJunctionOrSymlink(path.join(hub, 'skills', 'bar'))).toBe(true);
      expect(fs.realpathSync(path.join(hub, 'skills', 'bar'))).toBe(fs.realpathSync(tool));
    });

    it('Claude only: a link into a real ~/.agents/skills stays a link, so `npx skills update` still reaches Claude', () => {
      mkdirs('.claude');
      skill(agents(), 'x');
      createJunction(path.join(agents(), 'x'), path.join(home, '.claude', 'skills', 'x'));
      linkSkillsForAllAssistants({ homeDir: home, hubDir: hub });
      expect(isJunctionOrSymlink(agents())).toBe(false);
      const x = path.join(hub, 'skills', 'x');
      expect(isJunctionOrSymlink(x)).toBe(true);
      expect(fs.realpathSync(x)).toBe(fs.realpathSync(path.join(agents(), 'x')));
      // what `npx skills update` does: Claude sees the new version
      fs.writeFileSync(path.join(agents(), 'x', 'SKILL.md'), '---\nname: x\ndescription: v2\n---\n');
      expect(fs.readFileSync(path.join(home, '.claude', 'skills', 'x', 'SKILL.md'), 'utf-8')).toContain('v2');
    });

    it('removes a hub entry that resolves to itself and says so', () => {
      mkdirs('.claude');
      ensureDir(path.join(hub, 'skills'));
      fs.symlinkSync(path.join(hub, 'skills', 'loop'), path.join(hub, 'skills', 'loop'));
      const res = linkSkillsForClaude(home, hub);
      expect(res.success).toBe(true);
      expect(res.message).toContain('resolved to themselves: loop');
      expect(fs.existsSync(path.join(hub, 'skills', 'loop'))).toBe(false);
    });
  });

  it('migrating a real ~/.agents/skills says what changed and keeps its skills out of git until declared', () => {
    mkdirs('.codex');
    skill(agents(), 'foo');
    skill(agents(), 'mine');
    safeWriteFile(path.join(home, '.agents', '.skill-lock.json'), JSON.stringify({ version: 3, skills: { foo: { sourceType: 'github', source: 'a/b' } } }));
    const res = linkSkillsForAllAssistants({ homeDir: home, hubDir: hub });
    expect(res.agents?.message).toContain('moved into the hub');
    expect(res.agents?.message).toContain('npx skills update');
    expect(res.agents?.message).toContain('agenthub adopt');
    // a second run has nothing to migrate and stays quiet
    expect(linkSkillsForAllAssistants({ homeDir: home, hubDir: hub }).agents?.message).not.toContain('moved into the hub');

    expect(gitInitHub(hub).ok).toBe(true);
    const exclude = () => fs.readFileSync(path.join(hub, '.git', 'info', 'exclude'), 'utf-8');
    expect(ignoreMachineSpecificSkills(hub)).toEqual(['skills/foo']);
    expect(exclude()).toContain('/skills/foo');
    expect(exclude()).not.toContain('/skills/mine');

    // declared: it is the hub's, and committed again
    safeWriteFile(path.join(hub, 'agenthub.json'), JSON.stringify({ name: 'h', skills: { foo: 'github:a/b#foo' } }));
    expect(ignoreMachineSpecificSkills(hub)).toEqual([]);
    expect(exclude()).not.toContain('/skills/foo');
  });

  it('a lock name that is not a plain folder name never reaches .git/info/exclude', () => {
    mkdirs('.codex');
    createJunction(path.join(hub, 'skills'), agents()); // `npx skills` writes into the hub
    safeWriteFile(path.join(home, '.agents', '.skill-lock.json'), JSON.stringify({ version: 3, skills: { '!x\n/*': {}, 'ok': {} } }));
    skill(path.join(hub, 'skills'), 'ok');
    gitInitHub(hub);
    expect(ignoreMachineSpecificSkills(hub)).toEqual(['skills/ok']);
    expect(fs.readFileSync(path.join(hub, '.git', 'info', 'exclude'), 'utf-8')).not.toContain('!x');
  });

  it("a hub skill that only shares its name with a lock entry is the hub's own and stays in git", () => {
    mkdirs('.claude');
    safeWriteFile(path.join(home, '.agents', '.skill-lock.json'), JSON.stringify({ version: 3, skills: { pdf: { sourceType: 'github', source: 'a/b' } } }));
    skill(path.join(hub, 'skills'), 'pdf');
    gitInitHub(hub);
    expect(ignoreMachineSpecificSkills(hub)).toEqual([]);
    expect(skillItems(home, hub).some((i) => i.name === 'npx skills copies')).toBe(false);
    // the same folder migrated unchanged from ~/.agents/skills is the `npx skills` copy, and doctor says so
    skill(path.join(home, '.agents', 'skills.old'), 'pdf');
    expect(ignoreMachineSpecificSkills(hub)).toEqual(['skills/pdf']);
    expect(skillItems(home, hub).find((i) => i.name === 'npx skills copies')?.message).toContain('pdf');
    // a different hub folder of that name is the user's own
    fs.appendFileSync(path.join(hub, 'skills', 'pdf', 'SKILL.md'), 'mine\n');
    expect(ignoreMachineSpecificSkills(hub)).toEqual([]);
  });

  describe('skills.old is restored only where agenthub removed a link', () => {
    it('an old Codex hub link gets back only what the hub lacks, so no skill is listed twice', () => {
      mkdirs('.codex');
      // an older agenthub linked ~/.codex/skills to the hub after migrating y into it
      skill(path.join(hub, 'skills'), 'y');
      skill(path.join(home, '.codex', 'skills.old'), 'y');
      ensureDir(path.join(home, '.codex', 'skills.old', '.system'));
      createJunction(path.join(hub, 'skills'), path.join(home, '.codex', 'skills'));
      linkSkillsForAllAssistants({ homeDir: home, hubDir: hub });

      const own = path.join(home, '.codex', 'skills');
      expect(isJunctionOrSymlink(own)).toBe(false);
      expect(fs.existsSync(path.join(own, '.system'))).toBe(true);
      expect(fs.existsSync(path.join(own, 'y'))).toBe(false);
      expect(fs.existsSync(path.join(home, '.codex', 'skills.old', 'y', 'SKILL.md'))).toBe(true);
      expect(skillItems(home, hub).filter((i) => i.name.startsWith('Codex duplicate '))).toEqual([]);
      // Codex still loads its own folder, so doctor sees a copy left there
      skill(own, 'y');
      expect(skillItems(home, hub).some((i) => i.level === 'WARN' && i.name === 'Codex duplicate y')).toBe(true);
    });


    it('a stale skills.old next to a real folder or a missing one is left alone', () => {
      mkdirs('.claude', '.codex', '.cursor');
      ensureDir(path.join(home, '.codex', 'skills', '.system'));
      skill(path.join(home, '.codex', 'skills.old'), 'stale');
      skill(path.join(home, '.claude', 'skills.old'), 'stale');
      skill(path.join(home, '.cursor', 'skills.old'), 'stale');
      linkSkillsForAllAssistants({ homeDir: home, hubDir: hub });
      // Codex's real folder was not replaced by its stale backup, and Cursor (never linked) got nothing either
      expect(fs.existsSync(path.join(home, '.codex', 'skills', '.system'))).toBe(true);
      expect(fs.existsSync(path.join(home, '.codex', 'skills', 'stale'))).toBe(false);
      expect(fs.existsSync(path.join(home, '.cursor', 'skills'))).toBe(false);
      expect(fs.existsSync(path.join(home, '.cursor', 'skills.old'))).toBe(true);
    });

    it('uninstall restores only Cursor, Codex and ~/.agents, and never over something that exists', () => {
      mkdirs('.claude', '.codex', '.copilot');
      skill(path.join(home, '.claude', 'skills.old'), 'stale');
      skill(path.join(home, '.copilot', 'skills.old'), 'stale');
      skill(path.join(home, '.codex', 'skills.old'), 'old-codex');
      ensureDir(path.join(home, '.agents', 'skills'));
      skill(path.join(home, '.agents', 'skills.old'), 'old-agents');
      uninstallHub({ home, hub });
      expect(fs.existsSync(path.join(home, '.claude', 'skills'))).toBe(false);
      expect(fs.existsSync(path.join(home, '.copilot', 'skills'))).toBe(false);
      expect(fs.existsSync(path.join(home, '.codex', 'skills', 'old-codex', 'SKILL.md'))).toBe(true);
      // ~/.agents/skills exists (a real folder), so skills.old stays where it is
      expect(fs.existsSync(path.join(home, '.agents', 'skills.old', 'old-agents', 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(home, '.agents', 'skills', 'old-agents'))).toBe(false);
    });
  });

  it('uninstall removes the link and restores ~/.agents/skills.old', () => {
    mkdirs('.codex');
    skill(agents(), 'from-npx-skills');
    linkSkillsForAllAssistants({ homeDir: home, hubDir: hub });
    expect(isHubLink(agents())).toBe(true);

    const dry = uninstallHub({ home, hub, dryRun: true });
    expect(dry.unlinkedJunctions).toContain(agents());
    expect(isHubLink(agents())).toBe(true);

    const res = uninstallHub({ home, hub });
    expect(res.unlinkedJunctions).toContain(agents());
    expect(isJunctionOrSymlink(agents())).toBe(false);
    expect(fs.existsSync(path.join(agents(), 'from-npx-skills', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(home, '.agents', 'skills.old'))).toBe(false);
  });
});
