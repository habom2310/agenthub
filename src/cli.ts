#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import pc from 'picocolors';
import {
  VERSION,
  auditTokenBudget,
  connectPlatform,
  detectPlatforms,
  actionLabel,
  describePlan,
  detectRuleDrift,
  exportRules,
  getHomeDir,
  getHubDir,
  gitInitHub,
  gitPull,
  gitPush,
  finalizeInstall,
  gitStatus,
  hasDeclaredSources,
  initHub,
  linkSkillsForAllAssistants,
  packageAdd,
  packageInfo,
  planInstall,
  profileCreate,
  profileList,
  profileUse,
  projectAll,
  promoteChunk,
  probeTargets,
  runAdopt,
  runDoctor,
  runFullDoctor,
  runFunctionalChecks,
  countLevels,
  runInstall,
  setCustomHome,
  shareSetup,
  syncMcpServers,
  getMcpStatus,
  uninstallHub,
  updatePins,
  searchRegistry,
  publishToRegistry,
  buildPackagePayload,
  extractRepoShorthand,
  getCleanBaseUrl,
  checkTokenRegistryUrl,
  fetchAuthConfig,
  whoami,
  unpublishFromRegistry,
  getStoredCredential,
  saveCredential,
  deleteCredential,
  resolveToken,
  runDeviceFlow,
  type AdoptItem,
  type AdoptChoice,
  type AdoptPrompter,
  type DoctorItem,
  type MarkdownChunk,
  type PlatformDriftTarget,
  type ScaffoldResult,
} from './index.js';

