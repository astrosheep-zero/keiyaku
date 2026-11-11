---
name: keiyaku-debt
description: >-
  Must read when recording confirmed unresolved work or dependencies in `Debts`.
---

# Keiyaku Debt

A `Debt` records confirmed unresolved work and its relationships (`open`, `done`,
`drop`). Unlike a `kei`, a `Debt` does not require a closed design — use it to
capture a confirmed problem or prerequisite that must outlive the current
conversation, while keeping transient scratch plans in session notes.

## 1. Recording A Useful `Debt`

- **Self-contained body:** write enough concrete evidence (files, symbols,
  repro, or why work was deferred) that a future reader can act on the `Debt`
  cold without rediscovering the problem.
- **Priority (`0..3` ascending):** `0` is highest urgency (`priority <= 1`
  selects high-priority work in queries).
- **No mirror `Debts`:** never create a `Debt` just to mirror an already-bound `kei`.

## 2. Relationships And Readiness

Only `needs` orders work: a `Debt` with unresolved `needs` is `blocked`, and
becomes `ready` once every prerequisite is `done` or `drop`. Do not add `needs`
merely because two `Debts` touch the same `Region` or are related.

- `needs`: prerequisite that must become terminal first.
- `parent`: decomposition grouping (does not block).
- `supersedes`: earlier `Debt` replaced by this one.
- `relates`: non-blocking link.

`show` displays only outbound relations declared on that `Debt`; use `tree`
or `query` (`blocks`, `under`, `ready`, `blocked`) to inspect reverse links.

## 3. Scope And `Contract` Settlement

- **Namespace scope:** supply a namespace explicitly when filing work under a
  `Contract`; omitted namespace selects the root even inside a worktree. Use
  `ls debt/<namespace>/` for that namespace (the existing query operation with
  ordinary listing selection) or `query --world` to inspect across
  namespaces. Always address a specific `Debt` by its complete `debt/...` ID.
- **`Contract` settlement:** associating a `Debt` when binding a `kei` holds that
  `Debt`; accepting the `kei` marks it `done`, while abandoning the `kei`
  releases it back to `open`.
