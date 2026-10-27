## Codex Defaults & Overrides

- **PR review with Copilot**:
  When creating a PR, run the standard Copilot CLI review round. Attribute review and resolution PR comments to **Codex** (not Claude Code or AGY).
- **Subagent Collaboration**:
  Use Codex collaboration tools with inherited supported models (`gpt-6.1-sol` or current model tier) instead of hardcoded external model identifiers. Honor delegation guidelines: scout for context, implementer for one reviewable change at a time, reviewer for read-only review; at most three concurrent subagents.
- **Offload to Antigravity CLI (agy)**:
  Where native image generation or search capabilities need specialized tools, delegate via `agy` CLI (`~/AppData/Local/agy/bin/agy.exe`) without skipping permissions.
- **Shell & Tool Execution**:
  RTK output compression is not assumed to be installed as a Codex hook; run standard shell commands without wrapping in `rtk`.
