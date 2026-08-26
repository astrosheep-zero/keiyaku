---
name: keiyaku
description: Use the Keiyaku v4 CLI for contract delivery, task coordination, and Akuma work.
---

# Keiyaku

Use `keiyaku` as an agent-facing ledger. Keep decisions with the flagship;
read `<command> --help` before using flags.

## Model

- `task` is planning; see `keiyaku-task`.
- A Contract is delivery authority; see `keiyaku-bind` to author and bind one,
  then `keiyaku-workflow` for the remaining lifecycle.
- An Akuma is a callable worker; see `keiyaku-akuma`.
- A long-running multi-lane goal needs coordination; see `keiyaku-babysit`.

Settings owns named gate bundles. Omitting `--gates` selects `gates.default`,
or freezes `["reviewed"]` when that entry is absent. `--gates <name,...>`
selects configured bundles in order; it does not add literal gate words.

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
keiyaku -C <cwd> call <akuma-name> [--contract <kei/...>] [--alias @name] [--readonly] [--allowed <product.action>]... [--wait <duration> | -d | --detach] (<prompt> | -)
keiyaku -C <repo> wait <akuma-selector>... [--any | --all]
keiyaku -C <repo> tell <aku/...|@alias> (<prompt> | -)
```

`-C` is the invocation and Akuma execution cwd. Add `--repo <path>` only when
a Contract or Dispatch reader must use a different Git repository.

Repeated `--allowed` values add actions to the Archetype defaults. Restriction
comes from the Archetype base and, for nested calls, the direct parent Soul.

Use text by default; add `--json` when a script needs structured output.
