## Subagents

Delegate by default to custom subagents (defined in `~/.gemini/config/agents/`):

| Agent | Model | Purpose | Use when |
|---|---|---|---|
| `implementer` | inherit | Full tools | creating/editing files, running commands, builds and tests, following an existing design or spec |
| `reviewer` | pro | Read-only | reviewing code, checking diffs, assessing changes against a spec |
| `scout` | flash | Read-only | searching files, reading logs, finding information, gathering context |
| `research` | inherit | Native web search | web documentation lookup and live searches |

Rules:
- Never run more than 3 subagents at the same time. If more work is queued, wait for one to finish before starting another.
- Prefer these subagents when the task matches one of them.
- Use `scout` to gather context, `implementer` to make changes, then `reviewer` to check them. Do not ask `reviewer` or `scout` to fix anything.
- Give `implementer` one reviewable step per run. Split bigger work into several runs, each starting from the last one's report.

## Web Search & Image Generation

Use AGY's native capabilities directly:
- **Web search / research:** Use the built-in `search_web` tool or the `research` subagent.
- **Image generation:** Use the built-in `image-generator` subagent.

## PR review with Copilot

After creating any PR, run one Copilot CLI review round:
1. Run (blocks until done, then prints findings, which is the signal to start fixing):
   `copilot -p "Review PR #<N> in this repo. Read it with gh pr diff <N>. Post the review to GitHub with a single command: gh pr review <N> --comment --body '<body>', where the body starts with 'Automated review by GitHub Copilot CLI' followed by numbered findings (file, line, problem, suggested fix) or 'No findings.' Do not use pipes, heredocs, files, or command substitution. Then print the same findings as your final output, and state whether posting succeeded (with the exact error if not). Findings only, no diff summary." -s --allow-tool='shell(gh pr:*)' --deny-tool='shell(gh pr merge)' --deny-tool='shell(gh pr close)' --deny-tool='shell(gh pr edit)' --deny-tool='shell(gh pr ready)' --deny-tool='write'`
   Use `shell(gh pr:*)`: narrower rules like `shell(gh pr review:*)` don't match in non-interactive mode and Copilot's post gets denied.
2. If Copilot reports posting failed, post its printed findings yourself with `gh pr review <N> --comment`.
3. Fix the valid findings, commit and push.
4. Post a PR comment (`gh pr comment`) mapping each finding number to fixed (commit sha) or skipped (reason), noting it was written by AGY.
5. One round only unless asked for more.
6. After the Copilot fixes are pushed, run one `reviewer` subagent pass over the whole PR (`gh pr diff <N>`), telling it which Copilot findings are already settled. Fix its valid findings, commit and push, then post a second PR comment mapping each finding to fixed (commit sha) or skipped (reason). Also one round only unless asked for more.
