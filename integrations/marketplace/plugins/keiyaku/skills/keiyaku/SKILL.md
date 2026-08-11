---
name: keiyaku
description: Use the Keiyaku v4 CLI for contract delivery, task coordination, and Akuma work.
---

# Keiyaku

Use `keiyaku` as an agent-facing ledger. Keep decisions with the flagship;
read `<command> --help` before using flags.

## Model

- `task` is planning; see `keiyaku-task`.
- A Contract is delivery authority; see `keiyaku-workflow`.
- An Akuma is a callable worker; see `keiyaku-akuma`.

## Quick Start

```bash
keiyaku task add "title"
keiyaku task start <task-id>
keiyaku bind -
keiyaku status
keiyaku deliver [<contract>|@<contract>]
keiyaku review [<contract>|@<contract>] --satisfied
```

```bash
keiyaku call <akuma> [--cwd <path>] [--json] -
keiyaku wait <aku/...>
keiyaku tell <aku/...> -
```

Use text by default; add `--json` when a script needs structured output.
