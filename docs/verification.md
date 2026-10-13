# Verification

This chapter owns the execution-side Verification producer and the shared
process runtime. Verification is methodology, not core fact vocabulary, a core
declaration type, or a core-derived gate. Attestation storage belongs to
[model.md](model.md), and generic gate currentness to [lifecycle.md](lifecycle.md).

## Verification Producer

The document boundary supplies an ordered private declaration set. Each
declaration is an executable shell script and may state its own deadline; there
is no global Verification deadline, setting, flag, or environment override.
Exact Markdown and duration grammar belong to document parsing, help, and
executable specifications. The declaration set, its preparation, and its
dependency selection remain attempt-local and are never core terms, cache,
producer registry, or durable execution authority.

Verification runs only as the obligation of a selected `verified` gate. Without
that selection, no verb runs the producer and a Verification section is inert
document text. Selecting the gate requires a declaration.

Verification runs the selected declarations against the exact integration
snapshot in a clean disposable worktree for each attempt. Project-configured
setup prepares that worktree before declarations, and configured cleanup runs
before its removal, including after setup or declaration failure. Mutable
ignored and untracked state from another checkout is not automatically copied
or linked into the scratch. Dependency installation and any intentional reuse
belong to the project's hooks, not ecosystem inference by Keiyaku. This is a
local execution convenience, not a permission sandbox, dependency-freshness
policy, or reproducibility claim.

Each declaration and scratch setup or cleanup hook inherits the caller process
environment through the shared runtime. Candidate-owned settings remain the
only settings authority for those hooks. Declarations run in order even after a
failing command. A terminal run records one ordinary `verified` attestation
with a satisfied or unsatisfied verdict. When the current attestation for the
same Contract, gate, verdict, captured snapshot, and declaration subject already exists, result
admission records no new fact. This admission reuse does not erase execution:
an invocation that executed declarations reports its own verdict and counts,
while only an invocation that skipped execution reports standing-evidence reuse.
A timeout is terminal
unsatisfied evidence; candidate unavailability, environment/setup failure,
spawn failure, unknown exit, and caller cancellation admit no attestation.

The producer captures its subject before execution, and admission never
retargets it. A completed older observation remains truthful history even when
it is no longer current. Generic lifecycle currentness alone decides whether
that evidence satisfies a declared gate. With `verified` selected, audit may
create evidence for a prospective candidate; it becomes current only if delivery
later names the same candidate. Deliver reuses matching current satisfied evidence.
A current unsatisfied verdict remains evidence, but does not suppress execution
on a later delivery:
that invocation runs Verification once against its candidate and may supersede
the failure with satisfaction. Repeated failure may deduplicate its testimony;
there is no automatic retry loop, cache, or another evidence source. `verified`
is only this producer's conventional token; other opaque gates are outside this
chapter.

Terminal failure output may be rendered as bounded contextual summary on the
attestation. Successful declaration output remains live execution evidence,
not summary material that can displace failure diagnostics. The summary is not
a log, artifact, report store, or source for callers to parse counts. A stopped producer is a typed public stop. Delivery can still
report its independently observed placement stop, but does not perform placement
until Verification and gates permit it. Audit independently observes target
followability without placing it.

Environment failures from configured scratch hooks preserve the hook's configured
name and typed failure detail as their public recovery identity; the hook's
private array position is never exposed.

An attempt can emit ephemeral observations for materialization, configured
setup and cleanup, declarations, and their stdout or stderr. They name only
witnessed phases and known execution directories; they neither claim liveness
nor become testimony, a run log, or replay
authority. Stopped process outcomes retain bounded output tails and explicit
truncation facts. Observer failure cannot affect child custody or final result.

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

Scratch provisioning and disposal are awaited physical work. Disposal is one
independently bounded removal attempt; expiry or failure becomes that attempt's
removal diagnostic. They create no marker, progress record, retry/resume state,
or durable run record. Cleanup happens after any admitted fact: a failed destroy
action or leaked disposable worktree is reported separately and cannot reverse
acceptance. Reconciliation may remove only a scratch path it can prove is no
longer owned; it never recovers the run or executes candidate commands.

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

Verification resolves declarations and produces terminal verdicts. Protocol
admits only terminal verdicts as testimony and consults the one generic
currentness judgment for reusable `verified` evidence. The producer owns its
terminal counts; package and CLI readers render adjudicated reports without
parsing process output or creating a timeline, rework count, or elapsed-time
authority.

Each verification attempt retains its captured snapshot and declaration subject.
After reintegration, completion obtains the then-applicable declaration for the
new candidate, without retargeting testimony already produced. A completion's
verification conclusion must belong to its final integration; an older run's
verdict is never attached merely because it ran earlier in the invocation.

Scratch retirement uses bounded custody independent of caller cancellation.
Resource problems from successive attempts and dependent Contracts accumulate
on the invocation answer; replacement of current verification evidence does not
consume or clear those problems.
