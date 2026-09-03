---
name: keiyaku
description: Use the Keiyaku v4 CLI for contract delivery, task coordination, and Akuma work.
---

# Keiyaku

## Model

Keiyaku is three independent pillars, not a bundle: **Task** remembers plans
and dependencies, **Contract** makes acceptance standing and auditable,
**Akuma** invokes capability. Use any one alone; combine them only when the
work calls for it. Behind every Contract in flight there is one holder of its
fulfillment loop — whoever turns intent into commissions and returns into
decisions. The flagship holds it by default, and may hand a whole Contract's
loop to one Aku in a single commission; the harness serves both styles
equally. See `keiyaku-workflow` for the loop, `keiyaku-bind` for authoring,
`keiyaku-akuma` for invocation.

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
keiyaku -C <cwd> call <akuma-name> [--contract <kei/...>] [--alias @name] [--readonly] [--allowed <product.action>]... [--schema <file>] [--wait <duration> | -d | --detach] [--json] (<prompt> | -)
keiyaku -C <repo> wait <akuma-selector>... [--any | --all]
keiyaku -C <repo> tell <aku/...|@alias> (<prompt> | -)
```

`-C` is the invocation and Akuma execution cwd. Add `--repo <path>` only when
a Contract or Dispatch reader must use a different Git repository.

Repeated `--allowed` values add actions to the selected Akuma's defaults. A
nested call can use only actions permitted by its direct parent Soul.

Use text by default; add `--json` when a script needs structured output.
