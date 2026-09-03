# Akuma Public Surface

This chapter owns Akuma public handles, status, wait, history, and compact fleet
values. Exact TypeScript shapes, field budgets, and rendering
belong to declarations, help, and executable specifications.

## One Public Timeline

Status and history derive from one retained Heart timeline in durable sequence
order. They do not join outcomes by timestamp or read a second Turn projection.
A status snapshot shows current actionable work: the open Turn when present,
active tools, pending tells, and otherwise the latest outcome. Bounded ordinary
detail can become typed gaps, but active work and actionable tells remain
visible. Reported changes are a read-time summary of successful file-change
activity on that same frontier, grouped by path and bounded to the five most
recently changed files. Repeated edits to one path become one summary with
accumulated known diffstat and the latest event identity; omitted counts refer
to files, not events. They are never a file ledger or fact.

History pages the same projected ledger and is the sole public execution-history
read. It retains exact answered outcome bytes, including an empty answer, and
the public history identity for a retained answered Turn. A fork accepts only
that exact answered point. Pruned history remains honestly unavailable; public
snapshots do not fabricate a cursor, result, or loss marker.

## Handles And Lifecycle Evidence

Handle construction over an already resolved World and identity is synchronous;
every operation that reads Heart, leash, or filesystem state is asynchronous.
The surface exposes call, selection, status, wait, history, tell, interrupt,
fork, and kill under their owner semantics. It contains no process coordinate or
capability to signal a described process.

Plain Tell returns its durable admission and wake evidence; it does not promise
provider delivery or a Turn entry. Pending and told are the sole public detailed
Tell states. A Schema-bearing Tell instead awaits the exact terminal Turn answer
and decodes it; schema failure remains distinct from provider failure. Both forms
retain the same routing and lifecycle semantics.
Wait observes status until its Akuma-owned default completion judgment or a
caller override; timeout returns a current observation rather than manufacturing
a timeout lifecycle arm. Interrupt and kill expose only honest settlement or
unavailability evidence. Hung, untidy, and resume-unsupported state preserve
their durable cause and available facts; the surface does not prescribe the
flagship's next action.

The fleet is a compact bounded recent-activity roster, not a smaller status
view. Its order is the later of each readable Heart's life and activity evidence,
with complete identity breaking equal activity and untimestamped rows following
timestamped rows. The observation says whether another readable member lies
beyond its bounded result without claiming a total or a frozen continuation.
It exposes born identity, frozen descriptive snapshots, life evidence, recent
activity and pending-tell information without loading each history. Recognized
unborn or stillborn allocation state remains visible; a hard direct-read failure
may omit that fleet row without suppressing readable peers and without
inventing a per-row diagnostic. Status and fleet never re-evaluate provider
capability or turn provider evidence into new lifecycle facts. An explicit
advanced library observation may read the complete roster for callers whose
semantics require a frozen set; it is distinct from ordinary bounded observation
and never becomes a catalogue command.

## Boundary

Provider observation is defined by [akuma-provider.md](akuma-provider.md); Heart
owns durable facts and projection by [akuma-heart.md](akuma-heart.md). Package
selector and cross-product composition belong to [public-akuma.md](public-akuma.md).
CLI rendering and Kanshi consume this surface without reconstructing its law.
