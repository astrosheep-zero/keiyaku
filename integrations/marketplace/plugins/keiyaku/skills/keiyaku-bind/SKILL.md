---
name: keiyaku-bind
description: >-
  Must read before binding a `kei` (Contract). Use when deciding what belongs
  in one `kei`, how to divide its work, and how to write or run `bind`.
---

# Before Binding A Keiyaku

Bind records a Contract whose objective, design, and acceptance boundary are
settled. Do not use it to leave an open design for someone else to decide.

## 1. What Must Be Clear Before Binding

Settle these facts first:

- objective and intended outcome;
- architecture and module boundaries;
- detailed design and implementation approach;
- public interfaces, behavior, data, and persistence;
- ordering, concurrency, dependencies, and failure behavior;
- acceptance conditions;
- verification and required evidence;
- the affected Region;
- the one holder responsible for the `kei`.

The Design section is a detailed design document. It may contain subsections
such as:

- Architecture: components, module boundaries, ownership, and connections;
- Interfaces And Behavior: public surfaces, inputs, outputs, success, and
  refusal behavior;
- Data And Persistence: data shape, identity, lifecycle facts, and persistence;
- Approach And Flow: implementation approach, dependencies, ordering,
  concurrency, and failure handling;
- Pseudocode: algorithms and control flow.

Record every design decision the implementation must follow. Add other Design
subsections when needed. Do not bind while the architecture, design, approach,
or acceptance conditions are open.

### Contract Shape

- Bind separate `kei`s for outcomes that can be accepted independently.
- Use an Arc for a chapter inside one `kei`; an Arc is not separately accepted.
- Use a Task for decomposition or dependency memory that must outlive the
  current conversation.

A `kei` owns one independently acceptable outcome and its delivery lifecycle. A
Task records decomposition or dependency memory; it may exist without a `kei`,
and it does not create a second acceptance or lifecycle. Associate a `kei` with
an existing Task only when that Task has real scheduling or dependency value.
Do not create a Task just to mirror a `kei`.

### Parallel Work

Parallel work is the default.

- Bind and advance independent `kei`s in parallel. Each has its own acceptance
  boundary and holder.
- Within one `kei`, run independent Tasks or Arc chapters in parallel whenever
  their work can proceed independently. They converge on the one acceptance
  boundary, which the holder owns.

Region overlap is planning information. It does not prevent parallel work and
is not a lock, ownership claim, exact diff, or dependency. Use `--after` only
when one result must exist before another can proceed because of a real logical
dependency. Do not add `--after` merely because work touches the same Region.

## 2. Bind Syntax

Read the command's help for the complete option grammar:

```bash
keiyaku -C <repo> bind --help
```

Inspect declared Regions when planning parallel work:

```bash
keiyaku -C <repo> region
keiyaku -C <repo> region <kei/...>
keiyaku -C <repo> region --path 'src/**' --path 'tests/**'
```

These list active Regions, read one Contract's Region, or show active Regions
overlapping the supplied patterns. Overlap is coordination information only.

Bind from stdin with a heredoc or a saved Markdown file:

~~~~bash
keiyaku -C <repo> bind - <<'KEIYAKU'
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
<Implementation approach, dependencies, ordering, concurrency, and failure.>

### Pseudocode
<Algorithms and control flow.>

## Region
<One repository-relative write pattern per nonblank line.>

## Criteria
### <observable acceptance condition>
<How to observe pass or refusal.>

## Verification
```bash timeout=5m
<commands runnable exactly as written>
```
KEIYAKU
~~~~

Use the narrowest justified Region patterns for likely writes. A trailing `/`
is directory shorthand for `/**`. Patterns may be fenced lines, list items, or
bare lines; those forms are combined. Region patterns are planning evidence,
not a prediction of the exact diff.

Verification is optional. Each declaration is a closed bash, zsh, or pwsh
fence containing commands runnable as written. Use separate fences when checks
need different timeouts or results. Use an explicit timeout for bounded
commands; `5m` is the normal baseline.

Verification runs against the exact integration snapshot in a clean disposable
worktree for that attempt. It does not run in the author's worktree or the
target checkout. If the Contract declares Verification, `deliver` runs it when
no current `verified` attestation exists and otherwise reuses the current
attestation. A newly run unsatisfied result stops that delivery. `audit` runs
Verification for a prospective candidate. `--gates reviewed` requires review
evidence; it does not select or suppress Verification. Selected gates are
checked at placement.

For an existing Task with real scheduling or dependency value:

```bash
keiyaku -C <repo> bind --task <task/...> - < CONTRACT.md
```

For a real logical dependency between Contracts:

```bash
keiyaku -C <repo> bind --after <kei/...> - < CONTRACT.md
```

Gate selection is part of binding:

```bash
keiyaku -C <repo> bind --gates <name,...> - < CONTRACT.md
keiyaku -C <repo> bind --gates "" - < CONTRACT.md
keiyaku -C <repo> bind --gates reviewed - < CONTRACT.md
```

Omitting `--gates` uses `gates.default`, or `reviewed` when no default bundle
exists. `--gates ""` selects no gates. Gates are named acceptance obligations,
not work assignments.

## 3. After Binding

Read the receipt as the handoff. Keep the complete `kei/...` identity and note:

- the holder;
- the reported worktree, if one was created;
- the target;
- gates and prerequisites;
- whether the `kei` is ready or waiting.

If a worktree was created, work there. If the receipt is waiting, the stated
prerequisites remain; do not bind a duplicate Contract.

The holder now owns the lifecycle:

1. Start the work directly or delegate Tasks, Arc chapters, Akumas, or seats.
2. Run independent work in parallel and let it converge on the one acceptance
   boundary.
3. Prepare and deliver the candidate.
4. Coordinate verification, review evidence, gates, and prerequisites.
5. Continue until the `kei` is claimed, amend terms while keeping the same
   objective and acceptance boundary, or abandon it when either has changed.

Continue with `keiyaku-workflow` for this lifecycle. For Akuma invocation,
telling, waiting, permissions, and history, read `keiyaku-akuma`.
