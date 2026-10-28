# @habom2310/agenthub

[![npm version](https://img.shields.io/npm/v/@habom2310/agenthub.svg)](https://www.npmjs.com/package/@habom2310/agenthub)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node: >=18.0.0](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)

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

### Option 1: Instant Run with `npx` (No Install Required)
You can run any command on demand without installing:
```bash
npx @habom2310/agenthub setup
```

### Option 2: Global Installation (Recommended)
Install globally to get the standalone `agenthub` executable in your terminal:

```bash
# npm
npm install -g @habom2310/agenthub

# pnpm
pnpm add -g @habom2310/agenthub

# yarn
yarn global add @habom2310/agenthub
```

Verify your installation:
```bash
agenthub --version
```

---

## Quickstart (Single-Command Setup)

Set up your entire agent environment with one command:

```bash
npm install -g @habom2310/agenthub
agenthub setup
```

*(You can also use `npx @habom2310/agenthub setup` or `agenthub init` — both run the full automated setup by default).*

### What `agenthub setup` Does Automatically:
1. **Scaffolds** the central `~/.agenthub` directory with starter heuristics, templates, and subagents (while creating a safe timestamped backup of any pre-existing configurations).
2. **Auto-wires all detected assistants**: creates directory junctions for shared skills (`~/.claude/skills`, `~/.gemini/config/skills.json`, `.codex/skills`, etc.), compiles and projects unified markdown rules (`GEMINI.md`, `CLAUDE.md`, `AGENTS.md`, Cursor MDC rules), and synchronizes MCP server definitions.
3. **Validates system health**: verifies all junctions, rule files, and MCP configs.

### Handling Blockers:
`agenthub setup` configures everything autonomously and only halts if it encounters an unresolvable blocker (such as an OS file permission error or broken paths). If a blocker is detected:
- The command outputs the exact blocker details.
- It directs you to resolve the blocker (e.g. granting directory permissions or repairing paths).
- Once addressed, simply run:
  ```bash
  agenthub doctor --fix
  ```
  to verify and complete the repair.

*(Need only the directory scaffold without auto-wiring assistants? Pass `--scaffold-only`: `agenthub init --scaffold-only`).*

---

## 🤖 Let AI Set It Up For You

Prefer your AI assistant to handle setup and configuration? Copy and paste this prompt into your assistant of choice (**Claude Code**, **Google Antigravity / AGY**, **OpenAI Codex CLI**, or **Cursor**):

```text
Please set up AgentHub on my system:
1. Install `@habom2310/agenthub` globally if not already installed (`npm install -g @habom2310/agenthub`).
2. Run `agenthub setup` to initialize the hub, link skills, and project rules to all installed AI assistants.
3. If any blockers are reported, inspect the output and resolve them or run `agenthub doctor --fix`.
4. Run `agenthub doctor` to confirm that all checks pass.
```

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

Share your configuration across machines or publish packages to the AgentHub registry:

```bash
# Push hub config to remote Git repository and generate share command
agenthub share -m "Update team engineering rules"

# Push and publish package to the AgentHub registry
agenthub share --publish
```

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
| `agenthub setup` | One-command setup: scaffold hub, auto-wire assistants, and configure MCP |
| `agenthub init [--migrate <path>] [--scaffold-only]` | Initialize `~/.agenthub` directory structure (runs full setup by default or scaffold-only) |
| `agenthub detect` | Detect installed AI coding assistants and configuration status |
| `agenthub doctor [--fix]` | Diagnose configuration issues and auto-repair broken junctions/rules |
| `agenthub search [query]` | Search the AgentHub registry for packages, addons, and profiles |
| `agenthub info <target>` | Inspect package metadata, security analysis, scripts, and token footprint |
| `agenthub add <target>` | Install an agent package, profile, or addon into the hub |
| `agenthub profile [list\|create\|use]` | List, create, or switch between isolated configuration profiles |
| `agenthub share [--publish]` | Audit, push, and publish hub configurations to Git remote or registry |
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
- `AGENTHUB_REGISTRY_URL`: Override the AgentHub package registry URL (default: official registry).

---

## License

[MIT](LICENSE) © habom2310
