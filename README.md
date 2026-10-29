# @habom2310/agenthub

[![npm version](https://img.shields.io/npm/v/@habom2310/agenthub.svg)](https://www.npmjs.com/package/@habom2310/agenthub)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node: >=20.0.0](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)

Unified configuration, skills, rules, and MCP management engine for AI coding assistants.

Zero Python dependencies. Single-binary bundled ESM. Sub-25ms cold startup.

Supports:
- **Google Antigravity (AGY)** (`~/.gemini`)
- **Claude Code** (`~/.claude`)
- **OpenAI Codex CLI & ChatGPT** (`~/.codex`)
- **Cursor** (`~/.cursor`)
- **Windsurf** (`~/.codeium/windsurf` / `~/.windsurf`)
- **GitHub Copilot CLI** (system `PATH` binary: `copilot`)

---

## Installation

### Option 1: Ask Your AI to Set It Up
Copy this prompt into Claude Code, Codex, Antigravity, Cursor, or any assistant that can run terminal commands:

```text
Set up AgentHub (https://github.com/habom2310/agenthub) on my machine:

1. Check that Node.js 20 or later is installed (`node -v`). If not, stop and tell me.
2. If `agenthub --version` fails, install it globally: `npm install -g @habom2310/agenthub`. Do not use sudo. If the install fails on permissions, stop and tell me.
3. Before running `agenthub setup`, tell me what it will change and wait for my OK: it creates the hub at `~/.agenthub` (backing up existing configs), links each detected assistant's skills folder to the hub (an existing folder such as `~/.claude/skills` is copied into the hub and renamed to `skills.old`, replacing any previous `skills.old`), projects shared rules, and syncs MCP servers. It is safe to re-run. Do not add `--force` or `--migrate` unless I ask.
4. If setup reports blockers, show them to me, fix the ones you safely can (such as permissions on my own files), then ask me before running `agenthub doctor --fix`.
5. Run `agenthub doctor` and confirm that all checks pass.

Finish with a short summary: which assistants were wired up, and anything I need to do next.
```

### Option 2: Global Installation (Recommended)
Install globally to get the standalone `agenthub` executable in your terminal, then run setup:

```bash
# npm
npm install -g @habom2310/agenthub

# pnpm
pnpm add -g @habom2310/agenthub

# yarn
yarn global add @habom2310/agenthub
```

Then verify and set up:
```bash
agenthub --version
agenthub setup
```

### Option 3: Instant Run with `npx` (No Install Required)
You can run any command on demand without installing:
```bash
npx @habom2310/agenthub setup
```

---

## What `agenthub setup` Does Automatically
1. **Scaffolds** the central `~/.agenthub` directory with starter heuristics, templates, and subagents (while creating a timestamped backup of existing rules and config files such as `CLAUDE.md`, `GEMINI.md`, `AGENTS.md` and `settings.json`).
2. **Auto-wires all detected assistants**: creates directory junctions for shared skills (`~/.claude/skills`, `~/.gemini/config/skills.json`, `.codex/skills`, etc.), compiles and projects unified markdown rules (`GEMINI.md`, `CLAUDE.md`, `AGENTS.md`, Cursor MDC rules), and synchronizes MCP server definitions. An existing skills folder is copied into the hub and renamed to `skills.old`; a previous `skills.old` is deleted, not backed up.
3. **Validates system health**: verifies all junctions, rule files, and MCP configs.

### Handling Blockers
`agenthub setup` configures everything autonomously and only halts if it encounters an unresolvable blocker (such as an OS file permission error or broken paths). If a blocker is detected:
- The command outputs the exact blocker details.
- It directs you to resolve the blocker (e.g. granting directory permissions or repairing paths).
- Once addressed, simply run:
  ```bash
  agenthub doctor --fix
  ```
  to verify and complete the repair.

*(Since 0.3.0, `agenthub init` runs the same full setup. Need only the directory scaffold, without auto-wiring assistants or the health check? Pass `--scaffold-only`: `agenthub init --scaffold-only`).*

---

## Hub Directory Architecture

Your configuration lives in a central hub (`~/.agenthub` or `$AGENTHUB_HUB`):

```text
~/.agenthub/
├── agenthub.json          # Hub manifest & platform metadata
├── rules/                 # Universal markdown engineering heuristics
│   ├── common.md          # Core heuristics (thinking, simplicity, surgical changes)
│   ├── code-tools.md      # Tool usage reflexes (Ripwire, CodeGraph, rg)
│   ├── handoffs.md        # Session handoff protocols
│   ├── addons/            # Optional modular rule extensions (*.md)
│   └── overrides/         # Platform-specific overrides (claude, agy, codex, cursor, windsurf)
├── agents/                # Subagent persona templates (scout, implementer, reviewer)
├── mcp/                   # Central Model Context Protocol registry
│   └── servers.json       # Canonical MCP servers configuration
├── skills/                # Shared agent skills linked via junctions/symlinks
└── export/                # Web assistant prompts (ChatGPT, Claude Projects)
```

---

## Usage Guide

### 1. Rules Projection & Drift Management

Compile universal rules from `~/.agenthub/rules/` into host-native rule files (`GEMINI.md`, `CLAUDE.md`, `AGENTS.md`, `agenthub.mdc`, `global_rules.md`):

```bash
# Project rules and subagent templates to all installed platforms
agenthub project

# Check for differences between hub source rules and downstream platforms
agenthub diff

# Promote downstream modifications back into the central hub
agenthub promote common.md
```

In a subagent template (`~/.agenthub/agents/*.md`), text between `<!-- claude-only -->` and `<!-- /claude-only -->` lines goes only to the Claude Code agent (`~/.claude/agents/`); the Antigravity copy (`~/.gemini/config/agents/`) leaves it out. Both copies drop the marker lines. Put each marker on its own line, unindented, and don't nest blocks; `agenthub project` warns about a malformed block.

Three frontmatter keys apply to the Claude Code agent only (the Antigravity copy ignores them): `claude_model` and `claude_tools` replace the model and tool list that `tier` and `mode` would give, and `permissionMode` is copied as is. Write `claude_tools` as one comma-separated string:

```yaml
claude_model: haiku
claude_tools: Bash, Read, Edit, Write, Grep, Glob, mcp__codegraph__codegraph_explore
permissionMode: auto
```

### 2. Bidirectional MCP Server Synchronization

Manage Model Context Protocol (MCP) servers centrally in `~/.agenthub/mcp/servers.json` and sync with `~/.claude.json`, `~/.gemini/config/mcp_config.json`, and `~/.gemini/settings.json`:

```bash
# View MCP server status across platforms
agenthub mcp status

# Synchronize servers bidirectionally (preserves platform auth keys and tokens)
agenthub mcp sync
```

### 3. Platform Connectors & Skills Linking

Link agent skills to all assistants using unprivileged Windows NTFS directory junctions (`'junction'`) or POSIX symlinks without duplicating files:

```bash
# Link skills into all detected assistants
agenthub link

# Connect and configure a specific platform
agenthub connect cursor
agenthub connect windsurf
agenthub connect codex
agenthub connect claude
agenthub connect agy
```

### 4. Package Registry & Discovery

Discover, inspect, and install community rules, skills, and presets from the AgentHub registry:

```bash
# Search registry for packages, skills, or rules
agenthub search react -p claude

# Inspect a package's security risk, token footprint, MCP servers, and scripts before installing
agenthub info <target>

# Install an agent package, profile, or addon into the hub (with security prompts)
agenthub add <target>

# Install rules only, or select specific skills
agenthub add <target> --rules-only
agenthub add <target> --skill web-search,git-helper
```

### 5. Environment Profiles

Manage isolated configuration profiles for different projects, environments, or roles:

```bash
# List all profiles (* marks active profile)
agenthub profile list

# Create a new profile
agenthub profile create work

# Switch active profile
agenthub profile use work
```

### 6. Sharing & Publishing

Your hub can be pushed to a Git repo so you (or your team) can install it anywhere, and optionally published to the [AgentHub registry](https://agenthub-web.habom2310.workers.dev) so anyone can find it.

#### Step by step

1. **Create an empty GitHub repo** for your setup (no README or license, or the first push is rejected). It must be **public** if you want to publish it to the registry.
   ```bash
   gh repo create my-agent-setup --public
   ```

2. **Connect your hub to it.** This runs `git init` in `~/.agenthub`, sets `origin`, and writes a `.gitignore` that keeps `backups/` and `.env` files out of the repo.
   ```bash
   agenthub git init --remote-url https://github.com/<you>/my-agent-setup.git
   ```

3. **Describe your package (optional, recommended for the registry).** Add these fields to `~/.agenthub/agenthub.json`, next to what is already there:
   ```json
   {
     "name": "my-agent-setup",
     "description": "Lean rules and review subagents for TypeScript projects",
     "type": "profile",
     "tags": ["typescript", "code-review"],
     "license": "MIT"
   }
   ```
   - `type` is `profile` (a whole setup) or `addon` (a few rules or skills to add on top of someone else's setup).
   - Leave the existing `platforms` and `links` keys as they are; the hub uses them.
   - `agenthub.json` is pushed as-is, but `agenthub profile use <you>/<repo>` takes only `name`, `description`, `type`, `tags`, `license` and `version` from it. The user keeps their own `platforms` and `links`.
   - `agenthub init --force` rewrites `agenthub.json` and drops these fields.
   - Missing fields fall back to: name = repo name, type = `profile`, license = `MIT`.
   - A `README.md` in `~/.agenthub` is shown on your package page.

4. **Check what you are about to share.**
   ```bash
   agenthub budget            # boot token cost of your rules and skills
   agenthub info ~/.agenthub  # security scan: risk level, scripts, MCP servers
   ```
   `share` runs the same scan and stops on hard-coded keys in skill or `scripts/` files, or on high-risk scripts or MCP servers (shell interpreters, `curl`/`wget`, pipes, destructive commands). Fix them, or pass `--force` if you are sure they are safe.

   The scan does not read `rules/` or `mcp/servers.json`. Check those by hand for pasted API keys or tokens before you share; `.env` files are already kept out by `.gitignore`.

5. **Push to Git.**
   ```bash
   agenthub share -m "First version of my setup"
   ```
   It commits everything in the hub, pushes to `origin`, and prints the commands others can run:
   ```text
   agenthub add <you>/my-agent-setup
   agenthub profile use <you>/my-agent-setup
   ```
   This is enough for sharing with your team or your other machines. Stop here if you do not want a public registry listing.

6. **Publish to the registry.** Log in once with GitHub, then publish:
   ```bash
   agenthub login
   agenthub whoami          # should print your GitHub @login
   agenthub share --publish
   ```
   Your package appears at `https://agenthub-web.habom2310.workers.dev/packages/<you>/my-agent-setup` and in `agenthub search`.

7. **Update or remove it later.**
   ```bash
   agenthub share --publish -m "Add Go rules"   # push and refresh the listing
   agenthub unpublish <you>/my-agent-setup     # remove it from the registry (the Git repo stays)
   ```

#### How others use your package

```bash
agenthub search typescript                      # find packages
agenthub info <you>/my-agent-setup              # inspect it before installing
agenthub add <you>/my-agent-setup               # install its rules, skills and MCP servers
agenthub add <you>/my-agent-setup --rules-only  # or just the rules
agenthub profile use <you>/my-agent-setup       # or switch to it as a whole profile
```

#### Common errors

| Message | Fix |
|---|---|
| `Git remote not configured` | Run step 2, or `git -C ~/.agenthub remote add origin <url>`. |
| `Security check failed` | `share` found secrets or risky scripts. Run `agenthub info ~/.agenthub` to see them, remove them, then share again. |
| `Publishing needs a login` | Run `agenthub login`. |
| `Publishing needs a public GitHub remote` | `origin` must be a GitHub URL. Point it at your GitHub repo. |
| `GitHub repo <you>/<repo> not found or not public` / `must be public so others can install it` | Make the repo public on GitHub (Settings › Danger Zone › Change visibility), then publish again. |
| `You (@<login>) don't have push access to <you>/<repo>` | You are logged in as a different GitHub account. Check `agenthub whoami`, then `agenthub login --force` as the repo owner. |
| `<you>/<repo> was published from a different GitHub repo` | The name was published from a repo that has since been renamed or re-created. Its original publisher must run `agenthub unpublish` first. |
| `Unauthorized: sign in with agenthub login to publish. Run: agenthub login` | Your login expired or was revoked. Run `agenthub login --force` (plain `login` says "Already logged in"). If `AGENTHUB_TOKEN` is set in your shell, unset it; it overrides the stored login. |

#### Login details

`agenthub login` uses GitHub's device flow: it prints a code and a URL, and you approve it in the browser.
The token is stored in `~/.config/agenthub/auth.json` (mode 0600, outside the hub, per registry).
`share --publish` fails fast, before pushing, if you are not logged in or the remote is not on GitHub.

```bash
agenthub login [--force]          # log in with GitHub
agenthub whoami                   # show @login, exit 1 if not logged in
agenthub logout                   # forget the stored login
agenthub unpublish owner/repo     # remove a package (needs push access)
```

For CI, set `AGENTHUB_TOKEN` to the token issued by `agenthub login` (for example copied from `auth.json`).
The registry rejects tokens it did not issue, so a GitHub personal access token will not work.
Treat it as a secret; prefer the env var over `--token`, which is visible in the process list.
Tokens are only sent over https (or http to localhost).
Token order: `--token`, then `AGENTHUB_TOKEN`, then the stored login.

### 7. Boot Token Budget Auditor

Measure the minimal context footprint of your core rules and skill descriptions against the recommended 2,000-token boot target:

```bash
agenthub budget
```

### 8. Multi-Machine Sync (Git Federation)

Version control and synchronize your dotfiles across multiple machines:

```bash
# Initialize git in ~/.agenthub with a remote repository
agenthub git init --remote-url git@github.com:username/my-agenthub.git

# Commit and push changes
agenthub push -m "Add new coding rules and MCP servers"

# Pull latest changes on another machine and re-project rules
agenthub pull
```

### 9. Export Rules for Web Assistants

Generate concatenated prompt blocks ready to paste into web assistants:

```bash
# Generate ChatGPT Custom Instructions
agenthub export chatgpt

# Generate Claude Web Projects System Prompt
agenthub export claude-web

# Generate Cursor Project Prompt Block
agenthub export cursor
```

### 10. Rollback & Uninstallation

Revert all assistant rule projections and directory junctions to their original pre-agenthub state:

```bash
# Preview rollback actions without touching the filesystem
agenthub uninstall --dry-run

# Interactive rollback with confirmation prompt
agenthub uninstall

# Full rollback and automatic deletion of ~/.agenthub
agenthub uninstall --purge -y
```

After rolling back configurations, remove the CLI itself:
```bash
npm uninstall -g @habom2310/agenthub
```

---

## CLI Command Reference

| Command | Description |
|---|---|
| `agenthub setup [--force] [--migrate <path>] [--templates <dir>] [--scaffold-only] [--home <dir>]` | One-command setup: scaffold hub, auto-wire assistants, and configure MCP |
| `agenthub init [--force] [--migrate <path>] [--templates <dir>] [--scaffold-only] [--home <dir>]` | Initialize `~/.agenthub` directory structure (runs full setup by default or scaffold-only) |
| `agenthub detect` | Detect installed AI coding assistants and configuration status |
| `agenthub doctor [--fix]` | Diagnose configuration issues and auto-repair broken junctions/rules |
| `agenthub search [query]` | Search the AgentHub registry for packages, addons, and profiles |
| `agenthub info <target>` | Inspect package metadata, security analysis, scripts, and token footprint |
| `agenthub add <target>` | Install an agent package, profile, or addon into the hub |
| `agenthub profile [list\|create\|use]` | List, create, or switch between isolated configuration profiles |
| `agenthub share [--publish]` | Audit, push, and publish hub configurations to Git remote or registry (needs `login`) |
| `agenthub login [--force]` | Log in to the registry with your GitHub account (device flow) |
| `agenthub logout` | Remove the stored registry login |
| `agenthub whoami` | Show the GitHub account you are logged in as |
| `agenthub unpublish <owner/repo>` | Remove a package you can push to from the registry |
| `agenthub project [--no-imports]` | Compile and project unified rules and subagents to configured platforms |
| `agenthub diff [-p <platform>]` | Detect drift between hub rules and downstream platforms |
| `agenthub promote [file]` | Promote downstream rule edits back into central hub |
| `agenthub mcp <status\|sync>` | Display or bidirectionally synchronize MCP server configurations |
| `agenthub link` | Create directory junctions linking `skills/` across all platforms |
| `agenthub connect <platform>` | Connect an assistant platform by linking skills and projecting rules |
| `agenthub budget` | Audit rule and skill token usage against boot token budget |
| `agenthub export <target>` | Export concatenated rules for web assistants (`chatgpt`, `claude-web`, `cursor`) |
| `agenthub git <status\|init>` | Manage hub Git repository initialization and remote synchronization |
| `agenthub push [-m <msg>]` | Stage, commit, and push hub configurations to Git remote |
| `agenthub pull` | Pull updates from Git remote and reproject rules |
| `agenthub uninstall [--purge] [-y]` | Roll back assistant rules and junctions to original state, and optionally remove hub |

---

## Environment Variables

- `AGENTHUB_HOME`: Override the default user home directory.
- `AGENTHUB_HUB`: Override the default hub directory (default: `~/.agenthub`).
- `AGENTHUB_REGISTRY_URL`: Override the AgentHub package registry URL (default: `https://agenthub-web.habom2310.workers.dev`). Also settable per command with `--registry`.
- `AGENTHUB_TOKEN`: GitHub token for `share --publish`, `whoami` and `unpublish` (overrides the stored login; use in CI).
- `XDG_CONFIG_HOME`: Base for the credential file (`$XDG_CONFIG_HOME/agenthub/auth.json`).

---

## License

[MIT](LICENSE) © habom2310
