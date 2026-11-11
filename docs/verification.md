# Verification

This chapter owns the execution-side Verification producer and the shared
process runtime. Verification is methodology, not core fact vocabulary, a core
declaration type, or a core-derived gate. Attestation storage belongs to
[model.md](model.md), and generic gate currentness to [lifecycle.md](lifecycle.md).

## Verification Producer

The document boundary supplies private declarations and their stable opaque
requirements. Each declaration is an executable shell script and may state its
own deadline; there is no global Verification deadline, setting, flag, or
environment override. Exact Markdown and duration grammar belong to document
parsing, help, and executable specifications. Execution preparation remains
attempt-local, never a producer registry, cache, or durable run authority.
Requirement derivation and declaration identity belong to
[document.md](document.md).

Only explicit verify invokes this producer. It requires an active Contract with
valid declarations and selects all current declarations or one by its current
one-based position, independently of gate selection. Explicit verify refuses
absent, empty, or invalid declarations regardless of gate selection. An
out-of-range selection refuses
before execution or admission. The `verified` gate selects recording and placement
obligations; without it, execution returns results without recording testimony or
changing placement.
Delivery, review, preview, refreshed-target completion, and dependent continuation
never execute declarations or their hooks; they consume standing evidence only.

Verify captures the appointed worktree and prepares the same prospective target
integration as delivery, under the same clean-worktree rule and explicit dirty
capture authorization. Preparation admits no candidate, delivery, review, or
reintegration. Conflicts and unavailable preparation are typed non-admission,
never conflict handoff. Each check's subject is that exact captured integration
snapshot. Reuse of an already-recorded integration with matching tree and
predecessor permits evidence before or after delivery to apply to an unchanged
delivery. Changed target or candidate cannot retarget earlier testimony.

Each selected declaration executes in its own independent clean scratch with
project-configured setup and cleanup, including cleanup after setup or
declaration failure. No declaration inherits mutable scratch state from another.
A prerequisite must be in that declaration's script or setup hook. Full verify
may schedule in document order, but order has no correctness or evidence meaning.
Attempts never wait for or remove one another's running scenes. Mutable ignored
and untracked state from another checkout is not automatically copied or linked
into scratch. Dependency installation and intentional reuse belong to the
project's hooks, not ecosystem inference by Keiyaku. This is a local execution
convenience, not a permission sandbox, dependency-freshness policy, or
reproducibility claim.

Each declaration and scratch hook inherits the executing caller process
environment through the shared runtime. Candidate-owned settings remain the only
settings authority for those hooks. Verify always executes its selection, even
when current satisfied evidence exists. When `verified` is selected, each terminal
check admits its own attestation before later checks begin. Otherwise no check
admits testimony or another journal fact; its execution result remains visible to
the caller. Identical current testimony may reuse an admission, but the result
still reports execution and its verdict separately
from admission reuse. Reuse requires identical testimony, including the bounded
failure summary; changed diagnostic testimony is new evidence even when its
verdict and captured subject match. No aggregate attestation is produced.

Normal failure and timeout are terminal unsatisfied testimony for that
requirement only when recording is selected; full verify continues with remaining
declarations after those results. Candidate unavailability, environment/setup
failure, spawn failure,
unknown exit, and caller cancellation admit no testimony for the affected
check. An operational stop may stop further scheduling; cancellation stops later
owned work. Earlier admissions and cleanup residue remain visible. A terminal
execution result survives a later cancelled admission: the check retains its
verdict and identifies the admission stop without claiming testimony was recorded.

Admission never retargets captured testimony, even when the Contract has moved.
Requirement identity carries declaration currency; no whole-section subject
invalidates unrelated checks. Generic lifecycle currentness alone decides gate
satisfaction. With `verified` selected, execution and admissions are followed by
ordinary completion using current evidence. Ungated execution requests no completion.
Only an already-delivered Contract with ready prerequisites and all gates satisfied
may place; a selected success alone makes
no whole-gate promise. `verified` is this producer's conventional token; other
opaque gates remain outside this chapter.

Terminal failure output may be rendered as bounded contextual summary on its
attestation. Successful output remains live execution evidence, not summary
material that can displace failure diagnostics. A summary is not a log, artifact,
report store, or source for parsing counts. A stopped producer is a typed public
stop, distinct from a terminal unsatisfied verdict.

