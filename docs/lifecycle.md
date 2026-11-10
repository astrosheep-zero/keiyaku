# Lifecycle And Protocol

This chapter owns Contract verb decisions, eligibility, gates, attestation
meaning, and the observe-decide-admit protocol. The durable facts it judges are
owned by [model.md](model.md); Markdown is owned by [document.md](document.md).

## Contract Lifecycle

A Contract is bound from binding until it is either accepted or abandoned;
delivery is a recorded fact on a bound Contract, never a phase of its own.
Binding alone places the Contract in its bound phase; there is no pre-phase.
Terminal state is a journal-derived read model, never a separate record.
Binding fixes coordinates and initial terms. Amendment may replace
active terms, including declared dependencies and gates, but can neither change
coordinates nor reopen a terminal Contract.

`after` is an explicit, acyclic relation for work that must build on another
Contract's settled outcome or needs deliberate sequencing. It is not a Region
lock, queue, ownership claim, or general-overlap remedy. Its targets must exist;
v4 does not admit an unfulfillable forward dependency. Placement judges only the
current direct prerequisites: every one must be accepted. A prerequisite that
later abandons remains visible as an unsatisfied dependency, not an unknown one.

A Contract-addressed destination must exist and remain active for new binding,
preparation, reintegration, and placement. It is not a prerequisite or a parent
lifecycle: landing changes the child's authority and the destination worktree,
not the destination Contract's terms, candidate, testimony, or terminal state.
Concurrent terminal admission and child landing are ordered by journal admission.

Delivery captures a candidate and frozen placement policy. After that leading
fact is admitted, a later delivery with the same worktree-content identity
continues the non-terminal candidate and reuses its delivery data and recorded
target base without adding another delivery fact. Changed content replaces
the candidate under the ordinary delivery rules. A conflict normally refuses
without changing Contract authority; explicit conflict handoff may project it
into the appointed workspace without treating the projection as delivery. Its
public result names the handoff base and the conflict's recovery meaning: callers
resolve the final worktree bytes and explicitly authorize dirty capture; staging
is not required. Literal recovery commands belong to the leaf CLI.
Resolution operates on final worktree bytes through private-index capture while
the real index and its `UU` state remain under the invoking local owner's custody. Dirty
workspace bytes require explicit delivery authorization; with that
authorization, conflict materialization preserves the captured bytes as the
handoff base before projecting the judged conflict. Review records observed
`unmergedPaths` as evidence without blanket refusal. Review may test the actual
worktree before a delivery and is not delivery authorization. A satisfied
review may request trailing placement; an unsatisfied review never does.
Review and delivery share the candidate's worktree-content identity when it
becomes relevant, while target movement alone does not make a review stale. A
changed candidate content identity makes prior testimony stale with an explicit
candidate-content-change reason; the reason names the pinned target when one
exists and includes the previous and current ChangeIds.

Abandonment is the sole alternate terminal outcome. It neither reads nor moves
the target and cannot be reopened. An arc is a narrative chapter within one
active Contract, not a debt list, progress measure, or separate acceptance path.

## Gates And Testimony

Gates are opaque, contract-declared placement obligations, each with one or
more opaque requirements. The core supplies no built-in vocabulary, producer
registry, default gate, or generic attestation operation. A producer may record
its own testimony whether or not its gate was declared; a custom declared gate
remains unsatisfied until a lawful producer records matching evidence.

An attestation is durable history about one gate, requirement, and captured
subject. Admission never retargets that subject or rejects truthful older
testimony merely because the Contract has moved. Generic currentness selects
the latest current testimony independently for each declared gate and requirement.
A later unsatisfied testimony for the same subject supersedes earlier
satisfaction only for that requirement. A gate is satisfied exactly when every
currently declared requirement has current satisfied testimony. Missing, stale,
and current unsatisfied evidence remain distinguishable for each requirement.
Singleton and multiple-requirement gates use this same judgment; there is no
aggregate attestation or producer-specific gate arbitration. No renderer,
protocol adapter, or board recomputes it.

Producer methodology for `verified` belongs to
[verification.md](verification.md). Selection makes its current requirements
placement obligations; without `verified`, the Verification section serves as
reference documentation and creates none. Review and custom gates have a
singleton requirement derived from the gate identity. The document boundary
derives and replaces the effective requirement set on bind, amend, and fork
without teaching core producer vocabulary.

