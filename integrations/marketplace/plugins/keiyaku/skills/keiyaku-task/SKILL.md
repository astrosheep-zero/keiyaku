---
name: keiyaku-task
description: >-
  Must read when using Tasks for durable work planning, decomposition, or
  dependencies.
---

# Keiyaku Task

A Task is durable planning memory. It records work, decomposition, and
relationships that must remain after the current conversation. Task is an
independent product; it is not a Contract, Arc, Akuma, permission, acceptance
boundary, or fulfillment lifecycle.

## 1. When To Use A Task

Use a Task when the plan or dependency must outlive the current conversation.
Skip it when the work is small and no durable planning memory is needed.

- Use a `kei` for one independently acceptable outcome.
- Use an Arc for a chapter inside one `kei`.
- Use a Task for decomposition or dependency memory.
- Do not create a Task just to mirror a `kei`.

A Task may exist without a Contract. Associating a Task with a `kei` does not
transfer the Contract's holder, acceptance, or lifecycle to the Task.

## 2. Relationships And Parallel Work

Parallel work is the default. Independent Tasks may start and progress in
parallel.

Use the relationships for their actual meanings:

- `needs` means this Task must wait for another Task to become terminal.
- `parent` groups decomposition; it does not create a dependency.
- `supersedes` points to work replaced by this Task.
- `relates` records a connection without affecting readiness.

Only `needs` orders work. Do not add it because Tasks touch the same Region or
because one Task is related to another. A terminal Task releases its dependents.
An `on_hold` Task is deliberately paused; it is neither ready nor blocked.

## 3. Task Commands

Create and inspect Tasks:

```bash
keiyaku task add "<title>"
keiyaku task add "<title>" --priority 1 --needs <task-id>
keiyaku task show <task-id>
keiyaku task ls
keiyaku task ready
keiyaku task blocked
keiyaku task tree <task-id>
keiyaku task doctor
```

Use complete Task IDs for targeted commands. `ls`, `ready`, and `blocked` use
the current namespace; use `--world` to inspect the complete Task world.

Change lifecycle state:

```bash
keiyaku task start <task-id>...
keiyaku task stop <task-id>
keiyaku task hold <task-id>...
keiyaku task resume <task-id>
keiyaku task done <task-id>...
keiyaku task drop <task-id>... --note "<reason>"
```

Use `done` when the Task is complete. Use `drop` when it will not be done.
Both terminal states release dependent Tasks. Use `hold` for a deliberate pause,
not for an unresolved dependency; unresolved `needs` appear in `blocked`.

Update a Task without changing its lifecycle:

```bash
keiyaku task update <task-id> --title "<title>"
keiyaku task update <task-id> --body "<body>"
keiyaku task update <task-id> --needs <task-id>
```

Use `task compose -` when several Tasks and their relationships should be
planned or admitted together. Use `--plan` to inspect the composition without
writing it.

## 4. After Creating A Task

Read the returned Task identity. Then:

1. Start ready work.
2. Run independent Tasks in parallel.
3. Add or remove relationships when the plan changes.
4. Hold work that is deliberately paused.
5. Mark completed work `done`, or mark abandoned work `drop` with a reason.
6. Use `ready`, `blocked`, `tree`, or `doctor` to rebuild the current view.

Task records planning memory. It does not perform the work, claim acceptance,
assign a holder, or decide what a Contract may accept.

Read `keiyaku-bind` for Contract authoring and `keiyaku-workflow` for Contract
lifecycle.