Environment failures from configured scratch hooks preserve the hook's
configured name and one bounded diagnosis as their public recovery identity;
the hook's private array position is never exposed. The diagnosis distinguishes
exit, timeout, cancellation, and unavailable execution, retaining useful output
and a visible truncation indication when needed.

An attempt can emit ephemeral observations for materialization, setup, cleanup,
declarations, and their stdout or stderr. Check observations identify the
current declaration position, stable requirement, and exact snapshot, naming
only witnessed phases and known execution directories. They never become
testimony, a run log, liveness authority, or replay data. Stopped process outcomes
retain bounded output tails and explicit truncation facts. Observer failure
cannot affect child custody or the final result.

## Process And Cleanup Boundary

The shared runtime owns child spawning, normal completion, timeout,
cancellation, and termination of the process tree rooted at the child while the
caller retains that child handle. It is domain-free: it knows no Contract,
candidate, declaration plan, Akuma, lease, or public operation. Natural
completion of the owned child is the end of termination duty: the runtime
performs one cleanup of any surviving owned descendants, then that handle is
inert, then exit evidence is exposed. Later terminate against that handle is a
no-op and never signals a former process identity. Cancellation or timeout
while live terminates owned work; releasing a live process relinquishes custody
without terminating it. Escaped descendants and processes surviving harness
loss or process crash are outside that portable guarantee. No persisted pid,
reconstructed process identity, or background disposer supplies a second
termination authority.

Scratch provisioning and disposal are awaited physical work. Successful and
cancelled attempts dispose their scratch. Unsatisfied verdicts, including
timeouts, and setup or declaration failures retain the whole scratch for
diagnosis after configured cleanup; the invocation reports its path. This is
not an archive, a log store, candidate content, or replay authority. Each Contract
and requirement pair has at most one retained diagnostic scene. A failing check
replaces only that requirement's previous scene during retirement under bounded
custody, never during materialization or execution. Replacement or cleanup for
one requirement cannot erase another's scene. Public failure results identify
the requirement, its current declaration position, and any retained path.
Failed retention reports its reason and names a path only when this attempt's
own scene remains; it retires only that attempt's
execution scene without changing its verdict. Successful and cancelled attempts
leave retained scenes untouched; acceptance or abandonment retires all scenes
whose ownership can be proved through terminal cleanup. Git proves association
and ownership without a journal fact or durable run record.

Disposal is one independently bounded removal attempt; expiry or failure becomes
that attempt's removal diagnostic. A failed destroy action or retained scratch
is reported separately and cannot reverse acceptance. Reconciliation preserves
an active Contract's diagnostic scratch and removes it on terminal cleanup only
when it can prove that no attempt still owns it; it never recovers the run or
executes candidate commands.

Cancellation requests termination only for work still owned by this attempt;
it stops later owned phases and still awaits independently bounded retirement.
It never erases a confirmed leading admission or its cleanup residue.

## Repository Test Isolation

The repository test runner owns a fresh temporary Square host ledger for each
invocation, replacing any inherited host-ledger location. Test children and their
descendants share that invocation's ledger; nested runners create their own.
The runner removes its ledger after owned test children terminate, on passing and
failing runs alike. Tests never add synthetic presence to the caller's live ledger.
This is test-harness isolation, not a change to Verification's inherited-environment
contract or to production provider environments.

## Ownership

Verification executes declarations and produces terminal verdicts. Protocol
calls the producer only for explicit verify, admits each check's testimony, and
uses the one generic requirement judgment for completion. Package and CLI
readers render adjudicated reports without parsing process output or creating a
timeline, rework count, elapsed-time authority, or derived aggregate attestation.

Each check retains its captured snapshot and stable requirement. Completion
never executes a replacement check after reintegration. It judges the evidence
applicable to its final integration; an older verdict is never attached merely
because it ran earlier in the invocation.

Scratch retirement uses bounded custody independent of caller cancellation.
Resource problems from successive attempts and dependent Contracts accumulate
on the invocation answer; replacement of current verification evidence does not
consume or clear those problems.
