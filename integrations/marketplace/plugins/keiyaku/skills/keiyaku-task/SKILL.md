---
name: keiyaku-task
description: >-
  Use when recording, decomposing, or tracking a complex task, typically
  involving three or more steps.
---

# Keiyaku Task

## What A Task Is Not

A Task remembers a plan: what is intended, what depends on what, what was
decided about sequence. It grants nothing — no acceptance, no permission, no
scope, no fulfillment loop. Whoever holds a Contract's loop uses Tasks when the
plan is worth remembering and skips them when it is not; nothing binds Tasks to
Arcs, Contracts, or Akuma as a package.

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
keiyaku task tree <task-id>
keiyaku task doctor
```

`ls`, `ready`, and `blocked` use the current namespace; add `--world` to
observe the complete Task world. `show`, `tree`, `update`, and lifecycle
commands require a complete TaskId and never infer namespace.

## Mutations

```bash
keiyaku task start <task-id>...
keiyaku task stop <task-id>
keiyaku task hold <task-id>
keiyaku task resume <task-id>
keiyaku task done <task-id>...
keiyaku task drop <task-id>... [--note <text>]
keiyaku task update <task-id> --title <text>
keiyaku task context [<namespace>]
```

Use `--json` on any command when a script must inspect the typed result.
Relations are explicit facts: `needs` orders work, `parent` groups it,
`supersedes` navigates replacement, and `relates` does not affect readiness.
`task start` accepts one or more complete TaskIds. A single ID keeps the
single-mutation result; multiple IDs use the ordered batch result, continue
after per-Task refusals, and preserve retry-over-refusal exit precedence.

## Batch Create Or Modify

Use `task compose -` to create and modify multiple Tasks in one planning
document. Its input grammar is documented by the Task CLI owner:

```bash
keiyaku task compose - <<'EOF'
ns=feature

+ Parent
as = parent
state = in_progress
pri = 0
body <<BODY
Parent body.
BODY

+ Child
parent = ^parent
needs = @task/existing
EOF
```

Use `--plan` to inspect aliases, admission order, and body byte previews without
writing. New `+ Title` nodes may declare `state = open|in_progress|on_hold|done|drop`
as their initial state; omitted state is `open`. Existing `@task/...` nodes cannot
declare state. Aliases are nonempty single-line tokens containing neither
Unicode whitespace nor comma; references use `^alias`. Compose does not change
the lifecycle state of pre-existing Tasks. Each changed Task is admitted
independently; an incomplete result returns a reusable draft for the remaining
batch and preserves each new node's declared state.
