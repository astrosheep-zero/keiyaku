# Akuma Public Surface

This chapter owns the small `./akuma` product surface and its lifecycle
evidence. Exact TypeScript shapes, field budgets, and rendering belong to
declarations, help, and executable specifications.

The public caller path is `Akuma.birth`, synchronous `Akuma.select`, and
`Akuma.tell`. Birth submits no prompt; selection performs no read. A selected
Akuma exposes its identity, status, plain text Tell, and schema-decoded Tell
answer, along with the lifecycle-only idle, history, and kill observations. The
composition facade owns root, alias, dispatch, and request routing around this
product; those concerns do not become Akuma handle methods.

## One Public Timeline

Status and history derive from one retained Heart timeline in durable sequence
order. They do not join outcomes by timestamp or read a second Turn projection.
A born status also observes the Soul's frozen action authority, so callers can
inspect the granted extent without reconstructing it from mutable Archetype
configuration or private custody.
A status snapshot shows current actionable work: the open Turn when present,
active tools, pending tells, and otherwise the latest outcome. Bounded ordinary
detail can become typed gaps, but active work and actionable tells remain
visible. Reported changes are a read-time summary of successful file-change
activity on that same frontier, grouped by path and bounded to the five most
recently changed files. Repeated edits to one path become one summary with
accumulated known diffstat and the latest event identity; omitted counts refer
to files, not events. They are never a file ledger or fact.

For an open Turn, the public timeline projector selects and retains its opening
input as current work independently of the ordinary-detail budget. Its retained
call wins; only without that call, the earliest retained settled Tell delivered
at launch for that Turn is selected. A live delivery is ordinary activity, not
an opening input. Both monitoring and receipt observations retain that one
sequence-ordered evidence row without duplicating it; no opening input is
invented when its qualifying evidence is unavailable. Consumers receive the
selected row's typed identity and do not reconstruct Turn ownership from its
content or delivery metadata.

The ordinary current-work window is the open Turn's call and provider activity
along with its retained settled delivered Tells, all in durable sequence order.
Only the selected opening input and the existing active, pending, and
receipt-specific evidence remain pins; a later or unrelated settled Tell gains
no global status privilege. Its omission gaps therefore describe only that
current window, never an earlier Turn or unrelated Tell.

Placement discharges reported changes at the observation composition. While the
Akuma's dispatch-associated Contract is active, a composed status surfaces them
as above; once that Contract is claimed, the same observation presents no
reported changes — the candidate they described is placed and preserved in Git.
The discharge is derived at read time from the existing Dispatch association
and the Contract's phase; it writes no fact and never alters the Heart
projection. A dropped or failed Contract, an absent or failed association, and
an unproven Contract read all keep the reported changes: unplaced work still
matters.

History pages the same projected ledger and is the sole public execution-history
read. It retains exact answered outcome bytes, including an empty answer, and
the public history identity for a retained answered Turn. A fork accepts only
that exact answered point. Pruned history remains honestly unavailable; public
snapshots do not fabricate a cursor, result, or loss marker.

## Handles And Lifecycle Evidence

Selection over an already resolved World and identity is synchronous; every
operation that reads Heart, leash, or filesystem state is asynchronous. The
surface contains no owner, born, Turn, call, fork, receipt, ledger,
provider-event, or process-signaling handle.

Plain Tell returns the answer text for its exact Tell after ordinary wake and
settlement. A Schema-bearing Tell instead awaits the terminal Turn bound to that
Tell and decodes its raw answer; schema failure remains distinct from provider
failure. Both forms retain the same busy, interrupt, routing, and recovery
semantics. A caller signal may stop awaiting the result, but never retracts a
Tell already admitted to Heart. Interrupt combines Body put-down with delivery
of a new Tell and exposes its settlement receipt; kill exposes its kill evidence.
Interrupt control has no local elapsed-time failure boundary: it waits for leash
custody or durable Body settlement, unless the caller's signal stops waiting.
Wait observes status until its Akuma-owned completion judgment — a non-running
life with no pending Tell — or a caller deadline. Every return carries its
final status and says whether it completed or reached the deadline; completion
wins when the final deadline-edge observation satisfies the judgment. A deadline
remains a current observation rather than manufacturing a lifecycle arm.
Interrupt and kill expose only honest settlement or
unavailability evidence. Hung, untidy, and resume-unsupported state preserve
their durable cause and available facts; the surface does not prescribe the
flagship's next action.

A Schema-bearing Tell carries a provider answer contract. The contract may be
the package's own schema value or any Standard Schema v1 value; a vendor value
is normalized at admission, and decoding stays a caller-side operation over the
exact answer. The contract remains inside simple JSON shape vocabulary: a
projected document that steps outside it refuses at submission, naming the
offending keyword, so a fragile or unrepresentable constraint surfaces before
provider work rather than as a mysterious answer. A caller who owns an arbitrary
JSON Schema and its decoder signs that waiver explicitly and is not subject to
the refusal. Schema construction only makes a shape machine-usable; it never
makes the answer true.

Lifecycle observation must not manufacture an unclean end by combining old
running evidence with a Body's later leash release. A free-seat judgment uses
fresh Heart evidence protected against succession for that bounded observation;
it neither mutates lifecycle facts nor retains execution custody afterward.
This is not a frozen view of subsequent activity or a barrier to future Bodies.

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
