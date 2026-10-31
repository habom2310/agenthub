# AgentHub Guide

Installation, usage and command reference for [AgentHub](../README.md).

## Supported Assistants

| Assistant | Detected at |
|---|---|
| Google Antigravity (AGY) | `~/.gemini` |
| Claude Code | `~/.claude` |
| OpenAI Codex CLI & ChatGPT | `~/.codex` |
| Cursor | `~/.cursor` |
| Windsurf | `~/.codeium/windsurf` / `~/.windsurf` |
| GitHub Copilot CLI | `~/.copilot`, or the `copilot` binary on your `PATH` |

### Where each assistant gets skills and MCP servers

| Assistant | Skills | MCP servers |
|---|---|---|
| Claude Code | `~/.claude/skills` (link to the hub) | `~/.claude.json` (`mcpServers`) |
| Antigravity / Gemini | `~/.gemini/config/skills.json` entry | `~/.gemini/config/mcp_config.json`, `~/.gemini/settings.json` |
| Codex | `~/.codex/skills` (link) | `~/.codex/config.toml`, `[mcp_servers.<name>]` tables |
| Cursor | no link of its own when Claude or Codex are linked, otherwise `~/.cursor/skills` (link) | `~/.cursor/mcp.json` (`mcpServers`) |
| Windsurf | `~/.codeium/windsurf/skills` (link) | `~/.codeium/windsurf/mcp_config.json` (`mcpServers`, remote servers use `serverUrl`) |
| Copilot CLI | `~/.copilot/skills` (link) | `~/.copilot/mcp-config.json` (`mcpServers`, entries carry `type` and `tools`) |

