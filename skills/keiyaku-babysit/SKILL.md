---
name: keiyaku-babysit
description: >-
  Entering babysit mode: supervising parallel work across multiple `Akuma` and
  `Contracts` as they advance, instead of doing the work yourself.
---

# Keiyaku Babysit

Babysitting is how you drive a fleet of parallel `Contracts` and `Akumas` to
completion without doing the implementation work yourself.

## 1. Two Lane Grains: Direct Holding vs. Delegated `Holder`

- **You hold the `kei` (`@deliverer-x`, `@reviewer-x`):** you dispatch the
  `Deliverer` and `Reviewer` for each chapter and advance `verify`, `deliver`, and
  `review` as each worker returns.
- **Delegated holder (`@holder-x`):** you handed the entire fulfillment loop for
  that `kei` to one dedicated `Akuma`. Watch the `Contract`'s journaled state
  (`status`, `wait kei/...`) and steer **through** `@holder-x` with `tell` —
  never bypass the holder to micromanage its workers directly.

## 2. The Event-Driven Supervision Loop

1. **Scan the board (`status`):** check which `kei`s are ready to land, which
   are waiting on `after` prerequisites or gates, and which `@alias`es are
   running (`●`), succeeded (`✓`), or failed (`!`). Use `ls "aku/*/*"` for
   the richer recent instance catalogue, `ls kei/` for active Contracts, and
   `status <kei/...|aku/...|@name>` for one identity; status does not batch selectors.
2. **Wait on the fleet (`wait`):** pass all in-flight worker `@alias`es to
   `wait` (wakes as soon as *any* worker settles by default), or pass active
   `kei/...` IDs to wait for journal transitions (do not mix `aku/...` and
   `kei/...` in one `wait`).
3. **Act on the waking lane immediately:** inspect its receipt or `history`,
   steer with `tell` or launch the next stage (such as `@reviewer` after
   `@deliverer` tenders), then return to `wait` for the remaining lanes.

## 3. Parallel Landing And Lane Recovery

- **When a sibling `kei` lands on the same target branch:** do **not** ask
  other lanes' `Deliverers` to rebase or re-`deliver` preemptively — Keiyaku
  re-integrates clean target movement and ready `after` dependents
  automatically, and standing `review` testimony stays valid when the diff is
  unchanged. Act only on what the receipt asks for:
  - `⧗ awaiting verification ...`: run a fresh `verify` directly (no rebase or
    re-`deliver`).
  - Merge conflict: have the `Deliverer` merge the target branch in the appointed
    worktree, resolve conflicts, and re-`deliver`.
- **Silent or wedged worker:** if a worker settles with an empty answer and
  clean worktree (or stalls without progress), check `history <aku>`, send one
  steering `tell`, or `kill` it and spawn a replacement assigned to the same
  `@alias`.
- **Unrecorded review verdict:** if `@reviewer` wrote its analysis in `history`
  without recording `review` testimony, read `history` and record the `review`
  verdict yourself (if you were not the `Deliverer`) or `tell` `@reviewer` to
  record it.
