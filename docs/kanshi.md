# Kanshi

Kanshi is the read-only composite observation of one World. It gives callers a
coherent report of Contract, Debt, and Akuma reality without creating a fourth
product authority. It owns report availability, read-time association,
selection, and the meaning of a composite result; it owns no lifecycle,
permission, persistence, or repair decision.

## Report and failure isolation

Kanshi obtains each section from its public owner and retains whether that
section is present, absent, or unavailable. An absent World, an empty present
section, a missing selected entity, and a failed section are different facts.
A failed or unreadable section does not prevent other sections from being
observed, and no unavailable section is rendered as an empty list or zero
count.

One report is a bounded read-time observation: its sections and their
observation time describe what Kanshi actually read, not a durable transaction
or an assertion of causality between producers. Kanshi does not reread a
section while formatting it, synthesize history, probe provider state, or
repair an inconsistency it encountered.

The report preserves section failures with their bounded causes rather than
retaining replayable partial reads. Read failure never erases independently
observed peers, and a failed retirement cannot turn unavailable authority into
known emptiness.

Read-time association is enrichment, not a prerequisite for observing either
product. A failed DebtHolder or Dispatch observation makes affected links
unavailable; it does not fail readable Debt or Akuma rows or establish that no
link exists. Alias availability belongs to the composite Akuma section, not to
any single row: a failed Alias read leaves the Akuma section and empty roster
present with Alias marked unavailable, while readable alias values remain the
Alias owner's and attached Contract rosters derive availability from that
section fact.

The World Debt section is a recent bounded catalogue. It attaches only
relationships already observed for those rows, while a selected Contract's
owned Debt section retains the complete owner view required to explain that
Contract.

The bare World Contract section is likewise a recent bounded catalogue. A
selected Contract retains its exact owner observation, so the convenience of a
World aperture never weakens the detail that selection asks the Contract owner
to explain. Its judgment is phase-driven: active Contracts foreground the
outstanding hand and acceptance evidence, while terminal Contracts foreground
the settled outcome. The World Contract section offers the same concise judgment
at catalogue scale. Contract evidence retains the owner's per-requirement
currentness and verdicts without a second copy of aggregate testimony,
recomputing currentness, or inferring a producer run. An association outside
that aperture is unavailable rather than missing; Kanshi uses missing only
when the Contract observation is complete enough to establish absence.

For bare World status, Kanshi consumes the Akuma catalogue's shared row and
association composition within its bounded recent aperture, keeping native owner
order and lineage. Only born members within the original leading snapshot
positions receive current-work observation; birthless positions do not extend
that aperture to later members. The ordinary Akuma catalogue instead observes
every bounded selected born member. Birthless allocations have no activity or
outcome, while selected born snapshot failures preserve membership with unavailable
activity. Addressed static reads retain the selected current frontier in owner
order; historical event coordinates and tool output belong to explicit history
or stream observation. The report retains whether the observation reaches farther
without manufacturing a roster total. This bounded display observation never
supplies the frozen complete subject set required by selection, waiting, mutation,
or other complete roster operations.

An exact aggregate observes the complete owner-classified running Akumas and
open Debts, and counts active Contract journal membership in the observed Git
tree. Contract counting does not decode journals or observe prerequisites,
workspaces, targets, or gates. It never uses bounded catalogue rows as totals;
unrelated detail failures cannot prevent a count. An incomplete membership
observation fails only that count; absence and a complete empty authority remain
distinct. Repo
and World availability are independent, and the aggregate is one read-time
observation rather than a cross-product transaction.

## Associations and selection

Kanshi may attach already observed DebtHolder and Dispatch facts to their
corresponding Contract, Debt, or Akuma rows. Those links remain the authority
of Settlement and Dispatch. Kanshi never writes an association, infers one
from names or directories, or uses an attachment as permission to change any
product.

Reported changes belong to the addressed Akuma observation, not to every
catalogue row. Placement discharge of pending work uses the Contract owner's
observed phase without changing Heart evidence. Missing, failed, or unproven
Contract authority cannot establish that work was placed.

Callers may select a complete Contract or Akuma identity, request a
catalogue, or ask the Region owner for declared planning regions and their
intersections. A selection narrows the already described observation; it does
not switch Worlds, broaden into hidden joins, claim touched paths, predict Git
conflicts, or give ownership advice. An invalid or ambiguous selector is a
refusal, while a well-formed unmatched selector is an explicit missing result.

The report preserves complete identities and the owner-provided facts needed
to understand current availability, lifecycle, declared evidence, and
association. Catalogue observations share the native owner's concise summary,
including physical attention and unavailable observations for the selected rows;
composition neither drops that evidence nor re-observes it. Selected detail retains
workspace appointment even when its physical
observation fails. Missing links, unavailable link authority, and unrequested
detail remain distinct, including when independently observed partial links
are still available. Counts and ordering are observations, not persisted counters or
new status law. The report has no destructive or mutating operation.

## Presentation boundary

Kanshi defines the semantic content available to world status and inspection.
[cli-output.md](cli-output.md) decides how that report is rendered for people
or JSON consumers, without rereading authority or removing failure evidence.
Kanshi has no independent text grammar, glyph set, output schema, or terminal
layout.