Only detected assistants are touched.
Cursor loads `~/.claude/skills` and `~/.codex/skills` as well as `~/.cursor/skills` ([Cursor docs](https://cursor.com/docs/skills)).
Linking all of them would list every skill twice, so agenthub skips the `~/.cursor/skills` link while Claude or Codex already provide the hub skills, and removes an earlier hub link there.
A real `~/.cursor/skills` folder is left alone.
Copilot CLI reads personal skills from `~/.copilot/skills` and `~/.agents/skills` only, so it gets its own link.

---

## Installation

### Option 1: Ask Your AI to Set It Up
Copy this prompt into Claude Code, Codex, Antigravity, Cursor, or any assistant that can run terminal commands:

```text
Set up AgentHub (https://github.com/habom2310/agenthub) on my machine:

1. Check that Node.js 20 or later is installed (`node -v`). If not, stop and tell me.
2. If `agenthub --version` fails, install it globally: `npm install -g @habom2310/agenthub`. Do not use sudo. If the install fails on permissions, stop and tell me.
3. Before running `agenthub setup`, tell me what it will change and wait for my OK: it creates the hub at `~/.agenthub` (backing up existing configs), links each detected assistant's skills folder to the hub (an existing folder such as `~/.claude/skills` is copied into the hub and renamed to `skills.old`, or to a timestamped `skills.old.<YYYYMMDD_HHMMSSZ>` if `skills.old` already exists, so no earlier backup is deleted), projects shared rules, and syncs MCP servers. It is safe to re-run. Do not add `--force` or `--migrate` unless I ask.
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
2. **Auto-wires all detected assistants**: creates directory junctions for shared skills (`~/.claude/skills`, `~/.gemini/config/skills.json`, `.codex/skills`, etc.), compiles and projects unified markdown rules (`GEMINI.md`, `CLAUDE.md`, `AGENTS.md`, Cursor MDC rules), and synchronizes MCP server definitions. An existing skills folder is copied into the hub and renamed to `skills.old`; if `skills.old` already exists, it is kept and the new backup goes to a timestamped `skills.old.<YYYYMMDD_HHMMSSZ>`. `agenthub uninstall` restores `skills.old` (the first backup); timestamped backups stay in place for you to restore or delete by hand.
A new hub declares its starter MCP server `codegraph` with a custom source (`check: codegraph --version`, `install: npm install -g @colbymchenry/codegraph`), so `setup` offers to install it as part of the install plan.
3. **Validates system health**: verifies all junctions, rule files, and MCP configs. When you approved the install plan or passed `--yes`, it also starts each MCP server and lists its tools (see [Health checks](#health-checks-agenthub-doctor)); otherwise it skips that step and tells you to run `agenthub doctor`.

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
├── agenthub.json          # Hub manifest, platform metadata, and skill/MCP source declarations
├── agenthub.lock.json     # Pinned commits and versions for declared sources (tracked)
├── rules/                 # Universal markdown engineering heuristics
│   ├── common.md          # Core heuristics (thinking, simplicity, surgical changes)
│   ├── code-tools.md      # Tool usage reflexes (Ripwire, CodeGraph, rg)
│   ├── handoffs.md        # Session handoff protocols
│   ├── addons/            # Optional modular rule extensions (*.md)
│   └── overrides/         # Platform-specific overrides (claude, agy, codex, cursor, windsurf)
├── agents/                # Subagent persona templates (scout, implementer, reviewer)
├── mcp/                   # Central Model Context Protocol registry
│   ├── servers.json       # Canonical MCP servers configuration
│   └── servers/<name>/    # Self-built MCP servers (tracked)
├── skills/                # Self-built skills (tracked) plus symlinks to installed third-party skills (ignored)
├── vendor/                # Third-party skill/MCP checkouts (gitignored, rebuilt by `agenthub install`)
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

Manage Model Context Protocol (MCP) servers centrally in `~/.agenthub/mcp/servers.json` and sync with `~/.claude.json`, `~/.gemini/config/mcp_config.json`, `~/.gemini/settings.json`, `~/.codex/config.toml`, `~/.cursor/mcp.json`, `~/.codeium/windsurf/mcp_config.json` and `~/.copilot/mcp-config.json`:

```bash
# View MCP server status across platforms
agenthub mcp status

# Synchronize servers bidirectionally (preserves platform auth keys and tokens)
agenthub mcp sync
```

Each assistant gets its own format:
- **Codex** gets `[mcp_servers.<name>]` tables (`command`, `args`, `env`, `cwd`, or `url` with `http_headers`). Only the tables of servers that changed are rewritten, so every other table and comment in `config.toml` stays as it was, and keys agenthub does not own (`enabled_tools`, `oauth`, ...) are kept.
- **Cursor** gets `command`/`args`/`env` or `url`/`headers`, without a `type` key.
- **Windsurf** gets the same, with `serverUrl` for remote servers.
- **Copilot CLI** gets `type` (`local` or `http`) and `tools` (`["*"]`, or the filter you set) on every entry.

Servers that exist only in an assistant are ingested into the hub with `${HOME}` and `${HUB}` placeholders (disabled Codex servers are not ingested).
A config file that does not parse is never overwritten: the sync reports `[SKIP]` and `agenthub doctor` flags it.
An entry that an assistant has under the same name as a hub server, but with a different config that agenthub never wrote or ingested there, is reported as `[CONFLICT]` and left alone, on all six assistants.
`agenthub doctor --fix` reports it and leaves it alone too.
Only an explicit `agenthub mcp sync --force` overwrites it, after copying each file it changes to `backups/mcp-sync-<timestamp>/` in the hub.
`~/.agenthub/mcp/origins.json` records which assistant each hub server was ingested from (`from`), where agenthub wrote it (`to`, recorded only after a successful write) and where an identical entry was already there before agenthub (`pre`).
It describes this machine, so the hub's `.gitignore` excludes it.
A hub from before this file existed has no record, so entries it wrote earlier show as conflicts until you run `agenthub mcp sync --force` once.
`${VAR}` in a server is written the way each assistant documents: Claude takes it as is, Cursor gets `${env:VAR}`, and Gemini expands it only in `env`.
Codex, Windsurf and Copilot CLI document no `${VAR}` expansion, so the server would receive the text literally, and `agenthub doctor` warns, naming the assistant and the variable.
A server that is disabled on an assistant (`enabled = false`, `disabled: true`) is not reported as untracked.
Config files keep their mode (a new one gets 0600) and a symlinked config stays a symlink.

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

#### Health checks: `agenthub doctor`

`agenthub doctor` checks that things work, not only that files exist.
Results are grouped as `[PASS]`, `[WARN]` and `[FAIL]` with a one-line reason, and the exit code is 1 when anything fails.

- **Setup**: links, rules and MCP registry sync, for every detected assistant.
- **MCP servers**: each hub server is started as the assistant would start it (`${HOME}`, `${HUB}` and `${VAR}` expanded). A stdio server is spawned, sent `initialize` and `notifications/initialized`, asked for `tools/list`, and its whole process tree is stopped. An HTTP server gets the same calls over POST (JSON or SSE responses, `Mcp-Session-Id` kept). The result is `PASS` with the tool count, `WARN` when only credentials are missing (an unresolved `${VAR}` in `env` or `headers`, or HTTP 401/403, "needs auth"), or `FAIL` with the reason: command not found, exit code with the last stderr lines, timeout, protocol error, or HTTP status. Values from `env`, `headers` and the URL's credentials and query are masked as `***` in every message, including `--json`. The server's stdout is capped at 4 MB. Up to four servers run at once, each with a 20 second limit (`--timeout <seconds>`).
- **Skills**: every hub skill and each assistant's own skills folder. `SKILL.md` must exist with valid frontmatter, a `name` that is lowercase letters, digits and hyphens and matches the folder, and a `description` of at most 1024 characters. Linked relative files must exist (`WARN`), files under `scripts/` should be executable on POSIX (`WARN`), the skill must resolve through every assistant path (`FAIL`), and a name that one assistant loads twice is a `WARN`.
- **Declared sources**: what `agenthub.json` declares, `agenthub.lock.json` pins and the machine has installed must agree. A declared custom `check` command is run and must exit 0.

Starting a server or running a `check` executes a command that your hub declares, so these steps run only because you asked for them:
- `agenthub doctor` runs them. `--no-functional` skips them (the file checks above still run).
- `agenthub setup` and `agenthub pull` list every MCP server they will start under "Will start to verify" (the full command line, or the full url including its query, the header names, and every environment variable that will be substituted), after the install plan, and ask once for both lists. They run only after you approve or pass `--yes`. Without a terminal and without `--yes` they start nothing and say so. Declining the plan on `setup` leaves the pending items as a note, not a failure.
- Nothing that plans or scans (`install` plan, `adopt`) runs them.

```bash
agenthub doctor                    # everything, including the MCP probes
agenthub doctor --no-functional    # file checks only, starts nothing
agenthub doctor --timeout 60       # slow npx/uvx cold starts
agenthub doctor --json             # machine-readable, same exit code
agenthub doctor --fix              # also offers the install flow (one plan, one consent, or --yes), then relinks and resyncs
```

### 3b. Adopt Existing Skills and MCP Servers

`agenthub adopt` brings skills and MCP servers that already exist in your assistants, but that the hub does not declare, under the hub.
It scans every detected assistant's skills folders and MCP configs (and `skills/` in the hub) and works out where each item came from by reading files only: nothing from the item is executed.

| Found | Proposed source |
|---|---|
| Skill (link or folder) inside a git checkout with a remote | `github:owner/repo#subpath`, or `git:<url>#subpath`, credentials removed, pinned to the checkout's commit (`ref`). The commit and the remote's last fetched HEAD are read from `.git` files; git is never run. It is confident only when both are the same commit. Local edits are not checked. |
| Skill linked into a tool-managed folder such as `~/.local/share/<tool>/skills/...` | `custom` with `check: test -f <path>/SKILL.md` and `path`; you supply the `install` command |
| Plain skill folder, no git | self-built (moved into `skills/` as `local`) or a source you enter |
| Claude Code plugin skill (under `~/.claude/plugins`) | reported only; optionally `custom` with `claude plugin install <plugin>@<marketplace>` |
| MCP `npx [-y] pkg[@version]` | `npm:pkg[@version]` |
| MCP `uvx pkg[==version]` | `pypi:pkg[@version]` |
| MCP command inside a git checkout | `git:` / `github:`, paths rewritten to `${HUB}/vendor/mcp/<name>`; asks for a build command when the command runs build output |
| MCP command on `PATH` | `custom` with `check: command -v <cmd>`; you supply the `install` command |
| MCP script in a folder of its own under your home folder, not in git (the folder has a `package.json` or `pyproject.toml`, or is named after the server) | the whole folder is moved to `mcp/servers/<name>/` as `local` |
| MCP script in a shared folder such as `~/.claude/hooks`, or a program in a `PATH` or tool bin folder (`~/.local/bin`, `~/.cargo/bin`, `~/.bun/bin`, `~/.npm-global`, pipx or venv `bin`, Homebrew, `node_modules/.bin`) | never moved: `custom` with a check, and you supply the `install` command |
| MCP server with a `url` | nothing to adopt |

```bash
agenthub adopt --dry-run   # print what was found and the proposed agenthub.json entries, change nothing
agenthub adopt             # in a terminal: per item, accept / self-built / enter source / skip
agenthub adopt --yes       # apply only inferences read from the item itself (github:, git:, npm:, pypi:), skip the rest
```

Without a terminal and without `--yes`, `adopt` prints the proposals and changes nothing.
After declaring items, `adopt` runs the normal install flow (one plan, one consent, or `--yes`), links skills and syncs MCP configs.
Files are never deleted: the original of anything moved is kept in `backups/adopt-<timestamp>/` in the hub (not next to it, where skill loaders would still find it), and so is a hub folder that a link replaces.
A custom skill `path` is checked after following symlinks.
It may point inside the hub, non-hidden folders of your home, `~/.local/share/<tool>/skills/`, `~/.claude/plugins/` or `~/.agents/skills/`, and an existing target must contain a `SKILL.md`.

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
   - `agenthub.json` is pushed as-is, but `agenthub profile use <you>/<repo>` takes only `name`, `description`, `type`, `tags`, `license` and `version` from it (any of these you leave out are removed from the user's file). The user keeps their own `platforms` and `links`.
   - `agenthub init --force` rewrites `agenthub.json` and drops these fields.
   - Missing fields fall back to: name = repo name, type = `profile`, license = `MIT`.
   - A `README.md` in `~/.agenthub` is shown on your package page.

4. **Check what you are about to share.**
   ```bash
   agenthub budget            # boot token cost of your rules and skills
   agenthub info ~/.agenthub  # security scan: risk level, scripts, MCP servers
   ```
   `share` runs the same scan and stops on hard-coded keys (GitHub, OpenAI/Anthropic `sk-`, AWS, private keys, Bearer tokens) in any hub file it pushes, including `rules/`, `agents/`, `skills/`, `mcp/servers.json`, `agenthub.json` and `README.md`. It also stops on high-risk scripts or MCP servers (shell interpreters, `curl`/`wget`, pipes, destructive commands). Warnings name the file and line, not the key. Fix them, or pass `--force` if you are sure they are safe.

   The standard ignored paths that `agenthub git init` writes to `.gitignore` (`backups/`, `.env`, `*.env`, ...) are not scanned; custom `.gitignore` lines are not honoured. The scan only knows these key formats, so still keep other secrets in environment variables, not in hub files.

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

### 7b. Skills and MCP Servers as Dependencies

The hub declares where each skill and MCP server comes from, like a code dependency.
`agenthub push` commits only your own work and the declarations.
Third-party code is fetched on each machine by `agenthub install`.

Declare sources in `~/.agenthub/agenthub.json` under the `skills` and `mcp` keys:

```json
{
  "skills": {
    "my-skill": "local",
    "review": "github:alice/review-squad#skills/review",
    "pinned": { "source": "github:alice/tools#skills/pinned", "ref": "v1.2.0" },
    "from-npm": "npm:@acme/skills@^1.0.0#skills/from-npm",
    "from-git": "git:https://git.example.com/team/skills.git#skills/x",
    "custom": { "install": "make install", "check": "test -d ~/acme/skill", "path": "~/acme/skill" }
  },
  "mcp": {
    "my-server": { "source": "local", "build": "npm ci && npm run build" },
    "vendored": { "source": "github:alice/mcp-thing", "build": "npm ci && npm run build" },
    "fetch": "npm:@modelcontextprotocol/server-fetch@latest",
    "docs": "pypi:mcp-docs@>=1.0",
    "tool": { "install": "brew install tool", "check": "command -v tool" }
  }
}
```

| Source | Skills | MCP servers |
|---|---|---|
| `local` | Real folder in `skills/<name>/` (tracked) | Folder in `mcp/servers/<name>/` (tracked), optional `build` run in that folder |
| `github:owner/repo[#subpath]` | Cloned to `vendor/skills/<name>/` at the locked commit, linked into `skills/` | Cloned to `vendor/mcp/<name>/`, optional `build` |
| `git:<url>[#subpath]` | Same as `github:` for any git URL | Same as `github:` |
| `npm:pkg@range[#subpath]` | `npm pack` extracted into `vendor/skills/<name>/` | Runs through `npx -y pkg@<locked version>` |
| `pypi:pkg@range` | Not supported | Runs through `uvx pkg==<locked version>` |
| `{ "install", "check", "path"? }` | `path` is the skill folder after install (see below) | Nothing to link |

`github:` and `git:` sources accept `{ "source": "...", "ref": "<branch, tag or sha>" }`.
A custom source runs `check` first and runs `install` only if `check` fails (exit code 0 means installed).
A custom skill `path` may start with `~`, and a relative path is relative to the hub.
It must be inside the hub or inside your home folder, and not home itself or a dot-directory such as `~/.ssh`, except `~/.local/share/<tool>/skills/`, `~/.claude/plugins/` and `~/.agents/skills/`. Symlinks are followed before the check, and an existing target must contain a `SKILL.md`.
Version ranges for `npm:` sources are limited to semver characters (letters, digits and `.^~<>=*+-`), so use `^1.2`, `~1.2`, an exact version or a tag.
Runtime settings (command, args, env, url) stay in `mcp/servers.json`.
For `npm:` and `pypi:` sources, `agenthub` creates the `servers.json` entry for you when it is missing and keeps its version on the locked one.
Use `${HUB}` and `${HOME}` in `command`, `cwd`, `url`, `args` and `env` values, for example `"args": ["${HUB}/vendor/mcp/vendored/dist/index.js"]`.
A leading `~` is also expanded, but only when it is `~` alone or `~/...`: in `command` and `cwd`, and in an `args` or `env` value only if the whole value is a path (so `--dir=~/x` is left alone).
A `url` only gets `${HUB}` and `${HOME}`.
They are expanded when projecting to Claude and Gemini, so the same hub works on every machine.
When `mcp sync` ingests a server from a client config, absolute paths under the hub or home are written back as `${HUB}` and `${HOME}`, with forward slashes.

**Lockfile.**
`agenthub.lock.json` records the resolved pin for every declared item: the commit SHA for `github:` and `git:`, the exact version for `npm:` and `pypi:`.
Install uses the lock when present and writes it when an item has no pin yet.
Commit it.

```bash
agenthub install            # plan, confirm once, install everything declared, link skills, sync MCP
agenthub install --yes      # no prompt
agenthub update             # re-resolve every pin, then install
agenthub update review fetch  # re-resolve only these items
```

`install` shows the full plan, with the exact command for every item, and asks one y/N question.
Planning runs nothing that the hub declares.
A custom item lists both its `check` and its `install` command, and `check` runs only after you approve, so an already installed tool is left alone.
Because of that, custom items appear in the plan on every run.
Without a terminal and without `--yes`, nothing is installed and the items are reported as pending (exit code 1).
Git, npm and uv are only needed for the sources that use them, and a missing tool is reported for that item only.
One failing item does not stop the others, and `agenthub` never runs `sudo`.
Custom `install`, `check` and `build` strings run through your shell, so `agenthub info` flags them as elevated risk.
Git, npm and uv commands never go through a shell, and lockfile commits and versions are validated before use.
A local MCP `build` reruns when the build string or the folder's contents change (`node_modules`, `.git` and common build output folders are ignored).

**Git.**
`vendor/` is gitignored, and every installed skill symlink in `skills/` is listed in a managed block of the hub `.gitignore`.
Self-built skills are committed as usual.
The share scan, the registry payload and `info` do not read `vendor/`, and they report the declared sources instead.

`agenthub add <owner/repo>` records each added skill as `github:owner/repo#skills/<name>` with its commit and vendors it instead of copying.
Credentials in a URL (`https://user:token@host/...`) are not recorded, and `add` warns when it drops them.
`agenthub add <local-dir>` copies the skills and declares them `local`.
Skills that are not declared at all keep working and are committed as before.

**New machine.**

```bash
npm install -g @habom2310/agenthub
agenthub setup
agenthub git init --remote-url git@github.com:you/my-agenthub.git
agenthub pull --yes     # replaces the scaffold defaults, installs the declared skills and MCP servers
```

`pull` into a fresh repository with no commits replaces the files `setup` scaffolded with the remote branch.
Any colliding file that is not untouched scaffold output is first moved to `backups/pre-pull-<timestamp>/` in the hub, and `pull` lists what it moved.
After every later `pull`, declared sources are installed and skills and MCP servers are re-projected (use `--no-reproject` to skip this).
`setup --yes` does the same install if the hub already declares sources, and reports pending items as blockers.

### 8. Multi-Machine Sync (Git Federation)

Version control and synchronize your dotfiles across multiple machines:

```bash
# Initialize git in ~/.agenthub with a remote repository
agenthub git init --remote-url git@github.com:username/my-agenthub.git

# Commit and push changes
agenthub push -m "Add new coding rules and MCP servers"

# Pull latest changes on another machine, re-project rules and install declared skills and MCP servers
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

Rollback also unlinks `~/.copilot/skills` and the other skill links (restoring `skills.old`), restores the pre-agenthub `~/.codex/config.toml`, `~/.cursor/mcp.json`, `~/.codeium/windsurf/mcp_config.json` and `~/.copilot/mcp-config.json` from the setup backup, and `~/.cursor/skills.old` when the Cursor link was removed.
For a config the backup did not cover, it removes only servers that `origins.json` says agenthub wrote there and that still match what the hub would write.
A server you had before agenthub, one you changed since, and with `--purge` any server that would exist nowhere else are kept, and listed under "Kept in place".

After rolling back configurations, remove the CLI itself:
```bash
npm uninstall -g @habom2310/agenthub
```

---

## CLI Command Reference

| Command | Description |
|---|---|
| `agenthub setup [--force] [--migrate <path>] [--templates <dir>] [--scaffold-only] [--yes] [--home <dir>]` | One-command setup: scaffold hub, auto-wire assistants, and configure MCP |
| `agenthub init [--force] [--migrate <path>] [--templates <dir>] [--scaffold-only] [--yes] [--home <dir>]` | Initialize `~/.agenthub` directory structure (runs full setup by default or scaffold-only) |
| `agenthub detect` | Detect installed AI coding assistants and configuration status |
| `agenthub doctor [--fix] [--no-functional] [--timeout <s>] [--json] [--yes]` | Check links, rules, skills and declared sources, start every MCP server and list its tools; auto-repair with `--fix` |
| `agenthub adopt [--yes] [--dry-run]` | Bring existing skills and MCP servers that the hub does not declare under the hub |
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
| `agenthub mcp <status\|sync [--force]>` | Display or bidirectionally synchronize MCP server configurations (Claude, Gemini, Codex, Cursor, Windsurf, Copilot CLI) |
| `agenthub link` | Create directory junctions linking `skills/` across all detected platforms |
| `agenthub connect <platform>` | Connect an assistant platform by linking skills and projecting rules |
| `agenthub budget` | Audit rule and skill token usage against boot token budget |
| `agenthub export <target>` | Export concatenated rules for web assistants (`chatgpt`, `claude-web`, `cursor`) |
| `agenthub git <status\|init>` | Manage hub Git repository initialization and remote synchronization |
| `agenthub push [-m <msg>]` | Stage, commit, and push hub configurations to Git remote |
| `agenthub pull [--yes] [--no-reproject]` | Pull updates from Git remote, reproject rules, and install declared skills and MCP servers |
| `agenthub install [--yes]` | Install the skills and MCP servers declared in `agenthub.json`, pinned by `agenthub.lock.json` |
| `agenthub update [names...] [--yes]` | Re-resolve lockfile pins (all or the named items), then install |
| `agenthub uninstall [--purge] [-y]` | Roll back assistant rules and junctions to original state, and optionally remove hub |

---

## Environment Variables

- `AGENTHUB_HOME`: Override the default user home directory.
- `AGENTHUB_HUB`: Override the default hub directory (default: `~/.agenthub`).
- `AGENTHUB_REGISTRY_URL`: Override the AgentHub package registry URL (default: `https://agenthub-web.habom2310.workers.dev`). Also settable per command with `--registry`.
- `AGENTHUB_TOKEN`: GitHub token for `share --publish`, `whoami` and `unpublish` (overrides the stored login; use in CI).
- `XDG_CONFIG_HOME`: Base for the credential file (`$XDG_CONFIG_HOME/agenthub/auth.json`).
