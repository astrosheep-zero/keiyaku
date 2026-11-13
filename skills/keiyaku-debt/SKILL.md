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
- **Priority (`0..3` ascending):** `0` is highest urgency; catalogue rows use
  priority and then complete identity order.
- **No mirror `Debts`:** never create a `Debt` just to mirror an already-bound `kei`.

## 2. Relationships And Readiness

Only `needs` orders work: a `Debt` with unresolved `needs` is `blocked`, and
becomes `ready` once every prerequisite is `done` or `drop`. Do not add `needs`
merely because two `Debts` touch the same `Region` or are related.

- `needs`: prerequisite that must become terminal first.
- `parent`: decomposition grouping (does not block).
- `supersedes`: earlier `Debt` replaced by this one.
- `relates`: non-blocking link.

`show` displays outbound relations declared on that `Debt`; use `tree` to inspect
decomposition. Native readiness and blocked views interpret unresolved `needs`.

## 3. World Ledger And `Contract` Settlement

- **World ledger:** `ls debt/` lists open work across the World; its selection
  option chooses terminal work or both. Address a specific `Debt` by its complete
  flat `debt/<id>` identity. A managed worktree shares its repository's ledger.
- **`Contract` settlement:** associating a `Debt` when binding a `kei` holds that
  `Debt`; accepting the `kei` marks it `done`, while abandoning the `kei`
  releases it back to `open`.
