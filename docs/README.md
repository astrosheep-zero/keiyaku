# Keiyaku v4 Authority Index

This directory is the sole product and architecture authority for v4. Read
this index first, then every chapter that owns the surface being changed. The
source tree, tests, task board, v3 repository, and skills are evidence or
operating guidance; none can introduce product law.

## Owner Chapters

| Chapter | Owns |
| --- | --- |
| [public-api.md](public-api.md) | Package-root public library: `Keiyaku`, `Repo`, `Delivery`, exported value types, construction, and public result behavior. |
| [document.md](document.md) | Contract Markdown, H2 amend-operation grammar, arc document grammar, and reserved-section handling. |
| [model.md](model.md) | Journal authority, envelope and fact shapes, identity coordinates, folded state, and dependency direction. |
| [lifecycle.md](lifecycle.md) | Verb decisions, eligibility, phases, terminals, gates, review, protocol, and admission. |
| [verification.md](verification.md) | Verification planning, execution, result admission, cache reads, and shared process runtime. |
| [transport.md](transport.md) | Git world, worktrees, refs, pins, delivery-byte custody, and reconciliation. |
| [cli.md](cli.md) | `keiyaku-v4` argv, edge adaptation, selectors, rendering, exit codes, status board, and audit presentation. |

## Planning Evidence

These files are evidence only. They do not define current product behavior or
module ownership.

- [porting-policy.md](porting-policy.md) records v3 evidence-triage and
  current-version porting discipline.
- [porting-inventory.md](porting-inventory.md) is the candidate porting
  inventory.
- [source-tree-draft.md](source-tree-draft.md) is a rough source-shape sketch
  and measured planning evidence.

## Reading Rule

One law has one home. Read the owner chapter before changing its surface, and
link to a neighboring owner rather than copying a rule across chapters. A
change that affects several surfaces updates each affected owner, with each
rule written only in the chapter that owns it. A missing or contradictory rule
is an authority gap: stop the dependent change and settle the concrete case
before choosing public behavior, persistence, data flow, recovery, concurrency,
or process topology.
