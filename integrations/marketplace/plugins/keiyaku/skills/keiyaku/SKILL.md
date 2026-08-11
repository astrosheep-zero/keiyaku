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

Settings owns named gate sets. Omitting `--gates` selects `gates.default`, or
freezes an empty gate list when that entry is absent. `--gates <name>` selects
one configured set; it does not add a literal gate word.

## Quick Start

```bash
keiyaku -C <repo> task add "title"
keiyaku -C <repo> task start <task-id>
keiyaku -C <repo> bind [--task <task-id>] -
keiyaku -C <repo> status
keiyaku -C <repo> deliver [<contract>|@<contract>]
keiyaku -C <repo> review [<contract>|@<contract>] --satisfied
```

```bash
keiyaku -C <repo> call <akuma> [--contract <kei/...>] [--alias @name] [--workdir <path>] [--wait [--timeout <duration>] | -d | --detach] [--json] -
keiyaku -C <repo> wait <aku/...>
keiyaku -C <repo> tell <aku/...> -
```

Use text by default; add `--json` when a script needs structured output.
