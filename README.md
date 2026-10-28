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
npx @habom2310/agenthub <command>
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
agenthub doctor
```

---

## Quickstart

### 1. Initialize Your Hub
Create the central `~/.agenthub` directory structure with starter engineering heuristics, subagents, and template configurations:

```bash
agenthub init
```

*Migrating from an existing directory?* Run migration mode to preserve your custom rules and skills:
```bash
agenthub init --migrate <path>
```

### 2. Verify System Health
Run diagnostic checks on your environment, directory junctions, and assistant configurations:

```bash
agenthub doctor
```

If any broken junctions, missing platform files, or invalid links are detected, auto-heal them:
```bash
agenthub doctor --fix
```

### 3. Check Detected Platforms
Inspect which AI coding assistants are installed and active on your machine:
```bash
agenthub detect
```

---

## Hub Directory Architecture

Your configuration lives in a central hub (`~/.agenthub` or `$AGENTHUB_HOME`):

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

### 4. Boot Token Budget Auditor

Measure the minimal context footprint of your core rules and skill descriptions against the recommended 2,000-token boot target:

```bash
agenthub budget
```

### 5. Multi-Machine Sync (Git Federation)

Version control and synchronize your dotfiles across multiple machines:

```bash
# Initialize git in ~/.agenthub with a remote repository
agenthub git init --remote-url git@github.com:username/my-agenthub.git

# Commit and push changes
agenthub push -m "Add new coding rules and MCP servers"

# Pull latest changes on another machine and re-project rules
agenthub pull
```

### 6. Export Rules for Web Assistants

Generate concatenated prompt blocks ready to paste into web assistants:

```bash
# Generate ChatGPT Custom Instructions
agenthub export chatgpt

# Generate Claude Web Projects System Prompt
agenthub export claude-web

# Generate Cursor Project Prompt Block
agenthub export cursor
```

### 7. Rollback & Uninstallation

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
| `agenthub init [--migrate <path>]` | Initialize `~/.agenthub` directory structure or migrate from an existing directory |
| `agenthub detect` | Detect installed AI coding assistants and status |
| `agenthub doctor [--fix]` | Diagnose configuration issues and auto-repair broken junctions/rules |
| `agenthub project` | Compile and project unified rules and subagents to configured platforms |
| `agenthub diff` | Detect drift between hub rules and downstream platforms |
| `agenthub promote [file]` | Promote downstream rule edits back into central hub |
| `agenthub mcp status` | Display registered MCP servers across assistants |
| `agenthub mcp sync` | Bidirectionally synchronize MCP server configurations |
| `agenthub link` | Create directory junctions linking `skills/` across all platforms |
| `agenthub connect <platform>` | Connect an assistant platform by linking skills and projecting rules |
| `agenthub budget` | Audit rule and skill token usage against boot token budget |
| `agenthub export <target>` | Export concatenated rules for web assistants (`chatgpt`, `claude-web`, `cursor`) |
| `agenthub git status` | Display Git repository and remote synchronization status |
| `agenthub git init --remote-url <url>` | Initialize hub Git repository with remote URL |
| `agenthub push [-m <msg>]` | Stage, commit, and push hub configurations to Git remote |
| `agenthub pull` | Pull updates from Git remote and reproject rules |
| `agenthub uninstall [--purge] [-y]` | Roll back assistant rules and junctions to original state, and optionally remove hub |

---

## Environment Variables

- `AGENTHUB_HOME`: Override the default user home directory.
- `AGENTHUB_HUB`: Override the default hub directory (default: `~/.agenthub`).

---

## License

[MIT](LICENSE) © habom2310
