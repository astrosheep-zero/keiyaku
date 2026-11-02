---
name: keiyaku
description: >-
  Keiyaku is a CLI that records unresolved work, writes handoff terms for deliveries,
  and calls delegates. Use this skill when you need to figure out which
  Keiyaku skill or command to reach for.
---

# Keiyaku

## Model

Keiyaku has three independent pillars: **Debt** records unresolved work,
**Contract** makes acceptance auditable, **Akuma** runs delegates. Use any one
alone. Each Contract in flight has one holder who runs its loop: you by
default, or one Aku you hand the whole loop to.

- Shaping and binding a Contract: `keiyaku-bind`
- Holding a Contract to acceptance: `keiyaku-workflow`
- Calling and steering Akumas: `keiyaku-akuma`
- Recording unresolved work: `keiyaku-debt`
- Watching many lanes at once: `keiyaku-babysit`

## Quick Start

```bash
keiyaku -C <repo> debt add "title"
keiyaku -C <repo> bind [--debt <debt/...>] -
keiyaku -C <repo> status
keiyaku -C <repo> deliver [<contract>|@<contract>]
keiyaku -C <repo> review [<contract>|@<contract>] --satisfied --summary "<evidence>"
```

`-C <path>` sets the invocation directory and with it the World. `--repo <path>`
only picks the Contract repository. `call --workdir <path>` only picks where the
Akuma runs.
