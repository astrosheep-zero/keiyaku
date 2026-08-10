---
name: keiyaku
description: Use the Keiyaku v4 CLI for contract delivery, task coordination, and Akuma work.
---

# Keiyaku

Use `keiyaku-v4` as an agent-facing ledger. Keep decisions with the flagship;
read `<command> --help` before using flags.

## Model

- `task` is planning; see `keiyaku-task`.
- A Contract is delivery authority; see `keiyaku-workflow`.
- An Akuma is a callable worker; see `keiyaku-akuma`.

## Quick Start

```bash
keiyaku-v4 task add "title"
keiyaku-v4 task start <task-id>
keiyaku-v4 bind -
keiyaku-v4 status
keiyaku-v4 deliver [<contract>|@<contract>]
keiyaku-v4 review [<contract>|@<contract>] --satisfied
```

```bash
keiyaku-v4 call --persona <name> -
keiyaku-v4 wait <aku/...>
keiyaku-v4 tell <aku/...> -
```

Use text by default; add `--json` when a script needs structured output.
