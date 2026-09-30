# Public Mutation Results

This chapter owns the conceptual public answers to Contract mutation,
non-admission, audit, and post-admission work. Exact TypeScript unions, fields,
and literal codes belong to the exported declarations and executable
specifications.

## Structural Boundary

Unknown caller and transported operation values are structurally validated
once at their Library or Body transport boundary. Nested evidence retains its
native structural owner within the operation answer and its invocation envelope;
schema validation proves structure only and never decides
legality, finality, pending work, or recovery. A local owner value is not
re-decoded merely because it is later projected or forwarded.

## Leading Outcome

Library alone projects protocol work into public answers. A successful mutation
reports every fact admitted by that invocation, the addressed Contract's
resulting head, its operation value, and any post-admission lags. The answer is
invocation-scoped, not Contract state, a durable receipt, an effects log, or a
result retained on a handle. Local and forwarded execution return this same
answer without a transport-specific receipt. An accepted delivery also carries
its witnessed leading provenance: whether this invocation admitted the
candidate or continues a candidate already admitted before this attempt. Fresh
provenance comes only from the confirmed admission of this invocation; continued
provenance comes only from the historical entry observed in custody during this
attempt, and that historical entry never appears among the invocation's newly
admitted facts. Forwarded execution preserves that provenance as returned and
never rereads later authority to recover it; a missing or disagreeing provenance
is an integrity failure, not a reason to infer from newer state. Text names the
candidate and integration result, patch-id as `content identity (not commit)`,
keeps ContractHead and journal blob custody private, and leaves typed fields unchanged.

Every mutation has one operation-owned answer, projected after independently
awaited retirement of its owned resources. Non-admission is returned data; only
delivery can return a no-fact conflict handoff. Acceptance requires the complete
operation value and addressed admission evidence. Bind retains its native Contract
ability, delivery retains its native diff ability, and their JSON representation
keeps result data without exposing process custody or reconstructing capabilities
from raw coordinates.

Physical effects, required stops, settlement, and retained residue have one
invocation-wide carrier. Candidate conclusions stay in the operation value.
Pending work is judged once by the final projection from those conclusions and
owner classifications, not by a second caller finality judgment or an independently
transported summary. Optional resource residue stays observable without becoming
mandatory replay or undoing admission. Recovery evidence is transient Git custody,
not a new Contract fact or retention promise.

Refusal and retry reasons belong to their addressed operation. Neither can claim
safe retry when publication is unknown. A later operational stop preserves known
leading evidence, while an unexpected programming failure or corruption remains
exceptional with the same operation envelope at its actual, possibly incomplete,
failure point. The exceptional value never pretends that an unfinished audit or
completion finished.

The addressed operation is explicit. Consumers never infer it from coincidental
members of its value, and no later authority scan reconstructs which facts an
invocation owns.

## Contract Outcomes

Delivery and review may admit their leading fact while verification, placement,
or dependent continuation reports a distinct typed stop. Those trailing channels
are independent: a satisfied review can still find no delivery to place, and a
verification or placement stop cannot undo an accepted delivery or review.
Verification blocks placement only when the Contract selected `verified`;
otherwise an unsatisfied or stopped Verification remains observable evidence,
keeps its typed shape, and does not prevent a claim. A typed trailing stop after
a confirmed admission keeps the witnessed provenance alongside that stop.
Recovery names an existing
delivery fact as already admitted, reports only this invocation's facts, and does
not disguise later workspace bytes as a candidate. Successful placement is
represented once as completion; callers do not rebuild it from facts or folded
state. A completed placement also carries the movement it made — the reference it
advanced and the head it advanced from — so a receipt states the target's
movement instead of deriving it from journal facts or folded state. Reused
Verification evidence is identified as reuse, not a cache or a new evidence
source. A completed placement that retained a non-blocking Verification stop
reports that stop beside its movement.

Known completion and movement precede optional presentation observation. Failure
to observe that presentation never reruns completion or erases witnessed movement.

An admitted current candidate with declared Verification but no terminal fact
is `unrecorded`, distinct from undeclared or terminal Verification and implying
no timeout, liveness, or retry state.

