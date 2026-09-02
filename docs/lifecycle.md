# Lifecycle And Protocol

This chapter owns Contract verb decisions, eligibility, gates, attestation
meaning, and the observe-decide-admit protocol. The durable facts it judges are
owned by [model.md](model.md); Markdown is owned by [document.md](document.md).

## Contract Lifecycle

A Contract moves from waiting through its delivery phase to either claimed or
abandoned. Terminal state is a journal-derived read model, never a separate
record. Binding fixes coordinates and initial terms. Amendment may replace
active terms, including declared dependencies and gates, but can neither change
coordinates nor reopen a terminal Contract. The first delivery transition
records the independent bound milestone; binding and amendment do not create it
eagerly.

`after` is an explicit, acyclic relation for work that must build on another
Contract's settled outcome or needs deliberate sequencing. It is not a Region
lock, queue, ownership claim, or general-overlap remedy. Its targets must exist;
v4 does not admit an unfulfillable forward dependency. Placement judges only the
current direct prerequisites: every one must be claimed. A prerequisite that
later abandons remains visible as an unsatisfied dependency, not an unknown one.

Delivery captures a candidate and frozen placement policy. A later delivery
replaces that candidate. A conflict normally refuses without changing Contract
authority; explicit conflict handoff may project it into the appointed workspace
without treating the projection as delivery. Dirty workspace bytes require
explicit delivery authorization; with that authorization, conflict materialization
preserves the captured bytes as the handoff base before projecting the judged
conflict. Review may test the actual worktree before a delivery and is not
delivery authorization. A satisfied review may request trailing placement; an
unsatisfied review never does. Review and delivery share the candidate's
worktree-content identity when it becomes relevant, while target movement alone
does not make a review stale.

Abandonment is the sole alternate terminal outcome. It neither reads nor moves
the target and cannot be reopened. An arc is a narrative chapter within one
active Contract, not a task list, progress measure, or separate acceptance path.

## Gates And Testimony

Gates are opaque, contract-declared placement obligations. The core supplies no
built-in vocabulary, producer registry, default gate, or generic attestation
operation. A producer may record its own testimony whether or not its gate was
declared; a custom declared gate remains unsatisfied until a lawful producer
records matching evidence.

An attestation is durable history about its captured subject. Admission never
retargets that subject or rejects truthful older testimony merely because the
Contract has moved. Placement alone applies generic currentness: the latest
testimony for a declared gate and its current subject must be satisfied. A later
unsatisfied testimony for the same subject supersedes earlier satisfaction.
No renderer, protocol adapter, or board recomputes this judgment. Producer
methodology for `verified` belongs to [verification.md](verification.md).

Placement claims only a delivered Contract whose current prerequisites and gates
pass. Missing delivery, terminal state, unmet prerequisites, and unmet gates are
typed decisions, not invitations for another layer to reread authority. A
successful claim may synchronously continue already-delivered dependents under
the same rules, but that continuation creates no queue, background worker,
retry ledger, or new lifecycle authority.

## Decisions, Admission, And Recovery

Pact makes one pure legal decision for one immutable observation per semantic
attempt. Inputs are plain data and appropriately stamped document derivations;
the decision has no Git, process, clock, callback, or working-directory power.
It alone judges Contract existence, terminality, document currency, and
verb-specific legality. A changed document is a refusal for operations using a
stamped derivation; review's later currency is a gate question.

Protocol alone joins that decision to Git observation and admission. It holds
the necessary publication custody, submits at most one decision offer, and Git
atomically proves its expected durable state. Mechanical preparation cannot
override lifecycle legality. Custody binds observation, decision, and admission;
preparation may precede that custody when it declares the observed inputs it
used, and those inputs must match the in-custody observation. A mismatched
artifact is a stale preparation of the same class as a failed publication. A
failed publication discards the offer and any retry uses a fresh observation and
preparation; uncertain outcomes are resolved only from durable journal facts.
Bounded retries eventually return a typed non-admission outcome. The journal,
rather than a queue or cache, is the only recovery and handoff receipt.

Audit judges an active Contract and may create ordinary producer testimony, but
never requests placement, claims, or moves a target. Once a leading act is
admitted, later verification, placement, continuation, cleanup, reconciliation,
and settlement are independent obligations: their stops or lags cannot reverse
the admission or conceal the Contract. Their public representation is owned by
[public-results.md](public-results.md).
