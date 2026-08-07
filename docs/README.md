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
| [verification.md](verification.md) | Verification declarations, execution, result admission, and shared process runtime. |
| [transport.md](transport.md) | Git world, worktrees, refs, pins, delivery-byte custody, and reconciliation. |
| [cli.md](cli.md) | `keiyaku-v4` argv, edge adaptation, selectors, rendering, exit codes, status board, and audit presentation. |

## Hard-Cut Discipline

v3, Square history, source, tests, tasks, and review reports are evidence, not
additional authority. Newer settled rulings supersede older ones; the resulting
law must be integrated into the owner chapter instead of copied as a chronology.

v4 is current-version-only. A persisted-format change updates the current
codec, facts, fixtures, and tests in one cut. It carries no compatibility
decoder, migration path, legacy alias, or dormant format branch.

Production TypeScript under `src/` has a hard 7,000-line budget enforced by
the architecture check. Crossing it is an architecture failure, not a request
for an exemption; new behavior must first remove equivalent or obsolete
machinery.

Port behavior only when v4 still has a named reader and one clear owner. Rewrite
anything that depends on a repository-wide ledger, detached evidence storage,
current-state database, effect journal, accepted-tail replay, or compatibility
format. Delete planning artifacts once their decision has been absorbed here.

## Reading Rule

One law has one home. Read the owner chapter before changing its surface, and
link to a neighboring owner rather than copying a rule across chapters. A
change that affects several surfaces updates each affected owner, with each
rule written only in the chapter that owns it. A missing or contradictory rule
is an authority gap: stop the dependent change and settle the concrete case
before choosing public behavior, persistence, data flow, recovery, concurrency,
or process topology.