A normal integration conflict is a non-admission refusal. Explicit conflict
materialization instead returns a handoff result with no admitted fact,
candidate identity, verification, or placement. Dirty bytes may be included in
that handoff only with explicit dirty-capture authorization; the handoff
preserves those bytes as its base before projecting the judged conflict.
Workspace dirtiness without that authorization, unmerged state, missing target or
workspace, unsupported integration, and target movement remain typed public
conditions rather than hidden retry policy. Target movement never masquerades as
claim or already-applied placement.

A materialized handoff returns the captured handoff base, the target head and
conflict paths, plus the recovery projection. The continuation is explicitly
`deliver --include-dirty` with staging `not-required`: callers resolve the
appointed worktree by editing its final bytes, while the parent Body retains
Git custody and private-index capture preserves the real index, including
`UU`. Materialization admits no delivery fact. Review results likewise expose
captured `unmergedPaths` as evidence without turning them into a blanket
refusal. A stale gate may explain that candidate content changed during
reintegration; target movement alone is not that reason.

A materialized handoff is itself a complete no-fact delivery outcome. Its
forwarded descriptor is durable service evidence sufficient to return that same
outcome on replay, without rematerializing it or inventing a delivery fact.
Heart may retain that opaque descriptor but cannot turn it into Git custody or
cleanup authority. Recorded delivery continues to retain its journal-fact
evidence, and request service remains incomplete when no required evidence
exists.

Unmet prerequisites and gates retain the lifecycle decision's ordered,
adjudicated explanation. Consumers render that result and never recompute
dependency state, gate currentness, staleness, or terminality. Region overlap is
a successful, non-authoritative planning observation: it neither grants nor
denies write authority, and failure to collect it does not undo binding or
amendment.

A continuation reports every dependent it actually attempted: completion or a
specific semantic, physical, or operational stop. A stopped dependent does not
hide successful siblings or replace the addressed Contract's head. Discovery
failure and cancellation retain all earlier confirmed admissions.

## Audit And Observation

Audit returns one already-adjudicated picture of candidate readiness,
Verification, and target state. A blocked candidate admits no Verification fact;
Audit observes target followability independently even when Verification stops.
Audit may record terminal Verification testimony, but never places or moves a
target. Its candidate comparison independently reports the admitted candidate's
Verification status. Candidate diffs and scope are requested presentation data,
including an empty diff, not journal, gate, or cache authority.

Read-only workspace and board observations are owned by
[public-api.md](public-api.md), not duplicated here. Nuke confirmation refusals
and accepted reset answers remain public result concepts; reset and
preservation semantics are owned by [world.md](world.md).

## Cleanup Boundary

Verification scratch cleanup or worktree removal can report physical residue
after admission. Such reports stay on the accepted invocation result, do not
change its exit meaning, and never become journal facts, cleanup authority, or
reconciliation input.

Ephemeral execution observations are separate from this final result boundary.
They can expose a confirmed leading fact before later work settles, but neither
missing observation nor a reported gap changes admission, cancellation,
Verification stop, cleanup residue, or forwarded recovery. A stopped process's
captured output remains part of its typed stop rather than an implied terminal
verdict.

Cleanup belongs to the whole invocation, independently of the current candidate.
All retained resources and failed cleanup attempts keep their known owner and
candidate coordinates. A newer verification can replace candidate conclusions,
but cannot overwrite an earlier resource problem or discard a dependent's
cleanup report. Cleanup reporting has one public carrier; operation values do
not repeat it as another source of truth.

Every confirmed conclusion and completed owner effect is retained before later
work can fail. The final exceptional envelope includes later retirement residue
even when an earlier exceptional envelope was already attached to the cause.

## Forwarded evidence availability

A live returned refusal or retry is owner testimony of no committed product
effect, separate from Heart's service disposition. Its precise reason and
invocation-local observations exist only in live transport. When those bytes
are gone, a voided request proves no committed product effect but cannot establish its
original owner reason or physical residue. Forwarding exposes that unavailability
with raw diagnostic evidence and never parses prose to reconstruct typed facts.
A retry permits a fresh request identity only; old identities never re-execute.

An exceptional live owner answer retains its original category, native cause,
and invocation envelope even when Heart records the service as unproven.
Disposition and error category are independent. Without that decoded owner proof,
unproven service or post-publication channel loss remains unknown outcome. An
exact served reference proves the leading operation identity, not its missing
trailing observations; expiration does not authorize reconstruction or replay.
