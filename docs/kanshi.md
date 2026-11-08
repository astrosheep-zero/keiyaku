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
currentness and verdicts without recomputing gate satisfaction or inferring a
producer run. An association outside that aperture is unavailable rather than
missing; Kanshi uses missing only when the Contract observation is complete
enough to establish absence.

For bare World status, Kanshi obtains one bounded recent Akuma observation and
keeps that owner order. It observes detailed activity only for its first few
returned rows and retains whether that observation reaches farther without
manufacturing a roster total. This bounded display observation never supplies
the frozen complete subject set required by selection, waiting, mutation, or
other complete roster operations.

A requested category is a package-root observation that retains the same recent
owner order and bounded extent as the corresponding World section. It validates
the caller boundary before any owner read — refusing malformed requests or a
Contract category without a Repo — then observes that section independently,
preserving absence and owner failure while attaching available Alias, Dispatch,
and DebtHolder facts without reading the Debt board or resolving exact
identities.

An exact aggregate observes the complete owner-classified running Akumas,
active Contracts, and open Debts across their respective authorities. It never
uses bounded catalogue rows as totals. An incomplete owner observation fails
only that count; absence and a complete empty authority remain distinct. Repo
and World availability are independent, and the aggregate is one read-time
observation rather than a cross-product transaction.

## Associations and selection

Kanshi may attach already observed DebtHolder and Dispatch facts to their
corresponding Contract, Debt, or Akuma rows. Those links remain the authority
of Settlement and Dispatch. Kanshi never writes an association, infers one
from names or directories, or uses an attachment as permission to change any
product.

The same read-time association discharges an observed Akuma snapshot's
reported changes when the associated Contract's observed phase is accepted:
placement has preserved the candidate in Git, so the composite report no
longer presents placed work as pending. The discharge derives from the Contract
owner's own phase read, writes nothing, and yields to any missing, failed, or
unproven Contract observation, which keeps the reported changes.

Callers may select a complete Contract or Akuma identity, request a
catalogue, or ask the Region owner for declared planning regions and their
intersections. A selection narrows the already described observation; it does
not switch Worlds, broaden into hidden joins, claim touched paths, predict Git
conflicts, or give ownership advice. An invalid or ambiguous selector is a
refusal, while a well-formed unmatched selector is an explicit missing result.

The report preserves complete identities and the owner-provided facts needed
to understand current availability, lifecycle, declared evidence, and
association. Counts and ordering are observations, not persisted counters or
new status law. The report has no destructive or mutating operation.

## Presentation boundary

Kanshi defines the semantic content available to world status and inspection.
[cli-output.md](cli-output.md) decides how that report is rendered for people
or JSON consumers, without rereading authority or removing failure evidence.
Kanshi has no independent text grammar, glyph set, output schema, or terminal
layout.
