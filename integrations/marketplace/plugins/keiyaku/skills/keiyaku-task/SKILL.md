---
name: keiyaku-task
description: "Use when planning work in a Keiyaku v4 repo: add tasks, wire dependencies, inspect readiness, and track lifecycle."
---

# Keiyaku Task

Task is a directory-context planning product. It is separate from Contract
delivery and Akuma execution. A task records intent; `start` does not execute
it and no task command binds a Contract.

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
keiyaku-v4 task add "title"
keiyaku-v4 task add "title" --priority 1 --needs <task-id>
keiyaku-v4 task add --namespace <ns> -
keiyaku-v4 task show <task-id>
keiyaku-v4 task ls
keiyaku-v4 task ls --closed
keiyaku-v4 task ls --all --world
keiyaku-v4 task ready
keiyaku-v4 task blocked
keiyaku-v4 task tree <task-id> [--full]
keiyaku-v4 task doctor
```

`ls`, `ready`, and `blocked` use the current namespace; add `--world` to
observe the complete Task world. `show`, `tree`, `update`, and lifecycle
commands require a complete TaskId and never infer namespace.

## Mutations

```bash
keiyaku-v4 task start <task-id>
keiyaku-v4 task stop <task-id>
keiyaku-v4 task hold <task-id>
keiyaku-v4 task resume <task-id>
keiyaku-v4 task done <task-id>...
keiyaku-v4 task drop <task-id>... [--note <text>]
keiyaku-v4 task update <task-id> --title <text>
keiyaku-v4 task namespace [<namespace>]
```

Use `--json` on any command when a script must inspect the typed result. Use
`task compose -` for one atomic tree/graph edit; read its command help for the
composition grammar. Relations are explicit facts: `needs` orders work,
`parent` groups it, `supersedes` navigates replacement, and `relates` does not
affect readiness.
