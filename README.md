# agenthub

Unified configuration, skills, rules, and MCP management engine for AI coding assistants.

Zero Python dependencies. Single-binary bundled ESM. Sub-25ms cold startup.

Supports:
- **Google Antigravity (AGY)** (`~/.gemini`)
- **Claude Code** (`~/.claude`)
- **OpenAI Codex CLI & ChatGPT** (`~/.codex`)
- **Cursor** (`~/.cursor`)
- **Windsurf** (`~/.codeium/windsurf` / `~/.windsurf`)
- **GitHub Copilot CLI**

---

## Quickstart

Run directly via `npx` (requires Node.js 18+):

```bash
# Initialize ~/.agenthub with starter rules, agents, and templates
npx @habom2310/agenthub init

# Or migrate cleanly from an existing ~/.agentrc installation
npx @habom2310/agenthub init --migrate ~/.agentrc

# Run comprehensive system diagnostics
npx @habom2310/agenthub doctor

# Auto-repair broken junctions, missing rules, or unlinked skills
npx @habom2310/agenthub doctor --fix

# Check assistant platforms status
npx @habom2310/agenthub detect

# Synchronize MCP servers across Claude and Gemini
npx @habom2310/agenthub mcp sync
```

Alternatively, install globally:

```bash
npm install -g @habom2310/agenthub
agenthub doctor
```

---

## Core Capabilities

### 1. Unified Rules Projection & Markdown AST Chunker
Compile universal engineering heuristics from `~/.agenthub/rules/` (`common.md`, `code-tools.md`, `handoffs.md`) into host-native rule files (`GEMINI.md`, `CLAUDE.md`, `AGENTS.md`, `agentrc.mdc`, `global_rules.md`).

```bash
# Project rules and subagent templates to all installed platforms
agenthub project

# Detect downstream rule drift across platforms
agenthub diff

# Promote downstream rule edits back into the central hub
agenthub promote common.md
```

### 2. Bidirectional MCP Registry Sync
Centralize Model Context Protocol (MCP) servers in `~/.agenthub/mcp/servers.json` and bidirectionally sync across `~/.claude.json`, `~/.gemini/config/mcp_config.json`, and `~/.gemini/settings.json`, preserving non-MCP settings and user authentication tokens.

```bash
agenthub mcp status
agenthub mcp sync
```

### 3. Cross-Platform Directory Junctions & Platform Connectors
Uses unprivileged Windows NTFS directory junctions (`'junction'`) and POSIX symlinks to link skills directories without file duplication or administrative privileges.

```bash
# Connect new assistants
agenthub connect cursor
agenthub connect windsurf
agenthub connect codex
```

### 4. Git Federation & Remote Backup
Manage and sync your configuration across machines via Git:

```bash
# Initialize hub Git repository
agenthub git init --remote-url git@github.com:user/my-agenthub.git

# Commit and push updates with safe author fallback
agenthub push -m "Updated coding rules"

# Pull remote updates and automatically re-project rules
agenthub pull
```

### 5. Session Boot Token Budget Auditor
Audits the minimal context footprint of your core rules and skill descriptions against a 2,000 token boot target:

```bash
agenthub budget
```

---

## License

MIT © habom2310

