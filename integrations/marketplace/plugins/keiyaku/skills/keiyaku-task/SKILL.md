---
name: keiyaku-task
description: "Use when planning work in a Keiyaku v4 repo: add tasks, wire dependencies, inspect readiness, and track lifecycle."
---

# Keiyaku Task

Task is a directory-context planning product. It is separate from Contract
delivery and Akuma execution. A task records intent; `start` does not execute
it and no task command binds a Contract. Task use is optional: create one only
when planning needs a durable reader such as priority, dependencies, readiness,
or coordination across deliveries. Do not create one as boilerplate before
binding a Contract. Contract `bind --task <task/...>` optionally associates an
existing Task through Settlement-owned TaskHolder: claim settles the current
held Task to `done`, and abandon releases it. Task Markdown carries no Contract
field.

## Lifecycle

```text
open -> in_progress -> done | drop
  |          |
  +-> on_hold <-+
```

Use `ready` for open tasks whose `needs` are terminal. `blocked` reports open
or in-progress tasks with unresolved needs. `on_hold` appears in neither view.
Both `done` and `drop` release dependents. `doctor` diagnoses the complete
world and never repairs it.

## Common Commands

```bash
keiyaku task add "title"
keiyaku task add "title" --priority 1 --needs <task-id>
keiyaku task add --namespace <ns> -
keiyaku task show <task-id>
keiyaku task ls
keiyaku task ls --closed
keiyaku task ls --all --world
keiyaku task ready
keiyaku task blocked
keiyaku task tree <task-id> [--full]
keiyaku task doctor
```

`ls`, `ready`, and `blocked` use the current namespace; add `--world` to
observe the complete Task world. `show`, `tree`, `update`, and lifecycle
commands require a complete TaskId and never infer namespace.

## Mutations

```bash
keiyaku task start <task-id>
keiyaku task stop <task-id>
keiyaku task hold <task-id>
keiyaku task resume <task-id>
keiyaku task done <task-id>...
keiyaku task drop <task-id>... [--note <text>]
keiyaku task update <task-id> --title <text>
keiyaku task namespace [<namespace>]
```

Use `--json` on any command when a script must inspect the typed result.
Relations are explicit facts: `needs` orders work, `parent` groups it,
`supersedes` navigates replacement, and `relates` does not affect readiness.

## Batch Create Or Modify

Use `task compose -` to create and modify multiple Tasks in one planning
document:

```bash
keiyaku task compose - <<'EOF'
ns=feature
+ Parent pri=0
Parent body.
  + Child needs=@task/existing
@task/existing pri=1 relates+=@task/other
Replacement body.
EOF
```

- Optional first line `ns=<segment/...>` selects the allocation namespace;
  `ns=` selects root.
- `+ <title>` creates a Task. `@task/<id>` modifies an existing Task.
- Two spaces of indentation assign the preceding shallower Task as `parent`.
- Inline assignments are `pri=`, `parent=`, `needs=`, `supersedes=`, and
  `relates=`. Relation values are comma-separated `@task/...` references.
- `=` replaces or clears a field. `+=` appends only to `needs`, `supersedes`,
  or `relates`.
- Prose after a node replaces its body; bare `body=` clears it. Prefix body
  lines beginning with `+ `, `@task/`, or `\` with one `\`.

Compose does not change Task lifecycle state. Each changed Task is admitted
independently; an incomplete result returns a canonical draft for the remaining
batch.
