# Verification

This chapter owns the execution-side verification producer and shared process
control. Verification is methodology, not a core fact vocabulary, core
declaration type, or core-derived gate. The attestation fact shape is defined by
[model.md](model.md), and generic gate meaning by [lifecycle.md](lifecycle.md).
The producer's declaration shape, section syntax, and dependency law remain
explicitly unfrozen and are owned outside core.

## Execution

Verification is synchronous. An owning library operation records its selected
candidate, resolves a valid producer declaration, and runs that producer. A
matching satisfied attestation for the producer's declared opaque gate and
subject is reusable and starts no process. A matching unsatisfied attestation
is durable history; a later testimony for the same gate and subject supersedes
it. The producer or operation chooses the lawful dependency-key set, while core
mints the keys and performs the generic currentness check.

Before execution, the producer captures its `AttestationData.subject`. Admission
compares that captured set with the current set and refuses `stale-subject` when
state changed during execution; it never silently retargets the result. The
journal attestation is the only durable execution result and the only input to
gate reading.

If a declared gate requires this producer but no valid declaration exists, the
owning outer boundary rejects the operation. The absence is not a journal
deadlock or a new core fact.

The producer resolves its declared executor and runs it against the selected
candidate tree. Audit uses a disposable detached worktree checked out at that
candidate tree. A terminal process exit admits a satisfied or unsatisfied
attestation with an optional bounded summary. `timeout`, `spawn-error`, and
`unknown-exit` admit no attestation. A delivered candidate remains pending
after such an outcome.

Audit passes a producer's nonterminal outcome to its transient
`AuditReport.attempt.failure` only when that invocation ran the producer and
admitted no attestation. It never persists the process outcome, raw
output, report, artifact, or blob evidence.

## Runtime Contract

`src/verification/` owns producer declaration resolution and verdict
production. It does not define a core gate vocabulary or declaration type.
`src/runtime/proc/` owns process spawn, normal stop, process-tree kill, bounded
stdout/stderr capture, and elapsed duration. Its input is:

```ts
type ProcessInput = Readonly<{
  argv: readonly string[]
  cwd: string
  env: Readonly<Record<string, string>>
  timeout: number
  outputLimits: OutputLimits
}>
```

Its result is a typed `exit`, `timeout`, or `spawn-error` outcome with bounded
streams and duration. The runtime knows no contract, candidate, Verification
plan, Akuma projection, lease, or mailbox field. Callers normalize paths before
invoking it.

For normal timeout or caller-requested cancellation, POSIX execution starts a
new session and process group, sends that group a graceful signal, waits a
bounded grace interval, then force-kills the group. Windows uses
`taskkill /PID <pid> /T /F`. The portable process-tree guarantee covers the
observed tree. A subprocess that escapes the tree, or remains after SIGKILL,
harness loss, or a Node crash, lies outside that guarantee.

The runtime result is transient. It is neither cache authority nor a state
surface. Matching current attestations in the journal supply the only reuse
rule.

## Ownership

The relevant dependencies are one-way:

```text
src/core/facts/gate.ts -> src/core/subject.ts
src/core/verbs/attestation.ts -> src/core/subject.ts
src/verification/ -> src/runtime/proc/
src/akuma/ -> src/runtime/proc/
```

`facts/gate.ts` performs the one generic currentness check over the declared
gate and dependency-key set. It performs no IO, candidate recheck, or
producer-specific declaration interpretation.
`src/protocol/read/audit.ts` is the sole reader that derives audit rework and
attestation counts, timeline entries, and elapsed milliseconds from raw facts. The
package root exports readonly reports; the CLI renders them without journal
access or timestamp arithmetic.
