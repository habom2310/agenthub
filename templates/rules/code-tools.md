## Shell Commands & Background Tasks

- **Use `rg` (ripgrep) for searching**: Ripgrep (`rg`) is installed on the system. Always prefer `rg` over slow PowerShell pipelines like `Get-ChildItem -Recurse | Select-String`.
- **Never do unbounded recursive searches**: Never search unbounded across `~/.gemini`, `AppData`, or system root folders. Always exclude binary and active state files (`*.db`, `*.wal`, `*.lock`, `*.jsonl`, `node_modules/`, `.git/`).
- **Maximize sync wait time**: Set `WaitMsBeforeAsync: 10000` (the 10s maximum) for commands expected to finish synchronously to avoid premature backgrounding.
- **Kill superseded background tasks immediately**: If a command gets pushed to the background (`task-XYZ`) and its results are no longer strictly needed, immediately call `manage_task(Action="kill")`. Never leave orphaned background tasks spinning.
