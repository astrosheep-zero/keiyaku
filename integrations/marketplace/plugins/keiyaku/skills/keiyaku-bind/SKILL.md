---
name: keiyaku-bind
description: Author and bind one Keiyaku delivery Contract. Use when deciding whether a bounded delivery is ready for Contract terms, writing those terms for an implementer, binding an existing Task with `bind --task`, choosing bind inputs, or interpreting the bind receipt and worktree handoff.
---

# Keiyaku Bind

Use bind when the work is a delivery decision rather than an investigation.
The objective and delivery boundary should be clear, the expected write surface
should be truthful, and every criterion should be decidable without inventing
taste at review time. Investigate first when a plausible unresolved fact could
change the objective, governing design, criteria, or delivery boundary.

## Author The Terms

Write for the implementer and reviewer. Include facts they cannot safely
recover locally: the owner, boundary, data-flow direction, commit point, single
authority, and forbidden parallel shapes. Leave ordinary helper names and
equivalent local control flow to the implementation.

A design statement earns its place when a test-green candidate could violate
it. A criterion names one observable condition that can accept or reject the
candidate. Keep the Region truthful and no broader than the intended write
surface.

Start from this complete shape:

~~~markdown
# <delivery name>

## Context
<established facts that frame the decision>

## Objective
<one observable delivery outcome>

## Design
<ownership, boundaries, and constraints a test-green candidate could violate>

## Region
```
<expected write surface>
```

## Criteria
### <criterion title>
<one decidable acceptance condition>

## Verification
```bash
<optional executable check>
```
~~~

Use an H1 title and the H2 sections shown above. `Verification` is optional.
When a declaration needs a limit, put an explicit duration such as
`bash timeout=5m` in its fence info string; omit it for an unbounded declaration.
Keep extra rationale and investigation logs out of the Contract.

## Bind

Inspect the actual command surface before choosing inputs:

```bash
keiyaku -C <repo> bind --help
```

Bind the complete document through stdin. A Task is optional: a Contract is
complete delivery authority on its own, and ordinary bounded delivery does not
require creating planning state first. Use `--task` only when an existing Task
already carries real scheduling, dependency, or coordination value and this
Contract is specifically its delivery:

```bash
keiyaku -C <repo> bind - < CONTRACT.md
keiyaku -C <repo> bind --task <task/...> - < CONTRACT.md
```

Do not create a Task merely to make `bind --task` available or to mirror the
Contract objective. That adds a second lifecycle with no planning reader.

Use `bind --help` as the installed command authority for optional target,
workspace, prerequisite, gate-set, actor, and JSON inputs. Do not guess flags
from an older installation or repository checkout.

## Read The Receipt

Treat the receipt as the handoff. Keep the complete `kei/...` identity, work in
the reported managed worktree when one was created, and retain the target and
gate facts it reports. A waiting receipt means prerequisites remain; it is not
a second authoring workflow. A post-admission lag does not erase the admitted
Contract; read the typed facts, effects, and lag before acting.

Continue the delivery with `keiyaku-workflow`.
