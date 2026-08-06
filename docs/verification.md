# Verification

This chapter owns Verification plan execution, runtime process control, and the
fact-producing read of matching results. Its declaration grammar is owned by
[document.md](document.md), its fact shape by [model.md](model.md), and its
gate meaning by [lifecycle.md](lifecycle.md).

## Execution

Verification is synchronous. `deliver` records its selected candidate, then
uses the Verification producer for that candidate. `audit` uses the same
producer when its current candidate has no matching result. A terminal producer
result is admitted as a separate `verification` fact. The producer is not an
independent public lifecycle.

The declaration key is the one pure canonicalization primitive in
`src/core/declaration-key.ts`. Gate reading, verification admission, and plan
resolution consume that primitive; none defines another declaration key.

Before starting a process, the producer reads the folded journal for a fact
matching the current candidate and declaration key. A matching `pass` already
satisfies verification and starts no process. A matching `fail` is durable
history and an explicit `deliver` or `audit` may produce a later result that
supersedes it. The journal fact is the only durable execution result and the
only input to gate reading.

Verification resolves the declared executor and runs it against the selected
candidate tree. Audit uses a disposable detached worktree checked out at that
candidate tree. A terminal process exit admits `pass` or `fail` with an
optional bounded summary. `timeout`, `spawn-error`, and `unknown-exit` admit no
verification fact. A delivered candidate remains pending after such an outcome.

Audit passes a producer's nonterminal outcome to its transient
`AuditReport.attempt.failure` only when that invocation ran the producer and
admitted no Verification fact. It never persists the process outcome, raw
output, report, artifact, or blob evidence.

## Runtime Contract

`src/verification/` owns plan resolution and verdict production.
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
surface. The journal's matching Verification facts supply the only reuse rule.

## Ownership

The relevant dependencies are one-way:

```text
src/core/facts/gate.ts -> src/core/declaration-key.ts
src/core/verbs/verification.ts -> src/core/declaration-key.ts
src/verification/ -> src/core/declaration-key.ts
src/verification/ -> src/runtime/proc/
src/akuma/ -> src/runtime/proc/
```

`facts/gate.ts` makes structural and key comparisons shared by gate reads,
verification admission, and read views. It performs no IO or candidate recheck.
`src/protocol/read/audit.ts` is the sole reader that derives audit rework and
review counts, timeline entries, and elapsed milliseconds from raw facts. The
package root exports readonly reports; the CLI renders them without journal
access or timestamp arithmetic.