export function buildCli(): Command {
  const program = new Command();

  program
    .name('agenthub')
    .description('Unified configuration, skills, rules, and MCP management engine for AI coding assistants')
    .version(VERSION, '-v, --version')
    .enablePositionalOptions()
    .option('-H, --home <dir>', 'Sets custom home directory')
    .hook('preAction', (thisCommand, actionCommand) => {
      const rootOpts = program.opts<{ home?: string }>();
      const actionOpts = actionCommand?.opts<{ home?: string }>();
      const home = rootOpts?.home || actionOpts?.home;
      if (home) {
        setCustomHome(path.resolve(home));
      }
    });

  const applyHomeOverride = (opts?: { home?: string }) => {
    const rootOpts = program.opts<{ home?: string }>();
    const home = opts?.home || rootOpts?.home;
    if (home) {
      setCustomHome(path.resolve(home));
    }
  };

  // Tokens must not travel over plain http or to arbitrary hosts.
  const registryAllowed = (registryUrl?: string): boolean => {
    const error = checkTokenRegistryUrl(registryUrl);
    if (error) {
      console.error(pc.red(`✗ ${error}`));
      process.exitCode = 1;
    }
    return !error;
  };

  const withLoginHint = (message: string | undefined, status?: number): string =>
    status === 401 ? `${message} Run: agenthub login` : `${message}`;

  function promptConfirm(question: string): Promise<boolean> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    return new Promise((resolve) => {
      rl.question(question, (answer) => {
        rl.close();
        const trimmed = answer.trim().toLowerCase();
        resolve(trimmed === 'y' || trimmed === 'yes');
      });
    });
  }

  // Lists what will run beyond the install plan (MCP servers started to verify them) and
  // asks once. --yes is explicit consent; without a TTY there is nobody to ask.
  async function consentToProbe(options: { yes?: boolean }, planCount: number): Promise<boolean> {
    const targets = probeTargets(getHomeDir(), getHubDir());
    if (targets.length > 0 && (options.yes || process.stdin.isTTY)) {
      console.log(pc.bold(`Will start to verify (${targets.length}):`));
      for (const line of targets) console.log(`  ${line}`);
    }
    if (planCount + targets.length === 0) return Boolean(options.yes);
    if (options.yes) return true;
    if (!process.stdin.isTTY) return false;
    const what = [planCount ? `${planCount} install item(s)` : '', targets.length ? `${targets.length} server(s) to start` : ''].filter(Boolean).join(' and ');
    return promptConfirm(`Run ${what}? [y/N] `);
  }

  // Plans, confirms once, installs declared skills/MCP servers, then links and syncs.
  // Returns blockers (empty when everything is installed) and whether the user
  // approved running hub-declared commands (--yes, or a "y" at the prompt).
  // With probe, the commands that setup/pull will start to verify MCP servers are
  // listed after the plan and covered by the same consent.
  async function runInstallFlow(
    options: { yes?: boolean },
    flow: { probe?: boolean; pendingIsBlocker?: boolean } = {}
  ): Promise<{ blockers: string[]; approved: boolean }> {
    const hub = getHubDir();
    const home = getHomeDir();
    const blockers: string[] = [];
    const plan = await planInstall(hub);

    for (const e of plan.errors) {
      console.error(pc.red(`✗ ${e.item}: ${e.message}`));
      blockers.push(`${e.item}: ${e.message}`);
    }
    for (const w of plan.warnings) {
      console.log(pc.yellow(`  ⚠ ${w}`));
    }

    let installedCount = 0;
    let declined = false;
    if (plan.actions.length > 0) {
      console.log(pc.bold(`Install plan (${plan.actions.length}):`));
      for (const line of describePlan(plan)) console.log(`  ${line}`);
    }
    const approved = flow.probe
      ? await consentToProbe(options, plan.actions.length)
      : plan.actions.length === 0
        ? Boolean(options.yes)
        : Boolean(options.yes) || (Boolean(process.stdin.isTTY) && (await promptConfirm(`Run these ${plan.actions.length} item(s)? [y/N] `)));

    if (plan.actions.length > 0) {
      if (approved) {
        const result = runInstall(plan);
        installedCount = result.installed.length;
        for (const item of result.installed) console.log(pc.green(`✓ Installed ${item}`));
        for (const f of result.failed) {
          console.error(pc.red(`✗ ${f.item}: ${f.message}`));
          blockers.push(`${f.item}: ${f.message}`);
        }
      } else {
        const why = process.stdin.isTTY ? 'declined' : 'no TTY, re-run with --yes';
        declined = true;
        console.log(pc.yellow(`${plan.actions.length} install step(s) pending (${why}).`));
        if (flow.pendingIsBlocker !== false) blockers.push(`${plan.actions.length} install step(s) pending (${why})`);
        for (const p of finalizeInstall(hub, plan.actions.map(actionLabel))) blockers.push(`${p.item}: ${p.message}`);
      }
    } else {
      for (const p of runInstall(plan).failed) {
        console.error(pc.red(`✗ ${p.item}: ${p.message}`));
        blockers.push(`${p.item}: ${p.message}`);
      }
    }

    linkSkillsForAllAssistants({ homeDir: home, hubDir: hub });
    syncMcpServers({ homeDir: home, hubDir: hub });
    if (blockers.length === 0 && !declined) {
      console.log(pc.green(`✓ Skills and MCP servers are installed${installedCount ? ` (${installedCount} new)` : ''}`));
    }
    return { blockers, approved };
  }

  const LEVEL_TAG: Record<DoctorItem['level'], string> = {
    PASS: pc.green('[PASS]'),
    WARN: pc.yellow('[WARN]'),
    FAIL: pc.red('[FAIL]'),
  };
  const GROUP_TITLE: Record<DoctorItem['group'], string> = {
    setup: 'Setup',
    skills: 'Skills',
    sources: 'Declared sources',
    mcp: 'MCP servers',
  };

  // onlyProblems hides passing items except MCP probes, whose tool counts are worth seeing
  function printItems(items: DoctorItem[], onlyProblems = false): void {
    for (const group of ['setup', 'skills', 'sources', 'mcp'] as const) {
      const rows = items.filter((i) => i.group === group && (!onlyProblems || i.level !== 'PASS' || group === 'mcp'));
      if (rows.length === 0) continue;
      console.log(pc.bold(`${GROUP_TITLE[group]}:`));
      for (const i of rows) {
        console.log(`  ${LEVEL_TAG[i.level]} ${i.name === i.message ? i.message : `${i.name}: ${i.message}`}`);
      }
    }
  }

  // Skill and source checks after setup/pull. The MCP probes and custom checks start
  // what the hub declares, so they need approval (--yes or an accepted install prompt).
  async function runPostChecks(approved: boolean): Promise<void> {
    const hubHasServers = Object.keys(getMcpStatus().hub.servers).length > 0;
    const items = await runFunctionalChecks({ functional: approved, clientVersion: VERSION });
    if (items.length === 0 && !hubHasServers) return;
    console.log(pc.bold('\nFunctional checks:'));
    printItems(items, true);
    const counts = countLevels(items);
    console.log(`  ${pc.green('✓')} ${counts.PASS} passed${counts.WARN ? `, ${counts.WARN} warning(s)` : ''}${counts.FAIL ? `, ${counts.FAIL} failed` : ''}`);
    if (!approved && hubHasServers) {
      console.log(pc.dim('  MCP servers were not started: run ') + pc.cyan('agenthub doctor') + pc.dim(' (or re-run with --yes) to probe them.'));
    }
    if (counts.FAIL > 0) process.exitCode = 1;
  }

  // adopt: scan, then ask per item (TTY), apply confident ones (--yes), or just print
  function describeItem(item: AdoptItem): void {
    const tag = item.kind === 'skills' ? 'skill' : 'mcp';
    const p = item.proposal ?? item.selfBuilt;
    const status = item.report && !p ? pc.dim(item.report) : p ? `${p.label} ${p.confident ? pc.green('(confident)') : pc.yellow('(needs your input)')}` : '';
    console.log(`  ${pc.bold(`${tag} ${item.name}`)}  ${status}`);
    for (const f of item.found) console.log(pc.dim(`      found: ${f}`));
    if (item.report && p) console.log(pc.dim(`      ${item.report}`));
    if (p?.note) console.log(pc.dim(`      ${p.note}`));
    if (item.selfBuilt && item.proposal) console.log(pc.dim(`      or self-built: move it into the hub as "local"`));
  }

  function proposedDeclarations(items: AdoptItem[]): string {
    const out: Record<string, Record<string, unknown>> = {};
    for (const item of items) {
      const p = item.proposal ?? item.selfBuilt;
      if (!p) continue;
      (out[item.kind] ??= {})[item.name] = p.spec;
    }
    return JSON.stringify(out, null, 2);
  }

  function makePrompter(): { prompter: AdoptPrompter; close: () => void } {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const lines = rl[Symbol.asyncIterator]();
    const ask = async (q: string): Promise<string> => {
      process.stdout.write(q);
      const next = await lines.next();
      return next.done ? '' : String(next.value);
    };
    const prompter: AdoptPrompter = {
      ask,
      async choose(item: AdoptItem, choices: AdoptChoice[]): Promise<AdoptChoice> {
        console.log('');
        describeItem(item);
        const keys: Record<AdoptChoice, string> = { accept: 'a', 'self-built': 'm', source: 'e', skip: 's' };
        const menu = choices.map((c) => `(${keys[c]}) ${c === 'self-built' ? 'self-built' : c === 'source' ? 'enter source' : c}`).join('  ');
        for (;;) {
          const answer = (await ask(`  ${menu} [s]: `)).trim().toLowerCase();
          if (!answer) return 'skip';
          const hit = choices.find((c) => keys[c] === answer || c === answer);
          if (hit) return hit;
        }
      },
    };
    return { prompter, close: () => rl.close() };
  }

  async function handleAdopt(options: { yes?: boolean; dryRun?: boolean }): Promise<void> {
    const interactive = !options.yes && !options.dryRun && Boolean(process.stdin.isTTY);
    const session = interactive ? makePrompter() : null;
    let report;
    try {
      if (interactive) console.log(pc.bold('Scanning assistants and the hub for undeclared skills and MCP servers...'));
      report = await runAdopt({ yes: options.yes, dryRun: options.dryRun, prompter: session?.prompter });
    } finally {
      session?.close();
    }

    if (report.items.length === 0) {
      console.log(pc.green('✓ Nothing to adopt: every skill and MCP server is declared in the hub.'));
      return;
    }
    if (report.mode === 'dry-run' || report.mode === 'preview') {
      console.log(pc.bold(`Found ${report.items.length} undeclared item(s):`));
      for (const item of report.items) describeItem(item);
      const proposals = proposedDeclarations(report.items);
      if (proposals !== '{}') {
        console.log(pc.bold('\nProposed declarations for agenthub.json:'));
        console.log(proposals);
      }
      console.log(
        pc.dim(
          report.mode === 'dry-run'
            ? '\nDry run: nothing was changed.'
            : '\nNothing was changed. Run in a terminal to decide per item, or use --yes to apply only the confident ones.'
        )
      );
      return;
    }

    for (const a of report.applied) {
      console.log(pc.green(`✓ ${a.item}: ${a.declared}`));
      for (const d of a.detail) console.log(pc.dim(`    ${d}`));
    }
    for (const sk of report.skipped) console.log(pc.dim(`- ${sk.item}: ${sk.reason}`));
    if (report.applied.length > 0) {
      // one plan, one consent: fetches pinned sources, links skills, syncs MCP configs
      const { blockers } = await runInstallFlow({ yes: options.yes });
      if (blockers.length > 0) process.exitCode = 1;
    }
  }

  // 1. detect
  program
    .command('detect')
    .description('Detect installed AI coding assistants and configuration status')
    .option('-H, --home <dir>', 'Sets custom home directory')
    .action((options) => {
      applyHomeOverride(options);
      const report = detectPlatforms();

      console.log(pc.bold('agenthub status:'));
      console.log(`  Hub path: ${report.hub.path}`);
      console.log(`  Status:   ${report.hub.exists ? pc.green('Active') : pc.dim('Not initialized')}`);
      console.log(`  Rules:    ${report.hub.rules_count}`);
      console.log(`  Skills:   ${report.hub.skills_count}`);
      console.log('');
      console.log(pc.bold('Platforms:'));

      const platformList = [
        { name: 'Antigravity', info: report.platforms.antigravity },
        { name: 'Claude', info: report.platforms.claude },
        { name: 'Codex', info: report.platforms.codex },
        { name: 'Cursor', info: report.platforms.cursor },
        { name: 'Windsurf', info: report.platforms.windsurf },
        { name: 'Copilot', info: report.platforms.copilot },
      ];

      for (const p of platformList) {
        const badge = p.info?.detected ? pc.green('[FOUND]') : pc.dim('[NOT FOUND]');
        console.log(`  ${badge} ${p.name}`);
      }
    });

  function printScaffoldSummary(result: ScaffoldResult, isSetup: boolean): void {
    console.log(
      pc.green(
        pc.bold(
          isSetup
            ? '✓ agenthub setup completed successfully!'
            : '✓ agenthub initialized successfully!'
        )
      )
    );
    console.log(`  Manifest: ${result.manifest}`);

    if (result.backedUpFiles && result.backedUpFiles.length > 0) {
      console.log(pc.bold('Backed up files:'));
      for (const f of result.backedUpFiles) {
        console.log(`  - ${f}`);
      }
    }

    if (result.copiedTemplates && result.copiedTemplates.length > 0) {
      console.log(pc.bold('Copied templates:'));
      for (const t of result.copiedTemplates) {
        console.log(`  - ${t}`);
      }
    }
  }

  const handleSetupOrInit = async (
    commandName: 'setup' | 'init',
    options: {
      force?: boolean;
      migrate?: string;
      templates?: string;
      scaffoldOnly?: boolean;
      yes?: boolean;
      home?: string;
    }
  ) => {
    applyHomeOverride(options);
    const isSetup = commandName === 'setup';
    try {
      const result = initHub({
        force: Boolean(options.force),
        migrateFrom: options.migrate,
        templateDir: options.templates,
      });

      if (options.scaffoldOnly) {
        printScaffoldSummary(result, isSetup);
        return;
      }

      const homeDir = getHomeDir();
      const hubDir = getHubDir();
      // setup and init finish even when the user declines the plan: pending items are reported, not blockers
      const flow = hasDeclaredSources(hubDir)
        ? await runInstallFlow(options, { probe: true, pendingIsBlocker: false })
        : { blockers: [] as string[], approved: await consentToProbe(options, 0) };
      const installBlockers = flow.blockers;
      const doctorRes = runDoctor({ fix: true, homeDir, hubDir });
      doctorRes.issues.unshift(...installBlockers);

      if (doctorRes.issues.length > 0) {
        console.log(pc.dim(`  Hub scaffolded: ${result.manifest}`));
        console.log(
          pc.red(
            pc.bold(
              `✗ ${
                isSetup ? 'Setup' : 'Initialization'
              } encountered ${doctorRes.issues.length} blocker(s) that could not be automatically repaired:`
            )
          )
        );
        for (const issue of doctorRes.issues) {
          console.log(`  ${pc.red('•')} ${issue}`);
        }
        console.log(
          pc.yellow(
            '\nPlease resolve the blocker(s) above (e.g. fix file permissions or broken paths).'
          )
        );
        console.log(
          pc.dim('Once addressed, run ') +
            pc.cyan('agenthub doctor --fix') +
            pc.dim(' to verify and complete the repair.')
        );
        process.exitCode = 1;
        return;
      }

      printScaffoldSummary(result, isSetup);

      console.log(pc.bold('\nConfigured / detected platforms:'));
      const report = detectPlatforms();
      const configuredPlatforms: string[] = [];
      if (report.platforms.antigravity?.detected) {
        configuredPlatforms.push('Antigravity / Gemini');
      }
      if (report.platforms.claude?.detected) {
        configuredPlatforms.push('Claude Code');
      }
      if (report.platforms.codex?.detected) {
        configuredPlatforms.push('OpenAI Codex');
      }
      if (report.platforms.cursor?.detected) {
        configuredPlatforms.push('Cursor');
      }
      if (report.platforms.windsurf?.detected) {
        configuredPlatforms.push('Windsurf');
      }
      if (report.platforms.copilot?.detected) {
        configuredPlatforms.push('GitHub Copilot CLI');
      }

      if (configuredPlatforms.length > 0) {
        for (const name of configuredPlatforms) {
          console.log(`  ${pc.green('✓')} ${name}`);
        }
      } else {
        console.log(`  ${pc.dim('None detected')}`);
      }

      console.log(pc.bold('\nHealth checks:'));
      console.log(
        `  ${pc.green('✓')} All health checks passed (${doctorRes.passed_checks.length}/${doctorRes.passed_checks.length})`
      );
      await runPostChecks(flow.approved);
    } catch (err) {
      console.error(
        pc.red(
          `✗ ${isSetup ? 'Setup' : 'Initialization'} failed: ${
            (err as Error).message
          }`
        )
      );
      process.exitCode = 1;
    }
  };

  // 2. setup
  program
    .command('setup')
    .description('One-command setup: scaffold hub, auto-wire assistants, and configure MCP')
    .option('-f, --force', 'Force overwrite existing template files')
    .option('-m, --migrate <path>', 'Migrate existing configuration from path')
    .option('-t, --templates <dir>', 'Custom templates directory')
    .option('--scaffold-only', 'Only scaffold ~/.agenthub directory without auto-wiring assistants')
    .option('-y, --yes', 'Install declared skills and MCP servers without confirmation')
    .option('-H, --home <dir>', 'Sets custom home directory')
    .action(async (options) => {
      await handleSetupOrInit('setup', options);
    });

  // 3. init
  program
    .command('init')
    .description('Initialize agenthub directory structure and auto-wire assistants (or --scaffold-only)')
    .option('-f, --force', 'Force overwrite existing template files')
    .option('-m, --migrate <path>', 'Migrate existing configuration from path')
    .option('-t, --templates <dir>', 'Custom templates directory')
    .option('--scaffold-only', 'Only scaffold ~/.agenthub directory without auto-wiring assistants')
    .option('-y, --yes', 'Install declared skills and MCP servers without confirmation')
    .option('-H, --home <dir>', 'Sets custom home directory')
    .action(async (options) => {
      await handleSetupOrInit('init', options);
    });

  // 4. link
  program
    .command('link')
    .description('Link agent skills into configured platforms')
    .option('-H, --home <dir>', 'Sets custom home directory')
    .action((options) => {
      applyHomeOverride(options);
      const res = linkSkillsForAllAssistants();
      const results = [res.claude, res.gemini, res.codex, res.cursor, res.windsurf, res.copilot].filter((r) => r !== undefined);
      for (const r of results) console.log(r.success ? pc.green(`✓ ${r.message}`) : pc.red(`✗ ${r.message}`));
      if (results.some((r) => !r.success)) process.exitCode = 1;
    });

  // 5. project
  program
    .command('project')
    .description('Project unified rules and subagents to configured assistant platforms')
    .option('--no-imports', 'Do not use @import syntax for platform rules')
    .option('-H, --home <dir>', 'Sets custom home directory')
    .action((options) => {
      applyHomeOverride(options);
      const res = projectAll({ useImports: options.imports !== false });
      for (const msg of res.messages) {
        console.log(res.success && !msg.startsWith('Warning') ? pc.green(`✓ ${msg}`) : pc.yellow(`- ${msg}`));
      }
      if (!res.success) {
        process.exitCode = 1;
      }
    });

  // 6. doctor
  program
    .command('doctor')
    .description('Verify and repair links, rules and configs, and check that skills and MCP servers actually work')
    .option('--fix', 'Repair broken links, rules and drift, and offer the install flow for missing items')
    .option('--no-functional', 'Skip the checks that start MCP servers and run custom check commands')
    .option('--timeout <seconds>', 'Per-server MCP timeout in seconds', '20')
    .option('--json', 'Print machine-readable JSON')
    .option('-y, --yes', 'With --fix: install declared items without confirmation')
    .option('-H, --home <dir>', 'Sets custom home directory')
    .action(async (options) => {
      applyHomeOverride(options);
      const timeoutSec = Number(options.timeout);
      if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
        console.error(pc.red(`✗ Invalid --timeout '${options.timeout}': expected a positive number of seconds.`));
        process.exitCode = 1;
        return;
      }
      const res = await runFullDoctor({
        fix: Boolean(options.fix),
        functional: options.functional !== false,
        timeoutSec,
        clientVersion: VERSION,
        installFlow: async () => (await runInstallFlow(options)).blockers,
      });

      if (options.json) {
        console.log(JSON.stringify({ ok: res.ok, counts: res.counts, items: res.items, repairs: res.repairs, notes: res.notes }, null, 2));
      } else {
        printItems(res.items);
        for (const repair of res.repairs) console.log(`${pc.cyan('[FIXED]')} ${repair}`);
        for (const note of res.notes) console.log(pc.dim(`  ${note}`));
        console.log(
          `\n${res.counts.PASS} passed, ${res.counts.WARN} warning(s), ${res.counts.FAIL} failed`
        );
      }
      if (!res.ok) process.exitCode = 1;
    });

  // 6b. adopt
  program
    .command('adopt')
    .description('Bring existing skills and MCP servers that the hub does not declare under the hub')
    .option('-y, --yes', 'Apply confident inferences only (then install them), skip the rest')
    .option('--dry-run', 'Print what was found and the proposed declarations, change nothing')
    .option('-H, --home <dir>', 'Sets custom home directory')
    .action(async (options) => {
      applyHomeOverride(options);
      try {
        await handleAdopt(options);
      } catch (err) {
        console.error(pc.red(`✗ ${(err as Error).message}`));
        process.exitCode = 1;
      }
    });

  // 7. budget
  program
    .command('budget')
    .description('Audit token overhead of rules and skills registry against boot budget')
    .option('-H, --home <dir>', 'Sets custom home directory')
    .action((options) => {
      applyHomeOverride(options);
      const audit = auditTokenBudget();
      const statusDisplay = audit.status === 'PASS (LEAN)' ? pc.green(audit.status) : pc.red(audit.status);

      console.log(pc.bold('Token Budget Audit:'));
      console.log(`  Core rules tokens:      ${audit.core_rules_tokens}`);
      if (audit.addons_rules_tokens > 0) {
        console.log(`  Addon rules tokens:     ${audit.addons_rules_tokens}`);
      }
      console.log(`  Skills registry tokens: ${audit.skills_registry_tokens} (${audit.skills_count} skills)`);
      console.log(`  Total boot tokens:      ${audit.total_boot_tokens}`);
      console.log(`  Target budget:          ${audit.budget}`);
      console.log(`  Status:                 ${statusDisplay}`);
    });

  // 8. diff
  program
    .command('diff')
    .description('Detect drifts between hub source rules and downstream platforms')
    .option('-p, --platform <platform>', 'Platform to diff (gemini, claude, codex, or all)', 'all')
    .option('-H, --home <dir>', 'Sets custom home directory')
    .action((options) => {
      applyHomeOverride(options);
      const targetPlatform = (options.platform || 'all').toLowerCase();
      const audit = detectRuleDrift();

      let platformsToAudit: PlatformDriftTarget[];
      if (targetPlatform === 'all') {
        platformsToAudit = ['gemini', 'claude', 'codex'];
      } else if (['gemini', 'claude', 'codex'].includes(targetPlatform)) {
        platformsToAudit = [targetPlatform as PlatformDriftTarget];
      } else {
        console.error(pc.red(`Unknown platform '${options.platform}'. Expected 'gemini', 'claude', 'codex', or 'all'.`));
        process.exitCode = 1;
        return;
      }

      for (const plat of platformsToAudit) {
        const report = audit[plat];
        if (!report) continue;

        if (!report.exists) {
          console.log(`${pc.dim('[-]')} ${plat}: rule file does not exist`);
          continue;
        }

        if (!report.hasDrift) {
          console.log(`${pc.green('✓')} ${plat}: In sync with hub rules`);
          continue;
        }

        console.log(`${pc.yellow('!')} ${plat}: Drift detected (${report.file})`);
        if (report.added.length > 0) {
          console.log(pc.bold('  Added chunks:'));
          for (const chunk of report.added) {
            console.log(`    + ${chunk.path.join(' > ') || chunk.header}`);
          }
        }
        if (report.modified.length > 0) {
          console.log(pc.bold('  Modified chunks:'));
          for (const mod of report.modified) {
            console.log(`    ~ ${mod.source.path.join(' > ') || mod.source.header}`);
          }
        }
        if (report.removed.length > 0) {
          console.log(pc.bold('  Removed chunks:'));
          for (const chunk of report.removed) {
            console.log(`    - ${chunk.path.join(' > ') || chunk.header}`);
          }
        }
      }
    });

  // 9. promote
  program
    .command('promote [targetRuleFile]')
    .description('Promote downstream rule changes back upstream into hub rules')
    .option('-f, --from-platform <platform>', 'Source platform to promote drift from', 'gemini')
    .option('--header <name>', 'Header name of the chunk to promote')
    .option('--no-reproject', 'Skip auto-reprojecting rules after promotion')
    .option('-H, --home <dir>', 'Sets custom home directory')
    .action((targetRuleFile, options) => {
      applyHomeOverride(options);
      const fromPlatform = (options.fromPlatform || 'gemini').toLowerCase() as PlatformDriftTarget;
      const audit = detectRuleDrift();
      const report = audit[fromPlatform];

      if (!report || !report.exists || !report.hasDrift) {
        console.error(pc.red(`No drift detected on platform '${fromPlatform}'`));
        process.exitCode = 1;
        return;
      }

      let chunkToPromote: MarkdownChunk | undefined;
      if (options.header) {
        const query = options.header.toLowerCase();
        chunkToPromote = report.added.find(
          (c) => c.header.toLowerCase() === query || c.path.some((p) => p.toLowerCase() === query)
        );
        if (!chunkToPromote) {
          const mod = report.modified.find(
            (m) =>
              m.source.header.toLowerCase() === query ||
              m.target.header.toLowerCase() === query ||
              m.source.path.some((p) => p.toLowerCase() === query)
          );
          if (mod) {
            chunkToPromote = mod.source;
          }
        }
      } else {
        if (report.added.length > 0) {
          chunkToPromote = report.added[0];
        } else if (report.modified.length > 0) {
          chunkToPromote = report.modified[0].source;
        }
      }

      if (!chunkToPromote) {
        console.error(
          pc.red(
            `No matching chunk found${options.header ? ` with header '${options.header}'` : ''} on platform '${fromPlatform}'`
          )
        );
        process.exitCode = 1;
        return;
      }

      const res = promoteChunk(chunkToPromote, {
        targetRuleFile: targetRuleFile || 'common.md',
        reproject: options.reproject !== false,
      });

      if (res.success) {
        console.log(pc.green(`✓ ${res.message}`));
      } else {
        console.error(pc.red(`✗ ${res.message}`));
        process.exitCode = 1;
      }
    });

  // 10. mcp
  program
    .command('mcp <action>')
    .description('Manage MCP servers (status | sync)')
    .option('--force', 'sync: also overwrite entries an assistant has of its own under the same name')
    .option('-H, --home <dir>', 'Sets custom home directory')
    .action((action, options) => {
      applyHomeOverride(options);
      if (action === 'status') {
        const status = getMcpStatus();
        console.log(pc.bold('MCP Status:'));
        console.log(`  Sync status:      ${status.in_sync ? pc.green('[IN SYNC]') : pc.yellow('[OUT OF SYNC]')}`);
        console.log(`  Hub servers:      ${Object.keys(status.hub.servers).join(', ') || pc.dim('none')}`);
        console.log(`  Claude servers:   ${Object.keys(status.claude.servers).join(', ') || pc.dim('none')}`);
        console.log(`  Gemini servers:   ${Object.keys(status.gemini.servers).join(', ') || pc.dim('none')}`);
        for (const st of Object.values(status.platforms)) {
          const label = `${st.label} servers:`.padEnd(18);
          if (!st.installed) {
            console.log(`  ${label}${pc.dim('not detected')}`);
          } else if (!st.valid) {
            console.log(`  ${label}${pc.red('corrupt file')} ${pc.dim(st.path)}`);
          } else {
            const notes = [
              st.missing.length ? `missing: ${st.missing.join(', ')}` : '',
              st.untracked.length ? `untracked: ${st.untracked.join(', ')}` : '',
              st.drifted.length ? `drifted: ${st.drifted.join(', ')}` : '',
              st.conflicted.length ? `conflict (its own entry): ${st.conflicted.join(', ')}` : '',
            ].filter(Boolean);
            console.log(`  ${label}${Object.keys(st.servers).join(', ') || pc.dim('none')}${notes.length ? pc.yellow(`  (${notes.join('; ')})`) : ''}`);
          }
        }
      } else if (action === 'sync') {
        const res = syncMcpServers({ force: Boolean(options.force) });
        console.log(pc.bold('MCP Sync:'));
        if (res.actions.length === 0) {
          console.log(pc.dim('  All servers are already synchronized.'));
        } else {
          for (const act of res.actions) {
            console.log(pc.green(`  ✓ ${act}`));
          }
        }
      } else {
        console.error(pc.red(`Unknown MCP action '${action}'. Expected 'status' or 'sync'.`));
        process.exitCode = 1;
      }
    });

  // 11. connect
  program
    .command('connect <platform>')
    .description('Connect an assistant platform by linking skills and projecting rules')
    .option('--target-dir <dir>', 'Custom target directory for platforms like Cursor/Windsurf')
    .option('-H, --home <dir>', 'Sets custom home directory')
    .action((platform, options) => {
      applyHomeOverride(options);
      const res = connectPlatform(platform, options.targetDir);
      if (res.success) {
        console.log(pc.green(`✓ ${res.message}`));
      } else {
        console.error(pc.red(`✗ ${res.message}`));
        process.exitCode = 1;
      }
    });

  // 12. export
  program
    .command('export <target>')
    .description('Export concatenated hub rules for external assistant targets')
    .option('-o, --output <file>', 'Output file path')
    .option('--stdout', 'Print exported rules to standard output')
    .option('-H, --home <dir>', 'Sets custom home directory')
    .action((target, options) => {
      applyHomeOverride(options);
      const res = exportRules(target, {
        output: options.output,
        stdout: options.stdout,
      });

      if (!res.ok) {
        console.error(pc.red(`✗ ${res.content}`));
        process.exitCode = 1;
        return;
      }

      if (options.stdout) {
        process.stdout.write(res.content);
      } else {
        console.log(pc.green(`✓ Exported ${target} rules to: ${res.destination}`));
      }
    });

  // 13. git
  program
    .command('git <action>')
    .description('Manage hub git repository (status | init)')
    .option('--remote-url <url>', 'Remote repository URL for git initialization')
    .option('-H, --home <dir>', 'Sets custom home directory')
    .action((action, options) => {
      applyHomeOverride(options);
      if (action === 'status') {
        const status = gitStatus();
        if (!status.git_installed) {
          console.error(pc.red('Git is not installed on this system.'));
          process.exitCode = 1;
          return;
        }
        if (!status.is_repo) {
          console.log(pc.yellow('Hub directory is not a git repository.'));
          return;
        }

        console.log(pc.bold('Git Status:'));
        console.log(`  Branch:    ${status.branch || pc.dim('none')}`);
        console.log(`  State:     ${status.is_clean ? pc.green('clean') : pc.yellow('dirty')}`);

        if (status.modified.length > 0) {
          console.log(pc.yellow(`  Modified (${status.modified.length}):`));
          for (const f of status.modified) {
            console.log(`    ~ ${f}`);
          }
        }
        if (status.untracked.length > 0) {
          console.log(pc.dim(`  Untracked (${status.untracked.length}):`));
          for (const f of status.untracked) {
            console.log(`    ? ${f}`);
          }
        }
        const remotes = Object.entries(status.remotes);
        if (remotes.length > 0) {
          console.log(pc.bold('  Remotes:'));
          for (const [name, url] of remotes) {
            console.log(`    ${name}: ${url}`);
          }
        }
      } else if (action === 'init') {
        const res = gitInitHub(undefined, options.remoteUrl);
        if (res.ok) {
          console.log(pc.green(`✓ ${res.message}`));
        } else {
          console.error(pc.red(`✗ ${res.message}`));
          process.exitCode = 1;
        }
      } else {
        console.error(pc.red(`Unknown git action '${action}'. Expected 'status' or 'init'.`));
        process.exitCode = 1;
      }
    });

  // 14. push
  program
    .command('push')
    .description('Commit and push hub configurations to git remote')
    .option('-m, --message <msg>', 'Git commit message')
    .option('-r, --remote <remote>', 'Remote repository name', 'origin')
    .option('-b, --branch <branch>', 'Branch to push')
    .option('-H, --home <dir>', 'Sets custom home directory')
    .action((options) => {
      applyHomeOverride(options);
      const res = gitPush(undefined, options.message, options.remote, options.branch);
      if (res.ok) {
        console.log(pc.green(`✓ ${res.message}`));
      } else {
        console.error(pc.red(`✗ ${res.message}`));
        process.exitCode = 1;
      }
    });

  // 15. pull
  program
    .command('pull')
    .description('Pull changes from git remote and reproject rules')
    .option('-r, --remote <remote>', 'Remote repository name', 'origin')
    .option('-b, --branch <branch>', 'Branch to pull')
    .option('--no-reproject', 'Skip auto-reprojecting rules, manifests and installs after pull')
    .option('-y, --yes', 'Install declared skills and MCP servers without confirmation')
    .option('-H, --home <dir>', 'Sets custom home directory')
    .action(async (options) => {
      applyHomeOverride(options);
      const res = gitPull(undefined, options.remote, options.branch, options.reproject !== false);
      if (res.ok) {
        console.log(pc.green(`✓ ${res.message}`));
        if (options.reproject !== false) {
          const flow = await runInstallFlow(options, { probe: true });
          if (flow.blockers.length > 0) process.exitCode = 1;
          await runPostChecks(flow.approved);
        }
      } else {
        console.error(pc.red(`✗ ${res.message}`));
        process.exitCode = 1;
      }
    });

  // 15b. install
  program
    .command('install')
    .description('Install the skills and MCP servers declared in agenthub.json (pinned by agenthub.lock.json)')
    .option('-y, --yes', 'Skip the confirmation prompt')
    .option('-H, --home <dir>', 'Sets custom home directory')
    .action(async (options) => {
      applyHomeOverride(options);
      try {
        if ((await runInstallFlow(options)).blockers.length > 0) process.exitCode = 1;
      } catch (err) {
        console.error(pc.red(`✗ ${(err as Error).message}`));
        process.exitCode = 1;
      }
    });

  // 15c. update
  program
    .command('update [names...]')
    .description('Re-resolve lockfile pins for declared skills and MCP servers, then install them')
    .option('-y, --yes', 'Skip the confirmation prompt')
    .option('-H, --home <dir>', 'Sets custom home directory')
    .action(async (names: string[], options) => {
      applyHomeOverride(options);
      try {
        const { changes, errors } = await updatePins(getHubDir(), names);
        for (const c of changes) {
          console.log(`  ${c.item}: ${c.from ? c.from.slice(0, 12) : 'unpinned'} -> ${c.to.slice(0, 12)}`);
        }
        if (changes.length === 0 && errors.length === 0) console.log(pc.dim('  All pins are up to date.'));
        for (const e of errors) console.error(pc.red(`✗ ${e.item}: ${e.message}`));
        const { blockers } = await runInstallFlow(options);
        if (errors.length > 0 || blockers.length > 0) process.exitCode = 1;
      } catch (err) {
        console.error(pc.red(`✗ ${(err as Error).message}`));
        process.exitCode = 1;
      }
    });

  // 16. info
  program
    .command('info <target>')
    .description('Inspect and display security analysis, token footprint, and metadata for a package')
    .option('-H, --home <dir>', 'Sets custom home directory')
    .action((target, options) => {
      applyHomeOverride(options);
      try {
        const report = packageInfo(target);
        const { manifest, tokenFootprint, riskLevel, isClean, mcpServers, sources, scripts, envVarsRequired, warnings } = report;

        const riskColor = riskLevel === 'LOW' ? pc.green : riskLevel === 'MEDIUM' ? pc.yellow : pc.red;
        const cleanColor = isClean ? pc.green('Yes') : pc.yellow('No');

        console.log(pc.bold(`Package: ${manifest.name}`));
        if (manifest.version) console.log(`  Version:       ${manifest.version}`);
        console.log(`  Type:          ${manifest.type || 'addon'}`);
        if (manifest.description) console.log(`  Description:   ${manifest.description}`);
        const platforms = manifest.platforms?.length ? manifest.platforms.join(', ') : 'all';
        console.log(`  Platforms:     ${platforms}`);

        console.log(pc.bold('\nToken Footprint:'));
        console.log(`  Rules tokens:  ${tokenFootprint.rulesTokens}`);
        console.log(`  Skills tokens: ${tokenFootprint.skillsTokens}`);
        console.log(`  Total tokens:  ${tokenFootprint.totalTokens}`);

        console.log(pc.bold('\nSecurity Assessment:'));
        console.log(`  Risk level:    ${riskColor(riskLevel)}`);
        console.log(`  Clean status:  ${cleanColor}`);

        if (envVarsRequired.length > 0) {
          console.log(`  Required Env:  ${envVarsRequired.join(', ')}`);
        }

        if (mcpServers.length > 0) {
          console.log(pc.bold(`\nMCP Servers (${mcpServers.length}):`));
          for (const s of mcpServers) {
            const sRisk = s.riskLevel === 'LOW' ? pc.green(s.riskLevel) : s.riskLevel === 'MEDIUM' ? pc.yellow(s.riskLevel) : pc.red(s.riskLevel);
            console.log(`  - ${pc.cyan(s.name)} [Risk: ${sRisk}]`);
            console.log(`    Command: ${s.command}${s.args?.length ? ' ' + s.args.join(' ') : ''}`);
            if (s.envVars?.length) {
              console.log(`    Env vars: ${s.envVars.join(', ')}`);
            }
            if (s.warnings?.length) {
              for (const w of s.warnings) {
                console.log(pc.yellow(`    ⚠ ${w}`));
              }
            }
          }
        }

        if (sources.length > 0) {
          console.log(pc.bold(`\nDeclared Sources (${sources.length}):`));
          for (const src of sources) {
            const srcRisk = src.riskLevel === 'LOW' ? pc.green(src.riskLevel) : src.riskLevel === 'MEDIUM' ? pc.yellow(src.riskLevel) : pc.red(src.riskLevel);
            console.log(`  - ${pc.cyan(`${src.kind}.${src.name}`)}: ${src.source} [Risk: ${srcRisk}]`);
            for (const c of src.commands) {
              console.log(pc.yellow(`    ⚠ runs: ${c}`));
            }
          }
        }

        if (scripts.length > 0) {
          console.log(pc.bold(`\nExecutable Scripts (${scripts.length}):`));
          for (const sc of scripts) {
            const scRisk = sc.riskLevel === 'LOW' ? pc.green(sc.riskLevel) : sc.riskLevel === 'MEDIUM' ? pc.yellow(sc.riskLevel) : pc.red(sc.riskLevel);
            console.log(`  - ${pc.cyan(sc.path)} [Risk: ${scRisk}]`);
            if (sc.warnings?.length) {
              for (const w of sc.warnings) {
                console.log(pc.yellow(`    ⚠ ${w}`));
              }
            }
          }
        }

        if (warnings.length > 0 && mcpServers.length === 0 && scripts.length === 0 && sources.length === 0) {
          console.log(pc.bold('\nWarnings:'));
          for (const w of warnings) {
            console.log(pc.yellow(`  ⚠ ${w}`));
          }
        }
      } catch (err) {
        console.error(pc.red(`✗ ${(err as Error).message}`));
        process.exitCode = 1;
      }
    });

  // 17. add
  program
    .command('add <target>')
    .description('Install an agent package or addon into the hub')
    .option('-r, --rules-only', 'Only install rules (skip skills and MCP servers)')
    .option('-s, --skill <name>', 'Install specific skill (repeatable or comma-separated)', (val: string, prev: string[]) => {
      const items = val.split(',').map((s) => s.trim()).filter(Boolean);
      return [...prev, ...items];
    }, [] as string[])
    .option('-y, --yes', 'Skip interactive security confirmation')
    .option('-H, --home <dir>', 'Sets custom home directory')
    .action(async (target, options) => {
      applyHomeOverride(options);
      try {
        if (!options.yes && process.stdin.isTTY) {
          const report = packageInfo(target);
          const hasMcp = report.mcpServers.length > 0;
          const hasScripts = report.scripts.length > 0;
          const isHighRisk = report.riskLevel === 'MEDIUM' || report.riskLevel === 'HIGH';

          if (hasMcp || hasScripts || isHighRisk) {
            console.log(pc.bold(pc.yellow('\nSecurity Notice:')));
            if (isHighRisk) {
              const riskColor = report.riskLevel === 'HIGH' ? pc.red : pc.yellow;
              console.log(`  Package Risk Level: ${riskColor(report.riskLevel)}`);
            }
            if (hasMcp) {
              console.log(`  This package configures MCP servers (${report.mcpServers.map((s) => s.name).join(', ')}).`);
            }
            if (hasScripts) {
              console.log(`  This package contains executable scripts (${report.scripts.map((s) => s.path).join(', ')}).`);
            }
            if (report.warnings.length > 0) {
              console.log(pc.dim('  Warnings:'));
              for (const w of report.warnings) {
                console.log(pc.yellow(`    ⚠ ${w}`));
              }
            }
            console.log('');
            const confirmed = await promptConfirm('Do you want to proceed? [y/N] ');
            if (!confirmed) {
              console.log(pc.yellow('Installation aborted.'));
              process.exitCode = 1;
              return;
            }
          }
        }

        let selectedSkills: string[] | undefined;
        if (Array.isArray(options.skill) && options.skill.length > 0) {
          selectedSkills = options.skill;
        } else if (typeof options.skill === 'string' && options.skill.trim()) {
          selectedSkills = options.skill.split(',').map((s: string) => s.trim()).filter(Boolean);
        }

        const res = packageAdd(target, {
          rulesOnly: Boolean(options.rulesOnly),
          skills: selectedSkills,
        });

        for (const w of res.warnings) console.log(pc.yellow(`  ⚠ ${w}`));
        console.log(pc.green(`✓ Successfully installed package "${res.identifier}"`));
        if (res.installedRules) {
          console.log(`  Rules:       Installed to rules/addons/${res.identifier}.md`);
        } else {
          console.log(`  Rules:       None`);
        }
        if (res.installedSkills.length > 0) {
          console.log(`  Skills:      ${res.installedSkills.join(', ')}`);
        } else {
          console.log(`  Skills:      None`);
        }
        if (res.mergedMcpServers.length > 0) {
          console.log(`  MCP Servers: ${res.mergedMcpServers.join(', ')}`);
        } else {
          console.log(`  MCP Servers: None`);
        }
        console.log(`  Projection:  Auto-projected rules and linked skills across assistants.`);
      } catch (err) {
        console.error(pc.red(`✗ ${(err as Error).message}`));
        process.exitCode = 1;
      }
    });

  // 18. profile
  program
    .command('profile [action] [target]')
    .description('Manage AgentHub environment profiles')
    .option('-y, --yes', 'Skip security confirmation for remote profiles')
    .option('-H, --home <dir>', 'Sets custom home directory')
    .action(async (action, target, options) => {
      applyHomeOverride(options);
      const act = action || 'list';

      if (act === 'list') {
        const res = profileList();
        console.log(pc.bold('AgentHub Profiles:'));
        for (const p of res.profiles) {
          if (p === res.active) {
            console.log(`* ${pc.green(p)} ${pc.dim('(active)')}`);
          } else {
            console.log(`  ${p}`);
          }
        }
      } else if (act === 'create') {
        if (!target) {
          console.error(pc.red('✗ Profile name is required. Usage: agenthub profile create <name>'));
          process.exitCode = 1;
          return;
        }
        const res = profileCreate(target);
        if (res.success) {
          console.log(pc.green(`✓ ${res.message}`));
        } else {
          console.error(pc.red(`✗ ${res.message}`));
          process.exitCode = 1;
        }
      } else if (act === 'use') {
        if (!target) {
          console.error(pc.red('✗ Target profile or package is required. Usage: agenthub profile use <target>'));
          process.exitCode = 1;
          return;
        }

        if (!options.yes && process.stdin.isTTY) {
          const hub = getHubDir();
          const localProfileDir = path.join(hub, 'profiles', target);
          let isLocal = false;
          try {
            isLocal = fs.existsSync(localProfileDir) && fs.statSync(localProfileDir).isDirectory();
          } catch {
            isLocal = false;
          }

          if (!isLocal) {
            try {
              const report = packageInfo(target);
              const hasMcp = report.mcpServers.length > 0;
              const hasScripts = report.scripts.length > 0;
              const isHighRisk = report.riskLevel === 'MEDIUM' || report.riskLevel === 'HIGH';

              if (hasMcp || hasScripts || isHighRisk) {
                console.log(pc.bold(pc.yellow('\nSecurity Notice:')));
                if (isHighRisk) {
                  const riskColor = report.riskLevel === 'HIGH' ? pc.red : pc.yellow;
                  console.log(`  Profile Risk Level: ${riskColor(report.riskLevel)}`);
                }
                if (hasMcp) {
                  console.log(`  This profile configures MCP servers (${report.mcpServers.map((s) => s.name).join(', ')}).`);
                }
                if (hasScripts) {
                  console.log(`  This profile contains executable scripts (${report.scripts.map((s) => s.path).join(', ')}).`);
                }
                if (report.warnings.length > 0) {
                  console.log(pc.dim('  Warnings:'));
                  for (const w of report.warnings) {
                    console.log(pc.yellow(`    ⚠ ${w}`));
                  }
                }
                console.log('');
                const confirmed = await promptConfirm('Do you want to switch to this profile? [y/N] ');
                if (!confirmed) {
                  console.log(pc.yellow('Profile switch aborted.'));
                  process.exitCode = 1;
                  return;
                }
              }
            } catch {
              // Let profileUse handle target resolution error
            }
          }
        }

        const res = profileUse(target, { yes: options.yes });
        if (res.success) {
          console.log(pc.green(`✓ ${res.message}`));
          console.log(`  Active Profile: ${pc.bold(res.name)} (switched from ${res.previous})`);
          console.log(`  Type:           ${res.isRemote ? 'Remote package' : 'Local profile'}`);
          console.log(`  Projection:     Auto-projected rules, linked skills, and synchronized MCP configs.`);
        } else {
          console.error(pc.red(`✗ ${res.message}`));
          process.exitCode = 1;
        }
      } else {
        console.error(pc.red(`✗ Unknown profile action "${act}". Expected "list", "create", or "use".`));
        process.exitCode = 1;
      }
    });

  // 19. share
  program
    .command('share')
    .description('Audit, push, and generate share commands for hub setup')
    .option('-m, --message <msg>', 'Git commit message')
    .option('-r, --remote <remote>', 'Remote repository name', 'origin')
    .option('-b, --branch <branch>', 'Branch to push')
    .option('-f, --force', 'Force sharing even if security risks or secrets are detected')
    .option('--publish', 'Publish package to AgentHub registry after pushing')
    .option('--registry <url>', 'Override registry URL')
    .option('--token <token>', 'Token from agenthub login (visible in the process list; prefer AGENTHUB_TOKEN or the stored login)')
    .option('-H, --home <dir>', 'Sets custom home directory')
    .action(async (options) => {
      applyHomeOverride(options);
      let publishToken: string | undefined;
      if (options.publish) {
        if (!registryAllowed(options.registry)) return;
        publishToken = resolveToken(options.registry, options.token);
        if (!publishToken) {
          console.error(pc.red('✗ Publishing needs a login. Run: agenthub login'));
          process.exitCode = 1;
          return;
        }
        const remoteUrl = gitStatus(getHubDir()).remotes?.[options.remote];
        if (!remoteUrl || !/github\.com/i.test(remoteUrl) || !extractRepoShorthand(remoteUrl)) {
          console.error(pc.red('✗ Publishing needs a public GitHub remote'));
          process.exitCode = 1;
          return;
        }
      }
      const res = shareSetup({
        commitMessage: options.message,
        remote: options.remote,
        branch: options.branch,
        force: options.force,
      });

      if (!res.success) {
        console.error(pc.red(`✗ ${res.message}`));
        if (res.warnings.length > 0) {
          console.log(pc.yellow('\nWarnings:'));
          for (const w of res.warnings) {
            console.log(pc.yellow(`  ⚠ ${w}`));
          }
        }
        process.exitCode = 1;
        return;
      }

      console.log(pc.green(`✓ ${res.message}`));
      if (res.warnings.length > 0) {
        console.log(pc.yellow('\nWarnings:'));
        for (const w of res.warnings) {
          console.log(pc.yellow(`  ⚠ ${w}`));
        }
      }

      console.log(pc.bold('\nShare Commands:'));
      console.log(`  ${pc.cyan(res.shareCommand)}`);
      console.log(`  ${pc.cyan(res.profileCommand)}`);

      if (options.publish) {
        console.log(pc.bold('\nPublishing to registry...'));
        const hub = getHubDir();
        const payload = buildPackagePayload(hub, {
          repoShorthand: res.repoShorthand,
          remoteUrl: res.remoteUrl,
        });

        const pubResult = await publishToRegistry(payload, {
          registryUrl: options.registry,
          token: publishToken,
        });

        if (pubResult.success) {
          const pkgId =
            pubResult.package?.id ||
            (payload.owner ? `${payload.owner}/${payload.repo}` : (payload.name as string));
          console.log(pc.green(`✓ Successfully published and indexed "${pkgId}" in registry!`));
        } else {
          console.error(pc.red(`✗ Failed to publish to registry: ${withLoginHint(pubResult.error, pubResult.status)}`));
          process.exitCode = 1;
        }
      }
    });

  // 20. search
  program
    .command('search [query]')
    .description('Search the AgentHub registry for profiles and addons')
    .option('-p, --platform <platform>', 'Filter by platform')
    .option('-t, --type <type>', 'Filter by type (profile/addon)')
    .option('--tag <tag>', 'Filter by tag')
    .option('--registry <url>', 'Override registry URL')
    .option('-l, --limit <num>', 'Max results to show (default 10)', '10')
    .option('-H, --home <dir>', 'Sets custom home directory')
    .action(async (query = '', options) => {
      applyHomeOverride(options);
      const limit = parseInt(options.limit, 10) || 10;
      const res = await searchRegistry(query, {
        platform: options.platform,
        type: options.type,
        tag: options.tag,
        registryUrl: options.registry,
        limit,
      });

      if (!res.success) {
        console.error(pc.red(`✗ Failed to search registry: ${res.error}`));
        process.exitCode = 1;
        return;
      }

      if (res.packages.length === 0) {
        if (query) {
          console.log(`No packages found matching "${query}".`);
        } else {
          console.log('No packages found in registry.');
        }
        return;
      }

      const matchLabel = query ? `matching "${query}"` : 'in registry';
      console.log(
        pc.bold(`Found ${res.packages.length} package${res.packages.length === 1 ? '' : 's'} ${matchLabel}:\n`)
      );

      for (const pkg of res.packages) {
        const typeBadge = pkg.type === 'profile' ? pc.cyan('[profile]') : pc.magenta('[addon]');
        const versionStr = pkg.version ? pc.dim(`@${pkg.version}`) : '';
        console.log(`  ${pc.bold(pkg.id)}${versionStr} ${typeBadge}`);
        if (pkg.description) {
          console.log(`  ${pkg.description}`);
        }
        const platformsStr =
          pkg.platforms && pkg.platforms.length > 0 ? pkg.platforms.join(', ') : 'all';
        const starsStr = `★ ${pkg.stars ?? 0}`;
        const tokens = pkg.tokenFootprint?.totalTokens ?? 0;
        const metaParts = [`Platforms: ${platformsStr}`, starsStr];
        if (tokens > 0) {
          metaParts.push(`~${tokens} tokens`);
        }
        console.log(`  ${pc.dim(metaParts.join(' | '))}`);

        const installCmd =
          pkg.type === 'profile' ? `agenthub profile use ${pkg.id}` : `agenthub add ${pkg.id}`;
        console.log(`  Install: ${pc.cyan(installCmd)}\n`);
      }
    });

  // 20a. login / logout / whoami / unpublish
  program
    .command('login')
    .description('Log in to the registry with your GitHub account')
    .option('--registry <url>', 'Override registry URL')
    .option('--force', 'Log in again even if already logged in')
    .option('-H, --home <dir>', 'Sets custom home directory')
    .action(async (options) => {
      applyHomeOverride(options);
      if (!registryAllowed(options.registry)) return;
      const registry = getCleanBaseUrl(options.registry);
      const existing = getStoredCredential(registry);
      if (existing && !options.force) {
        console.log(`Already logged in to ${registry} as @${existing.login}. Use --force to log in again.`);
        return;
      }
      try {
        const config = await fetchAuthConfig(registry);
        if (!config.success || !config.data) {
          throw new Error(config.error || 'Could not load registry login configuration');
        }
        const token = await runDeviceFlow({
          clientId: config.data.githubClientId,
          onCode: ({ userCode, verificationUri }) => {
            console.log(`\nOpen ${pc.cyan(verificationUri)} and enter the code: ${pc.bold(userCode)}\n`);
            console.log(pc.dim('Waiting for authorization...'));
          },
        });
        const who = await whoami(token, registry);
        if (!who.success || !who.data) {
          throw new Error(who.error || 'Could not verify login with the registry');
        }
        saveCredential(registry, { token, login: who.data.login });
        console.log(pc.green(`✓ Logged in to ${registry} as @${who.data.login}`));
      } catch (err: any) {
        console.error(pc.red(`✗ Login failed: ${err?.message || err}`));
        process.exitCode = 1;
      }
    });

  program
    .command('logout')
    .description('Remove the stored registry login')
    .option('--registry <url>', 'Override registry URL')
    .option('-H, --home <dir>', 'Sets custom home directory')
    .action((options) => {
      applyHomeOverride(options);
      const registry = getCleanBaseUrl(options.registry);
      if (deleteCredential(registry)) {
        console.log(pc.green(`✓ Logged out of ${registry}`));
      } else {
        console.log(`Not logged in to ${registry}.`);
      }
    });

  program
    .command('whoami')
    .description('Show the GitHub account you are logged in as')
    .option('--registry <url>', 'Override registry URL')
    .option('--token <token>', 'Token from agenthub login (visible in the process list; prefer AGENTHUB_TOKEN or the stored login)')
    .option('-H, --home <dir>', 'Sets custom home directory')
    .action(async (options) => {
      applyHomeOverride(options);
      if (!registryAllowed(options.registry)) return;
      const token = resolveToken(options.registry, options.token);
      if (!token) {
        console.error(pc.red('✗ Not logged in. Run agenthub login'));
        process.exitCode = 1;
        return;
      }
      const res = await whoami(token, options.registry);
      if (!res.success || !res.data) {
        console.error(pc.red(`✗ ${withLoginHint(res.error, res.status)}`));
        process.exitCode = 1;
        return;
      }
      console.log(`@${res.data.login}`);
    });

  program
    .command('unpublish <package>')
    .description('Remove a package (owner/repo) from the registry')
    .option('--registry <url>', 'Override registry URL')
    .option('--token <token>', 'Token from agenthub login (visible in the process list; prefer AGENTHUB_TOKEN or the stored login)')
    .option('-H, --home <dir>', 'Sets custom home directory')
    .action(async (pkg, options) => {
      applyHomeOverride(options);
      if (!registryAllowed(options.registry)) return;
      const token = resolveToken(options.registry, options.token);
      if (!token) {
        console.error(pc.red('✗ Unpublishing needs a login. Run: agenthub login'));
        process.exitCode = 1;
        return;
      }
      const res = await unpublishFromRegistry(pkg, token, options.registry);
      if (!res.success) {
        console.error(pc.red(`✗ ${withLoginHint(res.error, res.status)}`));
        process.exitCode = 1;
        return;
      }
      console.log(pc.green(`✓ ${res.data?.message || `Unpublished ${pkg}`}`));
    });

  // 21. uninstall
  program
    .command('uninstall')
    .description('Rollback assistant rules and junctions to original state, and optionally remove hub')
    .option('-y, --yes', 'Skip confirmation prompts')
    .option('--purge', 'Purge hub directory without prompting')
    .option('--dry-run', 'Preview rollback changes without modifying filesystem')
    .option('-H, --home <dir>', 'Sets custom home directory')
    .action(async (options) => {
      applyHomeOverride(options);
      const hub = getHubDir();
      const home = getHomeDir();

      if (options.dryRun) {
        console.log(pc.yellow('Running in dry-run mode (no changes will be applied)...\n'));
      }

      if (!options.yes && !options.dryRun && process.stdin.isTTY) {
        console.log(pc.bold(pc.yellow('AgentHub Rollback & Uninstall')));
        console.log(`  Target Home: ${home}`);
        console.log(`  Target Hub:  ${hub}`);
        console.log('');
        console.log('This will:');
        console.log('  1. Restore pre-agenthub configuration backups to your assistants.');
        console.log('  2. Revert skills junctions (restoring original skills).');
        console.log('  3. Remove autogenerated agenthub rules and subagents.');
        console.log('');

        const proceed = await promptConfirm('Do you want to proceed with rollback? [y/N] ');
        if (!proceed) {
          console.log(pc.yellow('Uninstall aborted.'));
          process.exitCode = 1;
          return;
        }
      }

      let purge = Boolean(options.purge);
      if (!purge && !options.yes && !options.dryRun && process.stdin.isTTY) {
        console.log('');
        const purgeConfirmed = await promptConfirm(`Would you like to delete the hub directory (${hub}) as well? [y/N] `);
        purge = purgeConfirmed;
      }

      let res;
      try {
        res = uninstallHub({
          home,
          hub,
          dryRun: Boolean(options.dryRun),
          purge,
        });
      } catch (err) {
        console.error(pc.red(`✗ ${(err as Error).message}`));
        process.exitCode = 1;
        return;
      }

      if (!res.success) {
        console.error(pc.red('✗ Uninstall encountered errors:'));
        for (const err of res.errors) {
          console.error(pc.red(`  • ${err}`));
        }
        process.exitCode = 1;
        return;
      }

      console.log(pc.green(pc.bold('\n✓ Rollback completed successfully!')));

      if (res.backupRestored) {
        console.log(pc.cyan(`\nRestored from backup: ${res.backupRestored}`));
        for (const f of res.restoredFiles) {
          console.log(`  • Restored ${f}`);
        }
      } else {
        console.log(pc.dim('\nNo pre-agenthub backup found to restore.'));
      }

      if (res.unlinkedJunctions.length > 0) {
        console.log(pc.cyan('\nUnlinked junctions:'));
        for (const j of res.unlinkedJunctions) {
          console.log(`  • Unlinked ${j}`);
        }
      }

      if (res.restoredJunctions.length > 0) {
        console.log(pc.cyan('\nRestored junctions:'));
        for (const j of res.restoredJunctions) {
          console.log(`  • Restored ${j}`);
        }
      }

      if (res.removedFiles.length > 0) {
        console.log(pc.cyan('\nRemoved generated files:'));
        for (const f of res.removedFiles) {
          console.log(`  • Removed ${f}`);
        }
      }

      if (res.removedMcpServers.length > 0) {
        console.log(pc.cyan('\nRemoved MCP servers that agenthub wrote:'));
        for (const m of res.removedMcpServers) {
          const [platform, ...name] = m.split(':');
          console.log(`  • Removed ${name.join(':')} from ${platform}`);
        }
      }

      if (res.keptMcpServers.length > 0) {
        console.log(pc.cyan('\nKept in place:'));
        for (const k of res.keptMcpServers) console.log(`  • ${k}`);
      }

      if (res.purgedHub) {
        console.log(pc.green(`\n✓ Purged hub directory: ${hub}`));
      } else if (!options.dryRun) {
        console.log(pc.dim(`\nHub directory preserved at: ${hub}`));
      }

      console.log(pc.bold('\nNext step:'));
      console.log(`  To completely remove the CLI command, run: ${pc.cyan('npm uninstall -g @habom2310/agenthub')}`);
    });

  return program;
}

export async function runCli(argv: string[]): Promise<Command> {
  const cli = buildCli();
  cli.exitOverride();
  await cli.parseAsync(argv, { from: 'user' });
  return cli;
}

let isMain = false;
if (process.argv[1]) {
  try {
    const realArgv1 = fs.realpathSync(process.argv[1]);
    const realHref = pathToFileURL(realArgv1).href;
    isMain = import.meta.url === realHref || import.meta.url.toLowerCase() === realHref.toLowerCase();
  } catch {
    const resolvedHref = pathToFileURL(path.resolve(process.argv[1])).href;
    isMain = import.meta.url === resolvedHref || import.meta.url.toLowerCase() === resolvedHref.toLowerCase();
  }
}

if (isMain) {
  const cli = buildCli();
  cli.parseAsync(process.argv).catch(() => {
    process.exitCode = process.exitCode || 1;
  });
}
