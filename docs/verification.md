# Verification

This chapter owns the execution-side verification producer and shared process
control. Verification is methodology, not a core fact vocabulary, core
declaration type, or core-derived gate. The attestation fact shape is defined by
[model.md](model.md), and generic gate meaning by [lifecycle.md](lifecycle.md).
The library owns the `Verification` declaration grammar at this edge:
ordered `bash`, `zsh`, or `pwsh` fenced scripts, each with an optional
`timeout=<positive-safe-integer-milliseconds>` fence attribute. The declaration value and its
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
materialized, whose snapshot-owned environment cannot become ready, a spawn
failure, an unknown exit, or caller cancellation ends the producer run without
an attestation. A declaration timeout is instead a terminal unsatisfied
verdict and does not skip a later declared executor. It does not
cancel the composed operation's later placement obligation.

There is no attestation reuse or stale-skip rule. A matching satisfied or
unsatisfied attestation is durable history, and a later testimony for the same
gate and subject supersedes it under the generic lifecycle rule; neither one
permits an invocation to omit a declaration from the admitted document
revision. The `verified` producer's subject is exactly the delivery's
integration snapshot
key and the decoded Verification segment key. Core only mints and compares
those opaque keys; it does not know how the producer chose them.

Before execution, the producer captures its `AttestationData.subject`.
Admission receives it through the core `Preparation` primitive, never
re-derives the set, and never silently retargets the result. The sole
`decideAttestation` call judges contract existence and terminal state against
its own attempt observation. It does not reject an older document or subject:
the completed run remains a truthful fact about the integration and Verification
segment it names. Subject currentness remains placement's sole law as defined
in [lifecycle.md](lifecycle.md). The
journal attestation is the only durable execution result and the only input to
gate reading. Its optional `summary` contains the producer's bounded terminal
diagnostic text. The derivation and resolved declaration list remain
attempt-local; neither becomes a persisted derivation or second execution
authority.

If the edge's `verified` gate is declared without a valid declaration, its
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
selected integration tree. It accepts the derivation as data; it imports no
decoded document, callback, or protocol body. Deliver and audit follow one
scratch path: materialize a fresh detached worktree at the integration
snapshot; decode its tracked project `.keiyaku/settings.json`; execute its
ordered `worktree.create` commands; run Verification only after they all
succeed; execute its `worktree.destroy` commands best-effort; then remove it.
The create/destroy command primitive is also the one used by managed worktree
reconciliation, but scratch has no marker, progress, retry, resume, or durable
record. Its snapshot, Settings, and lockfiles are the only provisioning
authority: caller-current Settings, user Settings, lockfiles, and `node_modules`
never enter the run.

A create command failure, timeout, or snapshot Settings decode failure is the
typed nonterminal `environment-failure`; it skips declarations and admits zero
attestations. A materialization failure is `candidate-unavailable`. After ready
execution, a terminal process exit admits a satisfied or unsatisfied
attestation. For each terminal declaration the runtime retains the last 16 KiB
of stdout and stderr; the producer renders at most 32 KiB across the ordered run
into the attestation `summary`, including executor and exit status. Silent
successful runs omit the summary. `spawn-error`, `unknown-exit`, and caller
cancellation admit no attestation. A declaration timeout is instead a terminal
unsatisfied verdict and may be attested. `candidate-unavailable` and
`spawn-error` carry their verbatim diagnostic through the transient public
attempt so a failed Git executable is not reported without its cause.
Placement is still attempted afterward. The
integration remains pending only when its declared gates are unsatisfied.

Producer nonterminal outcomes, typed environment failure, and attestation-
admission refusals or retries are one public Verification-stop vocabulary: the
obligation ran and admitted no fact, with the typed reason retained. Deliver
exposes that stop on its accepted value. Audit exposes the same stop through
its transient `AuditReport.attempt`.
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

Verification owns producer declaration resolution and verdict production. It
does not define a core gate vocabulary or declaration type. The shared process
runtime owns spawn, normal stop, timeout, and process-tree kill. Its input is:

```ts
type ProcessInput = Readonly<{
  argv: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  signal?: AbortSignal
}>
```

Its result is `terminal { code, stdout, stderr, truncated }`, `timeout`,
`cancelled`, `spawn-error { diagnostic }`, or `unknown-exit`. The producer consumes terminal
codes and bounded output to choose the verdict and render the fact summary;
only its typed process outcome crosses that boundary. The runtime knows no contract,
candidate, Verification plan, Akuma
projection, lease, mailbox, or public operation. Callers normalize
paths before invoking it.

`runProcessToExit` is the separate unbounded wait for a detached supervisor
process whose owned operation already enforces its own finite timeout. It takes
the same argv, cwd, and environment but no timeout and returns the same process
outcome without a `timeout` arm in practice. It never runs an unbounded user
command directly; managed-worktree Hook runners are its sole consumer.

The same domain-free runtime owns detached spawn and process-tree custody for
long-lived callers. `spawnDetachedProcess` returns a collar containing pid,
process group, and observed start identity. `probeProcessTree` returns `gone`,
`alive`, or `unverifiable`; `putDownProcessTree` returns typed terminal
evidence without importing Akuma facts. A start-identity mismatch is never
group-killed blindly.

Each declaration has only its optional Markdown timeout; omission is unbounded.
A declaration timeout is terminal unsatisfied testimony. Caller cancellation is
nonterminal and `deliver`/`audit` accepts an optional `AbortSignal`. There is no
global Verification timeout, Settings key, CLI flag, library option, or
environment variable. Execution starts detached on every platform. For timeout,
POSIX execution starts a new session and process group, sends that group a
graceful signal, waits a bounded grace interval, then force-kills the group. Windows uses
`taskkill /PID <pid> /T /F`. The portable process-tree guarantee covers the
observed tree. A subprocess that escapes the tree, or remains after SIGKILL,
harness loss, or a Node crash, lies outside that guarantee.

The runtime result is transient. Only its bounded terminal diagnostic rendering
may enter the attestation fact; it is neither cache authority nor a separate
state surface. Journal attestations do not authorize reuse, stale skipping, or
a different declaration selection.

Disposing the scratch worktree is post-admission physical cleanup. A failed
destroy command is returned separately from a worktree-removal leak; neither
throws over an accepted admission or changes an outcome arm. These transient
reports never become reconcile input or a cleanup ledger. Reconciliation may
independently remove a registered scratch path whose encoded owner process is
provably gone or replaced, using fresh Git topology only; it never recovers the
run or executes candidate commands.

## Ownership

The generic gate currentness judge is pure over the declared gate and
dependency-key set. It performs no IO, candidate recheck, or producer-specific
declaration interpretation. Protocol is the sole reader that derives audit
rework and attestation counts, timeline entries, and elapsed milliseconds from
raw facts. The package root exports readonly reports; the CLI renders them
without journal access or timestamp arithmetic.
