#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import pc from 'picocolors';
import {
  VERSION,
  auditTokenBudget,
  connectPlatform,
  detectPlatforms,
  detectRuleDrift,
  exportRules,
  getHomeDir,
  gitInitHub,
  gitPull,
  gitPush,
  gitStatus,
  initHub,
  linkSkillsForClaude,
  linkSkillsForCodex,
  linkSkillsForGemini,
  projectAll,
  promoteChunk,
  runDoctor,
  setCustomHome,
  syncMcpServers,
  getMcpStatus,
  type MarkdownChunk,
  type PlatformDriftTarget,
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

  // 2. init
  program
    .command('init')
    .description('Initialize agenthub directory structure and default templates')
    .option('-f, --force', 'Force overwrite existing template files')
    .option('-m, --migrate <path>', 'Migrate existing configuration from path')
    .option('-t, --templates <dir>', 'Custom templates directory')
    .option('-H, --home <dir>', 'Sets custom home directory')
    .action((options) => {
      applyHomeOverride(options);
      try {
        const result = initHub({
          force: Boolean(options.force),
          migrateFrom: options.migrate,
          templateDir: options.templates,
        });

        console.log(pc.green(pc.bold('✓ agenthub initialized successfully!')));
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
      } catch (err) {
        console.error(pc.red(`✗ Initialization failed: ${(err as Error).message}`));
        process.exitCode = 1;
      }
    });

  // 3. link
  program
    .command('link')
    .description('Link agent skills into configured platforms')
    .option('-H, --home <dir>', 'Sets custom home directory')
    .action((options) => {
      applyHomeOverride(options);
      const claudeRes = linkSkillsForClaude();
      console.log(claudeRes.success ? pc.green(`✓ ${claudeRes.message}`) : pc.red(`✗ ${claudeRes.message}`));

      const geminiRes = linkSkillsForGemini();
      console.log(geminiRes.success ? pc.green(`✓ ${geminiRes.message}`) : pc.red(`✗ ${geminiRes.message}`));

      let codexRes: ReturnType<typeof linkSkillsForCodex> | undefined;
      const codexDir = path.join(getHomeDir(), '.codex');
      if (fs.existsSync(codexDir)) {
        codexRes = linkSkillsForCodex();
        console.log(codexRes.success ? pc.green(`✓ ${codexRes.message}`) : pc.red(`✗ ${codexRes.message}`));
      }

      if (!claudeRes.success || !geminiRes.success || (codexRes && !codexRes.success)) {
        process.exitCode = 1;
      }
    });

  // 4. project
  program
    .command('project')
    .description('Project unified rules and subagents to configured assistant platforms')
    .option('--no-imports', 'Do not use @import syntax for platform rules')
    .option('-H, --home <dir>', 'Sets custom home directory')
    .action((options) => {
      applyHomeOverride(options);
      const res = projectAll({ useImports: options.imports !== false });
      for (const msg of res.messages) {
        console.log(res.success ? pc.green(`✓ ${msg}`) : pc.yellow(`- ${msg}`));
      }
      if (!res.success) {
        process.exitCode = 1;
      }
    });

  // 5. doctor
  program
    .command('doctor')
    .description('Verify and repair hub junctions, manifests, rules, and configurations')
    .option('--fix', 'Automatically repair broken links, missing rules, and drifts')
    .option('-H, --home <dir>', 'Sets custom home directory')
    .action((options) => {
      applyHomeOverride(options);
      const res = runDoctor({ fix: Boolean(options.fix) });

      for (const check of res.passed_checks) {
        console.log(`${pc.green('[PASS]')} ${check}`);
      }
      for (const issue of res.issues) {
        console.log(`${pc.yellow('[WARN]')} ${issue}`);
      }
      for (const repair of res.repairs) {
        console.log(`${pc.cyan('[FIXED]')} ${repair}`);
      }

      if (res.issues.length > 0 && !options.fix) {
        process.exitCode = 1;
      }
    });

  // 6. budget
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
      console.log(`  Skills registry tokens: ${audit.skills_registry_tokens} (${audit.skills_count} skills)`);
      console.log(`  Total boot tokens:      ${audit.total_boot_tokens}`);
      console.log(`  Target budget:          ${audit.budget}`);
      console.log(`  Status:                 ${statusDisplay}`);
    });

  // 7. diff
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

  // 8. promote [targetRuleFile]
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

  // 9. mcp <action>
  program
    .command('mcp <action>')
    .description('Manage MCP servers (status | sync)')
    .option('-H, --home <dir>', 'Sets custom home directory')
    .action((action, options) => {
      applyHomeOverride(options);
      if (action === 'status') {
        const status = getMcpStatus();
        console.log(pc.bold('MCP Status:'));
        console.log(`  Sync status:    ${status.in_sync ? pc.green('[IN SYNC]') : pc.yellow('[OUT OF SYNC]')}`);
        console.log(`  Hub servers:    ${Object.keys(status.hub.servers).join(', ') || pc.dim('none')}`);
        console.log(`  Claude servers: ${Object.keys(status.claude.servers).join(', ') || pc.dim('none')}`);
        console.log(`  Gemini servers: ${Object.keys(status.gemini.servers).join(', ') || pc.dim('none')}`);
      } else if (action === 'sync') {
        const res = syncMcpServers();
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

  // 10. connect <platform>
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

  // 11. export <target>
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

  // 12. git <action>
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

  // 13. push
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

  // 14. pull
  program
    .command('pull')
    .description('Pull changes from git remote and reproject rules')
    .option('-r, --remote <remote>', 'Remote repository name', 'origin')
    .option('-b, --branch <branch>', 'Branch to pull')
    .option('--no-reproject', 'Skip auto-reprojecting rules and manifests after pull')
    .option('-H, --home <dir>', 'Sets custom home directory')
    .action((options) => {
      applyHomeOverride(options);
      const res = gitPull(undefined, options.remote, options.branch, options.reproject !== false);
      if (res.ok) {
        console.log(pc.green(`✓ ${res.message}`));
      } else {
        console.error(pc.red(`✗ ${res.message}`));
        process.exitCode = 1;
      }
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
  cli.parse(process.argv);
}
