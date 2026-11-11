---
name: keiyaku-workflow
description: >-
  Read when holding a `kei`: its roles, lifecycle, handing roles to `Akumas`,
  and deciding to accept, `amend`, or `abandon`.
---

# Keiyaku Workflow

The holder drives one `Contract` from binding to `accepted` or `abandoned`.

## 1. Roles

A `kei` has three roles (one agent may fill multiple roles, except the `Reviewer`
must not be the `Deliverer` of the candidate under review):

- **`Holder` (one and only one per `kei`):** owns the fulfillment loop and
  acceptance until terminal. You are the holder unless you explicitly hand the
  entire loop for that `kei` to one dedicated `Akuma`; delegating `Deliverer` or
  `Reviewer` tasks never transfers or splits holder ownership.
- **`Deliverer`:** builds the change in the appointed worktree and tenders it
  with `deliver`.
- **`Reviewer`:** judges the candidate against the `Contract` terms and records
  `satisfied` or `unsatisfied` with `review`. The holder may review a worker's
  delivery directly.

## 2. Lifecycle And Evidence

- **Work & Preview:** commit in the appointed worktree (use `arc` to advance
  complex `kei`s chapter by chapter). Run a delivery preview to inspect the
  candidate, standing evidence, and target movement without mutating state. If
  the target branch moved and conflicts, merge the target head in the
  appointed worktree (or use delivery conflict handoff + dirty capture).
- **`verify`:** runs `## Verification` fences in independent clean scratch against
  the prospective integration regardless of gate selection. With `verified`, it
  records evidence and may complete placement; without it, it returns results
  without testimony, journal facts, or placement effects.
- **`deliver` & `review`:** `deliver` tenders the worktree
  candidate; `review` records verdict testimony before or after delivery.
  Neither runs `Verification`.
- **Automatic placement:** whichever of `deliver`, satisfied `review`, or
  post-delivery `verify` satisfies the last gate and `after` prerequisite
  automatically lands the candidate (retiring the worktree, settling bound
  `Debts`, and cascading any ready `after` dependents).
- **Target movement:** do not manually rebase or re-`deliver` just because the
  target branch moved. Keiyaku re-integrates clean target movement
  automatically, and `review` stays valid as long as the candidate's diff does
  not change. You only need to act if the receipt reports a merge conflict
  (resolve in the worktree and re-`deliver`) or `⧗ awaiting verification ...`
  (run a fresh `verify` directly without re-delivering).

## 3. Commissioning And Next Moves

Assign a role `@alias` when spawning an `Akuma` (`keiyaku-akuma`), pass the
appointed worktree as its working directory, and state the `Contract` ID,
worktree path, and current `Arc` in the prompt:

| Role | Commission | Return |
| --- | --- | --- |
| `Holder` (`@holder-<name>`) | Full `kei`, current `Arc`, appointed worktree, and holder loop. | Terminal receipt (`accepted` or `abandoned`). |
| `Deliverer` (`@deliverer`) | Objective/current `Arc`, appointed worktree, and whether to run `verify` and `deliver`. | `verify` and `deliver` receipts. |
| `Reviewer` (`@reviewer`) | `Contract` ID, appointed worktree, and instruction to inspect and record `review`. | `review` receipt. |

- **Unmet gates or review findings:** steer `@deliverer` with `tell`, or open
  the next `arc`.
- **Terms change within the same objective and boundary:** run `amend`.
- **Objective or acceptance boundary changes:** `abandon` and `bind` a new `kei`.
