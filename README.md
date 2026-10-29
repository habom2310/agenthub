# AgentHub

[![npm version](https://img.shields.io/npm/v/@habom2310/agenthub.svg)](https://www.npmjs.com/package/@habom2310/agenthub)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node: >=20.0.0](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)

**Your agent setup, versioned, synced and shareable. Write your rules and skills once; every AI coding assistant on your machine uses them.**

```bash
npm install -g @habom2310/agenthub && agenthub setup
```

Works with **Claude Code · OpenAI Codex · Google Antigravity · Cursor · Windsurf · GitHub Copilot CLI**

---

## Why AgentHub?

### The problem: your best prompts are scattered and stuck

If you use more than one AI coding assistant, you know the routine:

- You write a great rule in `CLAUDE.md`. Then copy it into `AGENTS.md` for Codex. Then `GEMINI.md`. Then a Cursor `.mdc` file. A week later they have all drifted apart.
- You install a skill for Claude Code, and Cursor never sees it.
- You add an MCP server in one tool and configure it again, by hand, in three others.
- You get a new laptop and rebuild your whole setup from memory.
- A teammate has a setup that makes their agent noticeably better, and the only way to get it is a screenshot in Slack.

Code has had Git and GitHub for years. **Agent configuration has nothing.** It lives in hidden dot-folders, in a different format for every vendor, with no history, no sync and no way to share.

### The fix: one hub, many assistants

AgentHub gives you a single source of truth at `~/.agenthub`:

```text
            ~/.agenthub  (one Git repo)
     rules · skills · subagents · MCP servers
                     │
     ┌──────────┬────┴─────┬──────────┬──────────┐
     ▼          ▼          ▼          ▼          ▼
 CLAUDE.md  AGENTS.md  GEMINI.md  Cursor .mdc  Windsurf
  ~/.claude  ~/.codex   ~/.gemini  ~/.cursor   ...
```

- **Write once, project everywhere.** Rules are compiled into each assistant's native format. Skills are linked, not copied, so there is one copy to edit.
- **Catch drift.** Edited `CLAUDE.md` directly? `agenthub diff` shows it, and `agenthub promote` pulls the change back into the hub.
- **Sync MCP servers** across assistants without overwriting their auth tokens.
- **Version it like code.** The hub is a Git repo: history, rollback, and `agenthub push` / `agenthub pull` across all your machines.
- **Safe by default.** Setup backs up every file it touches, and `agenthub uninstall` puts everything back.

---

## The vision: GitHub for agent setups

Syncing your own machine is step one. The bigger idea is that **a good agent setup is worth sharing**, just like good code.

Today, the best prompts, rules, skills and subagents are spread across blog posts, gists and Discord threads. You can't try one safely, you can't tell what it will cost in tokens, and you can't update it when the author improves it.

AgentHub treats an agent setup as a **package**:

| Like GitHub does for code | AgentHub does for agent setups |
|---|---|
| A repo holds your code | Your hub holds your rules, skills, subagents and MCP servers |
| `git push` | `agenthub share` |
| Browse and star repos | `agenthub search` and the [AgentHub registry](https://agenthub-web.habom2310.workers.dev) |
| `git clone` | `agenthub add <owner>/<repo>` or `agenthub profile use <owner>/<repo>` |
| Code review before merge | `agenthub info` scans for secrets, risky scripts and token cost before you install |

```bash
agenthub search code-review          # find a setup someone else built
agenthub info alice/review-squad     # check its risk level and token footprint
agenthub add alice/review-squad      # install it into your hub, for every assistant
```

Share yours in two commands:

```bash
agenthub share --publish -m "My TypeScript setup"
```

### Built on Git: every setup is just a repo

AgentHub doesn't invent its own storage or sync. **Your hub is a plain Git repository, and every package is a Git repo.** The registry is an index that points to them.

```text
 Your machine                 GitHub                     AgentHub registry
 ~/.agenthub  ── share ──▶  you/my-setup  ◀── indexes ──  search · info · listing
 (git repo)   ◀── pull ───  (public repo)
                                  │
 Their machine                    │
 ~/.agenthub  ◀──── add / profile use (git clone) ────┘
```

What this gives you:

- **Your files stay yours.** Your setup lives in your own GitHub repo, not on our servers. The registry stores only the listing (name, description, tags, scan results). If the registry disappears, `agenthub add you/my-setup` still works, because it clones straight from GitHub.
- **Everything Git already does, for free.** Full history, diffs, blame, branches, rollbacks, forks, pull requests and GitHub's own access control.
- **Contribute to someone's setup the way you'd contribute to code.** Fork it, improve a rule, open a PR.
- **Ownership follows the repo.** You can only publish or unpublish a package if you have push access to its GitHub repo. `agenthub login` checks this with your GitHub account.
- **Private works too.** Point `agenthub add` at any Git URL (`https://...` or `git@...`), such as a private team repo. The public registry is optional.

```bash
agenthub git init --remote-url git@github.com:you/my-setup.git   # turn your hub into a repo
agenthub push -m "Tighten review rules"                          # commit + push
agenthub pull                                                    # on another machine: pull + re-project
agenthub add git@github.com:my-team/agent-setup.git              # install from any Git URL
```

**Where we are going:**

- ✅ Local hub: one source of truth for six assistants
- ✅ Git sync across machines
- ✅ Public registry with search, install and GitHub login for publishing
- ✅ Security scan and token budget before you share or install
- 🔜 Versioned packages and updates (`agenthub update`)
- 🔜 Ratings, usage stats and curated collections on the registry
- 🔜 Team hubs: one shared setup for a whole org

If you have a setup you're proud of, [publish it](docs/GUIDE.md#6-sharing--publishing). If you have an idea for where this should go, [open an issue](https://github.com/habom2310/agenthub/issues).

---

## Who is it for?

- **You use two or more AI coding assistants** and are tired of keeping their rules in sync.
- **You work on more than one machine** and want the same agent everywhere.
- **You lead a team** and want everyone's agents to follow the same conventions.
- **You've built a great setup** and want others to use it.

---

## Documentation

The [full guide](docs/GUIDE.md) covers:

- [Installation](docs/GUIDE.md#installation), including a prompt to have your AI assistant set it up for you
- [What `setup` changes](docs/GUIDE.md#what-agenthub-setup-does-automatically) and how to fix blockers
- [Usage guide](docs/GUIDE.md#usage-guide): rules, MCP sync, skills, profiles, Git sync and rollback
- [Sharing and publishing](docs/GUIDE.md#6-sharing--publishing) your setup to the registry
- [CLI command reference](docs/GUIDE.md#cli-command-reference) and [environment variables](docs/GUIDE.md#environment-variables)

---

## License

[MIT](LICENSE) © habom2310
