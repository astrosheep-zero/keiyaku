---
name: keiyaku-task
description: >-
  Must read when recording confirmed unresolved work or dependencies in Tasks.
---

# Keiyaku Task

A Task records confirmed unresolved work and its relationships. Task is an
independent product; it is not a Contract, Arc, Akuma, permission, acceptance
boundary, or fulfillment lifecycle.

## 1. When To Use A Task

Use a Task when confirmed unresolved work or a dependency must outlive the
current conversation. Keep plans and execution progress in reasoning or session
notes instead.

- Use a `kei` for one independently acceptable outcome.
- Use an Arc for a chapter inside one `kei`.
- Use a Task for confirmed unresolved work and its prerequisites.
- Do not create a Task just to mirror a `kei`.

A Task may exist without a Contract. Associating a Task with a `kei` does not
transfer the Contract's holder, acceptance, or lifecycle to the Task.

## 2. Relationships And Parallel Work

Independent work may proceed in parallel when its dependencies allow it.
Task records no execution-progress state.

Use the relationships for their actual meanings:

- `needs` means this Task must wait for another Task to become terminal.
- `parent` groups decomposition; it does not create a dependency.
- `supersedes` points to work replaced by this Task.
- `relates` records a connection without affecting readiness.

Only `needs` orders work. Do not add it because Tasks touch the same Region or
because one Task is related to another. A terminal Task releases its dependents.

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

Close work:

```bash
keiyaku task done <task-id>...
keiyaku task drop <task-id>... --note "<reason>"
```

Use `done` when the Task is complete. Use `drop` when it is no longer owed.
Both terminal states release dependent Tasks. Unresolved `needs` appear in
`blocked`; open work with all prerequisites terminal appears in `ready`.

Update a Task without changing its lifecycle:

```bash
keiyaku task update <task-id> --title "<title>"
keiyaku task update <task-id> --body "<body>"
keiyaku task update <task-id> --needs <task-id>
```

## 4. After Creating A Task

Read the returned Task identity. Then:

1. Add or remove relationships when the confirmed prerequisites change.
2. Mark completed work `done`, or work no longer owed `drop` with a reason.
3. Use `ready`, `blocked`, `tree`, or `doctor` to inspect the current ledger.

Task records unresolved work. It does not perform the work, claim acceptance,
assign a holder, or decide what a Contract may accept.

Read `keiyaku-bind` for Contract authoring and `keiyaku-workflow` for Contract
lifecycle.
