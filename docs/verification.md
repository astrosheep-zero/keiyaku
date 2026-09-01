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

Deliver and audit run the selected declarations against the exact integration
snapshot in a disposable, snapshot-provisioned environment. Caller-current
settings, user state, lockfiles, and installed dependencies cannot substitute
for that snapshot authority. Each declaration and scratch setup or cleanup
hook inherits the caller process environment through the shared runtime. That
ambient environment is execution input only: it is intentionally not captured
in evidence or made part of Contract/Core authority. Matching snapshot and
declaration subjects may therefore reuse testimony; this is an accepted
product tradeoff, not a reproducibility claim. Declarations run in order even
after a failing command. A terminal run records one ordinary `verified`
attestation with a satisfied or unsatisfied verdict. A timeout is terminal unsatisfied evidence;
candidate unavailability, environment setup failure, spawn failure, unknown
exit, and caller cancellation admit no attestation.

The producer captures its subject before execution, and admission never
retargets it. A completed older observation remains truthful history even when
it is no longer current. Generic lifecycle currentness alone decides whether
that evidence satisfies a declared gate. Audit may create evidence for a
prospective candidate; it becomes current only if delivery later names the same
candidate. Deliver can reuse matching current evidence, satisfied or
unsatisfied, without creating a cache or another evidence source. `verified`
is only this producer's conventional token; other opaque gates are outside this
chapter.

Terminal output may be rendered as bounded contextual summary on the
attestation. It is not a log, artifact, report store, or source for callers to
parse counts. A stopped producer is a typed public stop. Delivery can still
perform its independent placement duty; audit leaves target state unobserved.

## Process And Cleanup Boundary

The shared runtime owns child spawning, normal completion, timeout,
cancellation, and termination of the process tree rooted at the child while the
caller retains that child handle. It is domain-free: it knows no Contract,
candidate, declaration plan, Akuma, lease, or public operation. Cancellation or
timeout terminates owned work; releasing a live process relinquishes custody
without terminating it. Escaped descendants and processes surviving harness
loss or process crash are outside that portable guarantee. No persisted pid,
reconstructed process identity, or background disposer supplies a second
termination authority.

Scratch provisioning and disposal are awaited physical work. They create no
marker, progress record, retry/resume state, or durable run record. Cleanup
happens after any admitted fact: a failed destroy action or leaked disposable
worktree is reported separately and cannot reverse acceptance. Reconciliation
may remove only a scratch path it can prove is no longer owned; it never recovers
the run or executes candidate commands.

## Ownership

Verification resolves declarations and produces terminal verdicts. Protocol
admits only terminal verdicts as testimony and consults the one generic
currentness judgment for reusable `verified` evidence. The producer owns its
terminal counts; package and CLI readers render adjudicated reports without
parsing process output or creating a timeline, rework count, or elapsed-time
authority.
