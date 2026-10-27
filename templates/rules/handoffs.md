## Handoffs

- **Session Start / Resuming:** When starting work in a repository or when asked to continue/resume, check for active handoffs on the current branch (`python ~/.claude/skills/handoff/scripts/handoff.py headers` or `handoff headers`). If an active handoff exists for this branch or task, reference it, run drift check (`handoff drift <file>`), and pick up from its Next Steps before writing new code.
- **Wrapping up:** After a substantial piece of work (a feature or fix finished, or several files changed), offer in one line to write a handoff with the `handoff` skill. Write it only if the user agrees.
