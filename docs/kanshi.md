# Kanshi

Kanshi is the read-only composite observation of one World. It gives callers a
coherent report of Contract, Task, and Akuma reality without creating a fourth
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

## Associations and selection

Kanshi may attach already observed TaskHolder and Dispatch facts to their
corresponding Contract, Task, or Akuma rows. Those links remain the authority
of Settlement and Dispatch. Kanshi never writes an association, infers one
from names or directories, or uses an attachment as permission to change any
product.

Callers may select a complete Contract or Akuma identity, request an allowed
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
