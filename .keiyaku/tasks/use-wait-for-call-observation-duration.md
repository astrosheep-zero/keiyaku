---
id: task/use-wait-for-call-observation-duration
title: Use --wait for call observation duration
state: open
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-15T01:31:54.487Z
updatedAt: 2026-08-15T01:31:54.487Z
---
The `call` CLI wait control should be named `--wait`, not `--timeout`. The call grammar must expose waiting and its optional duration through the wait flag, while `-d`/`--detach` remains the separate nonblocking mode. Remove the call-specific timeout spelling from help, parsing, diagnostics, and focused tests without changing wait command timeout semantics.

Current evidence: `docs/cli.md` and `src/cli/commands/akuma.ts` currently advertise `call ... [--wait [--timeout <duration>] | -d | --detach]` and parse `--timeout` for call.