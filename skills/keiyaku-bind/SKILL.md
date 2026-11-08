---
name: keiyaku-bind
description: >-
  Must read before binding a `kei` (Contract). Use when deciding what belongs
  in one `kei`, how to divide its work, and how to write or run `bind`.
---

# Before Binding A Keiyaku

`bind` records a Contract whose objective, design, and acceptance boundary are
closed. Never bind a wish list ("support X", "clean up Y") that leaves the
mechanism for the Deliverer to invent — if the design is still open, inspect
the codebase yourself or send an Akuma to settle the approach first (or record
a Debt if deferring the work).

## 1. Boundaries, Arcs, And Parallelism

- **One independently acceptable outcome per `kei`:** if part of the work can
  be reviewed and accepted while another part remains unfinished, bind them as
  separate `kei`s. Shared themes, workers, verification commands, or
  overlapping Regions do not justify combining outcomes.
- **Divide complex `kei`s into Arcs:** when one indivisible outcome is still
  large or multi-stage, break its execution into **Arcs** (`arc`) so each
  commission tackles one focused chapter (`This Arc: ...`) rather than a
  monolith.
- **Parallel lanes and `after`:** run independent `kei`s in parallel. Inspect
  active write surfaces with `region` for planning, and declare `after` only
  for true logical prerequisites. Omitting the target selects the current
  branch; targeting another active `kei` stacks on its appointed worktree.

## 2. Authoring The Contract Document

Put weight on **`### Approach And Flow`**: state the concrete mechanism, data
and control flow, invariants, and failure handling clearly enough that two
Deliverers would not invent incompatible designs.

~~~~markdown
# <Delivery name>

## Context
<Motivation, authority, baseline, and boundaries.>

## Objective
<One observable, independently acceptable outcome.>

## Design
### Architecture
<Components, module boundaries, ownership, and connections.>

### Interfaces And Behavior
<Public surfaces, inputs, outputs, success, and refusal behavior.>

### Data And Persistence
<Data shape, identity, lifecycle facts, and persistence decisions.>

### Approach And Flow
<Concrete mechanism, step-by-step flow, ordering, concurrency, and failure handling.>

### Pseudocode
<Key algorithms and control flow.>

## Region
<One repository-relative write pattern per nonblank line; trailing / means /**.>

## Criteria
### <observable acceptance condition>
<How to observe pass or refusal.>

## Verification
```bash timeout=5m
<commands runnable exactly as written>
```
~~~~

- **Gates and `verified`:** omitting gates uses `gates.default` if configured,
  otherwise `reviewed`. Without the `verified` gate, `## Verification` serves
  as reference documentation for the Deliverer and Reviewer rather than a gate
  requirement executed by `verify`.
- **Independent scratch:** each closed fence in `## Verification` runs in its
  own clean scratch directory; include any required build in that fence or its
  setup hook.

## 3. After Binding

Every `kei` has **one and only one holder** accountable for driving it to a
terminal outcome — you by default, unless you explicitly hand the entire holder
loop to one dedicated Akuma. Work and commit inside the appointed worktree path
from the receipt (run `reconcile` if appointment lagged), advance multi-stage
work with `arc`, and continue with `keiyaku-workflow`.
