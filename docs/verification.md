# Verification

This chapter owns the execution-side verification producer and shared process
control. Verification is methodology, not a core fact vocabulary, core
declaration type, or core-derived gate. The attestation fact shape is defined by
[model.md](model.md), and generic gate meaning by [lifecycle.md](lifecycle.md).
The v4 library retains the v3 `Verification` declaration grammar at this edge:
ordered `bash`, `zsh`, or `pwsh` fenced scripts. The declaration value and its
producer-specific dependency rule remain private to this chapter; they are not
core fact or core gate vocabulary.

## Execution

Verification is synchronous. `deliver` and `audit` receive the invocation's
selected key-stamped `verification` derivation and execute exactly its ordered
declarations. The presence of
the `verified` token in `terms.gates` controls whether placement waits for the
attestation; it does not control whether the producer runs or whether its
attestation is recorded. A nonzero declaration produces an unsatisfied overall
verdict but does not skip a later declared executor. A candidate that cannot be
materialized, a timeout, spawn failure, or unknown exit ends the producer run
without an attestation. It does not
cancel the composed operation's later placement obligation.

There is no attestation reuse or stale-skip rule. A matching satisfied or
unsatisfied attestation is durable history, and a later testimony for the same
gate and subject supersedes it under the generic lifecycle rule; neither one
permits an invocation to omit a declaration from the admitted document
revision. The `verified` producer's subject is exactly the candidate snapshot
key and the decoded Verification segment key. Core only mints and compares
those opaque keys; it does not know how the producer chose them.

Before execution, the producer captures its `AttestationData.subject`.
Admission receives it through the core `Preparation` primitive, never
re-derives the set, and never silently retargets the result. The sole
`decideAttestation` call judges contract existence and terminal state against
its own attempt observation. It does not reject an older document or subject:
the completed run remains a truthful fact about the candidate and Verification
segment it names. Subject currentness remains placement's sole law as defined
in [lifecycle.md](lifecycle.md). The
journal attestation is the only durable execution result and the only input to
gate reading. Its optional `summary` contains the producer's bounded terminal
diagnostic text. The derivation and resolved declaration list remain
attempt-local; neither becomes a persisted derivation or second execution
authority.

If the edge's `verified` gate is declared without a valid v3 declaration, its
key-stamped absent declaration enters the owning outer legal decision. That
decision rejects it after judging document currency; it is not a preflight
readiness check, a journal deadlock, or a new core fact. Other opaque gate
tokens belong to their own producers and are outside this chapter.

The library edge performs that declaration preparation once and returns a
typed prepared or refused value. Protocol may combine that value with a
mechanical preparation, but it never reads gate names or repeats the
gate/declaration legality formula. Core receives the composed preparation and
remains the sole judge of lifecycle and document-currentness priority.

The producer resolves the admitted declarations and runs them against the
selected candidate tree. It accepts the derivation as data; it imports no
decoded document, callback, or protocol body. Deliver and audit use the same
execution path and a fresh disposable detached worktree checked out at that
candidate tree; such scratch is process-local, is never reused, and is not
derived from journal facts. A terminal process exit admits a satisfied or
unsatisfied attestation. For each terminal declaration the runtime retains the
last 16 KiB of stdout and stderr; the producer renders at most 32 KiB across the
ordered run into the attestation `summary`, including executor and exit status.
Silent successful runs omit the summary. `candidate-unavailable`, `timeout`,
`spawn-error`, and `unknown-exit` admit no attestation. Candidate materialization
is transport custody needed only to run the selected declarations; its failure
is not a new fact about the contract or candidate. `candidate-unavailable` and
`spawn-error` carry their verbatim diagnostic through the transient public
attempt so a failed transport or executable is not reported without its cause.
Placement is still attempted afterward. The
candidate remains pending only when its declared gates are unsatisfied.

Producer nonterminal outcomes and attestation-admission refusals or retries are
one public Verification-stop vocabulary: the obligation ran and admitted no
fact, with the typed reason retained. Deliver exposes that stop on its accepted
value. Audit exposes the same stop through its transient `AuditReport.attempt`.
Audit's leading observation remains accepted with zero facts when no
attestation lands. It never persists the process outcome, report, artifact, or
blob evidence outside the bounded attestation summary.

Audit may use its sole read-only observation to report a missing or moved
document when no Verification fact can be produced. Once a producer has run,
its captured preparation enters the same `decideAttestation` used by every
producer, and only that decision may issue `contract-missing` or `terminal`.
Document movement can make the resulting testimony stale for a gate; it cannot
erase the completed observation. Verification defines no audit-specific
eligibility judge.

## Runtime Contract

`src/verification/` owns producer declaration resolution and verdict
production. It does not define a core gate vocabulary or declaration type.
`src/runtime/proc/` owns process spawn, normal stop, timeout, and process-tree
kill. Its input is:

```ts
type ProcessInput = Readonly<{
  argv: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs: number
}>
```

Its result is `terminal { code, stdout, stderr, truncated }`, `timeout`,
`spawn-error { diagnostic }`, or `unknown-exit`. The producer consumes terminal
codes and bounded output to choose the verdict and render the fact summary;
signal and duration do not cross that boundary. The runtime knows no contract,
candidate, Verification plan, Akuma
projection, lease, mailbox, or public cancellation field. Callers normalize
paths before invoking it.

The same domain-free runtime owns detached spawn and process-tree custody for
long-lived callers. `spawnDetachedProcess` returns a collar containing pid,
process group, and observed start identity. `probeProcessTree` returns `gone`,
`alive`, or `unverifiable`; `putDownProcessTree` returns typed terminal
evidence without importing Akuma facts. A start-identity mismatch is never
group-killed blindly.

Each verification run has a fixed five-minute budget; exceeding it produces
`timeout`. Day one has no settings, CLI, or library timeout knob and no public
cancellation input. Execution starts detached on every platform. For timeout,
POSIX execution starts a new session and process group, sends that group a
graceful signal, waits a bounded grace interval, then force-kills the group. Windows uses
`taskkill /PID <pid> /T /F`. The portable process-tree guarantee covers the
observed tree. A subprocess that escapes the tree, or remains after SIGKILL,
harness loss, or a Node crash, lies outside that guarantee.

The runtime result is transient. Only its bounded terminal diagnostic rendering
may enter the attestation fact; it is neither cache authority nor a separate
state surface. Journal attestations do not authorize reuse, stale skipping, or
a different declaration selection.

Disposing the scratch worktree is post-admission physical cleanup. A cleanup
failure is returned as the public transient worktree leak report owned by
[public-api.md](public-api.md); it never throws over an accepted admission,
changes an outcome arm, enters reconcile, or creates a cleanup ledger.

## Ownership

The relevant dependencies are one-way:

```text
src/core/facts/gate.ts -> src/core/subject.ts
src/verification/ -> src/runtime/proc/
```

`facts/gate.ts` performs the one generic currentness check over the declared
gate and dependency-key set. It performs no IO, candidate recheck, or
producer-specific declaration interpretation.
`src/protocol/read/audit.ts` is the sole reader that derives audit rework and
attestation counts, timeline entries, and elapsed milliseconds from raw facts. The
package root exports readonly reports; the CLI renders them without journal
access or timestamp arithmetic.
