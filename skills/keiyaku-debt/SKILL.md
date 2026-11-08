---
name: keiyaku-debt
description: >-
  Must read when recording confirmed unresolved work or dependencies in Debts.
---

# Keiyaku Debt

A Debt records confirmed unresolved work and its relationships (`open`, `done`,
`drop`). Unlike a `kei`, a Debt does not require a closed design — use it to
capture a confirmed problem or prerequisite that must outlive the current
conversation, while keeping transient scratch plans in session notes.

## 1. Recording A Useful Debt

- **Self-contained body:** write enough concrete evidence (files, symbols,
  repro, or why work was deferred) that a future reader can act on the Debt
  cold without rediscovering the problem.
- **Priority (`0..3` ascending):** `0` is highest urgency (`priority <= 1`
  selects high-priority work in queries).
- **No mirror Debts:** never create a Debt just to mirror an already-bound `kei`.

## 2. Relationships And Readiness

Only `needs` orders work: a Debt with unresolved `needs` is `blocked`, and
becomes `ready` once every prerequisite is `done` or `drop`. Do not add `needs`
merely because two Debts touch the same Region or are related.

- `needs`: prerequisite that must become terminal first.
- `parent`: decomposition grouping (does not block).
- `supersedes`: earlier Debt replaced by this one.
- `relates`: non-blocking link.

`show` displays only outbound relations declared on that Debt; use `tree`,
parent-scoped `ready`/`blocked`, or `query` (`blocks`, `under`) to inspect
reverse links.

## 3. Scope And Contract Settlement

- **Namespace scope:** an appointed Contract worktree scopes its default Debt
  context to `debt/<contract>/...`. Select the root namespace `/` when filing a
  repo-wide Debt from inside a worktree, and enable world scope on `ls`,
  `ready`, `blocked`, or `query` to inspect across all namespaces. Always
  address a specific Debt by its complete `debt/...` ID.
- **Contract settlement:** associating a Debt when binding a `kei` holds that
  Debt; accepting the `kei` marks it `done`, while abandoning the `kei`
  releases it back to `open`.
