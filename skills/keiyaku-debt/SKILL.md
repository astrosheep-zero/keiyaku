---
name: keiyaku-debt
description: >-
  Must read when recording confirmed unresolved work or dependencies in `Debts`.
---

# Keiyaku Debt

A `Debt` records confirmed unresolved work and its prerequisites (`open`, `done`,
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

`show` displays current prerequisites and their availability. Native readiness
and blocked views interpret unresolved `needs`. Creation starts open; use update
to set disposition or its current explanation. Every state may be reopened or
changed to another state. Reopening a prerequisite blocks open dependents again.

Updates replace supplied values completely; omission preserves them. Pass one
comma-separated `--needs` value to replace prerequisites. `--needs ""`,
`--body ""`, and `--note ""` clear those fields; `--body -` accepts replacement
stdin, including an empty stream. The explanation is current context, not history.

## 3. World Ledger And `Contract` Settlement

- **World ledger:** `ls debt/` lists open work across the World; its selection
  option chooses terminal work or both. Address a specific `Debt` by its complete
  flat `debt/<id>` identity. A managed worktree shares its repository's ledger.
- **`Contract` settlement:** associating a `Debt` when binding a `kei` holds that
  `Debt`; accepting the `kei` marks it `done`, while abandoning the `kei`
  releases its association without changing the Debt's disposition. A released
  association is not restored when the Debt is explicitly reopened.
