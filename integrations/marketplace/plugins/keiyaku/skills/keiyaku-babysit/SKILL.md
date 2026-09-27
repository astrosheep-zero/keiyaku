---
name: keiyaku-babysit
description: >-
  Entering babysit mode: supervising parallel work across multiple Akuma and
  Contracts as they advance, instead of doing the work yourself.
---

# Keiyaku Babysit

Babysitting is a method, not a role: no new identity, permission, ledger,
status, id, or lifecycle. It is how whoever holds work in flight schedules
their own attention across it.

## Lanes At Any Grain

A lane is anything you are answerable for that moves without you: a Worker on
an Arc, a Reviewer mid-examination, a whole Contract whose fulfillment loop you
handed to one Aku. Handing work down narrows a lane; it never empties it — you
did not hand off your answerability, you booked yourself for the next question,
the next verify, the next return. When a Contract's whole loop is delegated,
your lane is the holder itself: watch the journaled record — bind, amends,
testimony, placement — verify at the boundaries you kept, and steer through the
holder, never past it. One delegated loop is one lane, however much moves
inside it.

## Attention

**Sweep.** Pass over every lane at natural pause points instead of dwelling on
one; depth goes where the sweep finds movement or silence that should not be
there.

**Critical path.** The lane the most other lanes wait on gets attention first,
regardless of which lane is loudest.

**Wait graph.** Know who waits on whom before deciding where to look; a cycle
in that graph is the emergency, everything else is schedule.

**Blocked lanes.** A blocked lane outranks every healthy one — unblock before
you optimize.

**Verify returns.** A return is not done because it arrived; it is done when
checked against what was asked. Book the verify when you delegate, not after.

**Steer early.** The cheapest steer is before divergence compounds: ask the
question at the first doubt, not at delivery.

**Lightest lane.** Keep each lane as light as it can be; do not babysit what
does not move without you.

## Failure Shapes

| Observed shape | First response |
| --- | --- |
| Silent wedge: initial answer empty and worktree clean | Inspect status and history, then send one steering `tell`. If the worker remains unresponsive, `kill` and call a new Akuma; an empty answer alone is not proof the Contract failed. |
| Verdict record refused with `not-allowed` | Read the worker's analysis in history; call a new Reviewer with the grant from `keiyaku-workflow`, then have it inspect current work and record a fresh verdict. The refused request wrote no Contract testimony. |
| Review stale after changed candidate tender | Normal content-currentness result. Give the same Reviewer the changed diff and current terms with `tell`; have it re-examine and record current testimony. A target move alone does not stale review. |
| Target moved under the appointed worktree | Have the Deliverer inspect target movement and merge the target branch (main when selected) in that worktree when required; resolve conflicts there, then audit again. Do not resolve against a stale integration preview. |
| Typed refusal names its rule | Fix the named input or physical condition, then retry from a fresh observation. Do not repeat the same request blindly. |

## What Babysitting Never Owns

Commands and semantics belong to task, bind, workflow, and akuma. Acceptance
belongs to the Contract's journal and its Reviewer's testimony. The question
belongs to whoever commissioned it. Babysitting decides only when you look and
what you check next.