Placement claims only a delivered Contract whose current prerequisites and gates
pass. Missing delivery, terminal state, unmet prerequisites, and unmet gates are
typed decisions, not invitations for another layer to reread authority. A
successful claim may synchronously continue already-delivered dependents under
the same rules, but that continuation creates no queue, background worker,
retry ledger, or new lifecycle authority.

Leading testimony and completion have different ownership. Review admits its
captured testimony; delivery admits its captured candidate; explicit verify
admits each selected check's terminal testimony without admitting delivery,
review, reintegration, or another candidate. Their shared completion judgment
handles one Contract at a time. Satisfied review, delivery, and verify after its
selected work may request placement. Unsatisfied review and delivery preview do
not. Pre-delivery verify cannot place because it supplies no delivery.

Completion consumes existing generic requirement evidence only. Delivery,
review, refreshed-target completion, and delivered-dependent continuation never
execute Verification, including hooks. Missing or stale evidence is an unmet
obligation, never a producer run, runtime stop, or execution-reuse event.
`reviewed` remains independent of Verification. The trigger changes the entry
point, never the placement rules. Completion observes target movement before
judging the old integration's gates: an old failed verdict cannot prevent
refreshing a moved target. A refreshed integration needs its own applicable
evidence before placement; target movement alone never discards review of
unchanged candidate content.

The invocation composes those steps synchronously. Dependent discovery is a
bounded scheduling observation, not permission to mutate a stale worktree or
skip the current placement decision. Each attempted dependent uses a fresh
Contract observation; an unready dependent may become eligible after another
prerequisite completes in the same walk. No background queue is created.

## Decisions, Admission, And Recovery

Pact makes one pure legal decision for one immutable observation per semantic
attempt. Inputs are plain data and appropriately stamped document derivations;
the decision has no Git, process, clock, callback, or working-directory power.
It alone judges Contract existence, terminality, document currency, and
verb-specific legality. A changed document is a refusal for operations using a
stamped derivation; review's later currency is a gate question.

Admission currentness is witnessed per semantic attempt. Shared protocol owns the classification of lower attempt conclusions and the bounded availability of fresh custody, while each verb retains ownership of preparation, legal decision, publication, and any recovery meaning. A publication failure is a terminal typed non-admission and never licenses replay of its offer; spent currentness evidence is discarded before a later attempt obtains fresh custody. Collision and exhaustion remain distinct terminal observations.

Protocol alone joins that decision to Git observation and admission. It holds
the necessary publication custody, submits at most one decision offer, and Git
atomically proves its expected durable state. Mechanical preparation cannot
override lifecycle legality. Custody binds observation, decision, and admission;
repeatable preparation may precede that custody when it carries the observed
currentness witnesses it used, and those witnesses must still hold against the
in-custody observation. A preparation whose witnesses no longer hold is spent: it
is discarded and the whole cycle restarts from fresh observation and fresh
preparation under a new attempt identity, never replaying the spent offer. A
spent preparation is never a publication failure and never a public business
refusal. A real publication failure keeps its own typed meaning (seat
contention, Git publication failure, unconfirmable outcome); it is never
re-described as a spent preparation and is never answered by republishing the
same offer. It discards the offer, and any retry uses a fresh observation and
preparation; uncertain outcomes are resolved only from durable journal facts.
Bounded retries eventually return a typed non-admission outcome. The journal,
rather than a queue or cache, is the only recovery and handoff receipt.
An admitted current candidate is reused by subsequent delivery only when the
observed worktree-content identity is unchanged. Changed content replaces the
candidate under the ordinary delivery rules, without starting Verification.
Testimony from an older running invocation remains history for its captured
subject, never evidence for the replacement. Explicit overwrite retains its
remaining replacement behavior. Reuse references its earlier admission without
claiming that the new invocation admitted it again. Other redelivery and
terminal refusal behavior is unchanged.

Delivery preview observes an active Contract without admission. It judges standing
evidence against the prospective integration through generic currentness, without
executing a producer or pretending a delivery was persisted. It reports current
prerequisite and prospective gate judgments without granting placement. Once a leading act is
admitted, later placement, continuation, cleanup, reconciliation,
and settlement are independent obligations: their stops or lags cannot reverse
the admission or conceal the Contract. Their public representation is owned by
[public-results.md](public-results.md).

An invocation may expose its confirmed leading admission while its owned
Verification, placement, continuation, reconciliation, or cleanup work is
still proceeding. Cancellation can stop remaining owned work but cannot undo
that admission; only the final result adjudicates its trailing stops and
residue.
