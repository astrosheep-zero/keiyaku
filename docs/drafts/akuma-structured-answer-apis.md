# Draft: Akuma Structured Answer API

> Status: non-authoritative design draft, last updated 2026-08-27.
>
> Current law and implementation still expose string Turn answers and the
> existing `call`, `tell`, `wait`, and `history` behavior. This draft records
> Faye's revised ruling after the earlier Ask/Result recommendation was rejected
> on usability grounds. It is not product authority.

## Decision

Add structured answers without adding CLI commands or requiring the caller to
predict whether an Akuma is running or idle.

```text
call     create an Akuma and submit its initial input
tell     submit later input to an existing Akuma
wait     observe lifecycle, or await one explicitly addressed input
history  read lifecycle history, or read one explicitly addressed input
```

There is no public `spawn`, `ask`, `exchange`, `result`, or `steer` command.

## Overruling Constraint

The caller must not inspect Akuma state and choose between steering the current
Turn and starting a successor Turn. Such a choice leaks Body/provider mechanics
and creates a check-then-act race because state can move after observation.

The caller knows only:

- the input bytes;
- whether it declares a schema-constrained answer contract;
- whether it waits now or detaches;
- whether a later read wants lifecycle state or its own receipt's result.

Routing remains Keiyaku's atomic responsibility.

## Current Execution Fact

Tell admission records a durable TellId before it knows which Turn will consume
the input. Delivery later records the actual `turnSequence`:

- a plain Tell may enter an open Turn;
- a plain Tell may remain pending and wake successor execution;
- several plain pending Tells may fold into one successor Turn;
- Tell delivery is at-least-once and may replay after uncertain custody.

Closed Turns remain distinct `turn/N` entries in Heart history. A later Turn
does not overwrite or reopen an earlier one.

The existing TellId and delivery-to-`turnSequence` evidence provide the needed
coordinates. No Exchange or Ask identity is required.

## Invariants

1. A schema freezes in the same durable admission that creates its answer
   contract.
2. One Turn carries at most one answer contract because one Turn has one
   terminal outcome.
3. Caller input is admitted without a runtime-state precondition.
4. Runtime routing is atomic inside Keiyaku, never selected by a caller verb.
5. One input id binds to at most one Turn. Replay after binding cannot create a
   second answer binding.

## Routing Law

### Plain Input

A Tell without schema preserves current behavior:

```text
open live-capable Turn  -> deliver into that Turn
ended/non-live Turn     -> remain pending
idle Akuma              -> wake successor execution
multiple pending Tells  -> may fold into one successor Turn
```

It means "these words belong to whichever execution consumes them." It owns no
independent answer.

### Contract Input

A Tell carrying schema declares an answer contract:

1. admission records TellId, body, schema, and ordering atomically;
2. it is never delivered into an already-open Turn;
3. it remains pending until a Turn opens specifically for that input;
4. at most one contract input opens each Turn;
5. contract inputs pending together open successor Turns in admission order;
6. ordinary plain inputs may fold into or steer that contract-owned Turn;
7. Turn open writes the TellId-to-`turnSequence` binding once;
8. later replay of the same TellId is a no-op against that binding.

This is exactly-once answer binding over at-least-once input delivery.

The same distinction applies to fresh Call. A schema on the initial input
freezes the initial Turn's answer contract and exposes that initial input id.

## Owner Library API

```ts
type InputId = string;
type TurnId = `turn/${number}`;

type Answer<T> =
  | Readonly<{ kind: "pending"; input: InputId }>
  | Readonly<{
      kind: "value";
      input: InputId;
      turn: TurnId;
      value: T;
    }>
  | Readonly<{
      kind: "invalid-output" | "failed";
      input: InputId;
      turn: TurnId;
      diagnostic: string;
    }>;
```

Fresh input:

```ts
const worker = await world.call({
  archetype: "worker",
  body: "Audit src/routes.",
  schema: routeAuditSchema,
  cwd,
});

worker.id;
worker.initialInput; // InputId for the first schema-bearing input
```

Existing Akuma input:

```ts
const receipt = await worker.tell("Audit the fixes.", {
  schema: fixAuditSchema,
});

receipt.admission.tellId; // answer coordinate
```

Plain automatic routing remains:

```ts
await worker.tell("Also inspect generated routes.");
```

Observation and result reads are distinguished by receiver or argument rather
than by another input verb:

```ts
await worker.wait();
// Akuma lifecycle observation, unchanged.

await worker.answer<FixAudit>(receipt.admission.tellId, {
  timeoutMs: 120_000,
});
// Exact result for that input id.

await worker.history({ for: receipt.admission.tellId });
// After-the-fact exact result read.
```

The exact spelling of the initial input receipt remains open. It may be an
immutable handle property or a Call return wrapper, but it must not require a
second birth or input operation.

## Package-Root Facade API

```ts
Keiyaku.call<T>({
  path,
  archetype,
  body,
  schema?,
  mode?: "wait" | "detach",
  timeoutMs?,
  cwd?,
  readonly?,
  allowed?,
  contract?,
  alias?,
}): Promise<ComposedCallResult<T>>;

Keiyaku.tell<T>({
  path,
  akuma,
  body,
  schema?,
  repo?,
}): Promise<ComposedTellResult<T>>;
```

Wait remains one operation with two closed input arms:

```ts
type LifecycleWaitInput = Readonly<{
  path: WorldRoot;
  akuma: readonly string[];
  completion?: "any" | "all";
  timeoutMs?: number;
  repo?: Repo;
}>;

type InputWaitInput = Readonly<{
  path: WorldRoot;
  akuma: string;
  for: InputId;
  timeoutMs?: number;
  repo?: Repo;
}>;

Keiyaku.wait(input: LifecycleWaitInput): Promise<AkumaWaitResult>;
Keiyaku.wait<T>(input: InputWaitInput): Promise<InputAnswerObservation<T>>;
```

The `for` arm requires exactly one directly addressed Akuma or Alias. It cannot
combine with set selectors, `any`, or `all`.

History gains the same exact input addressing:

```ts
Keiyaku.history<T>({
  path,
  akuma,
  for: inputId,
  repo?,
}): Promise<InputAnswerRead<T>>;
```

## CLI API

No commands are added:

```text
keiyaku call <archetype> [birth/composition flags]
  [--schema <file>] [--wait <duration> | --detach]
  (<prompt> | -)

keiyaku tell <aku/...|@alias>
  [--schema <file>]
  (<prompt> | -)

keiyaku wait [--any | --all] [--timeout <duration>]
  [--for <input-id>]
  <selector>...

keiyaku history <aku/...|@alias>
  [--for <input-id> | --last | --id turn/N | --before N | --since N | --limit N]
```

`--schema` names a separate file because stdin remains the prompt source. The
schema dialect and file codec are settled separately.

### Fresh Structured, Detached

```sh
keiyaku call worker --schema route-audit.schema.json --detach "Audit src/routes."
```

The receipt prints AkuId, input id, and the canonical exact wait command:

```sh
keiyaku wait aku/worker/0123abcd --for input/456
```

### Existing Akuma, Structured

The same command is valid whether the Akuma is running or idle:

```sh
keiyaku tell aku/worker/0123abcd \
  --schema fix-audit.schema.json \
  "Audit the fixes."
```

No status read or routing choice precedes it. The receipt exposes its input id.

### Live Plain Input

```sh
keiyaku tell aku/worker/0123abcd "Also inspect generated routes."
```

This remains current Tell behavior.

### Ordinary Detached Workflow

```sh
keiyaku call worker --detach "Audit src/routes."
keiyaku wait aku/worker/0123abcd
```

No ceremony is added.

### Later Exact Read

```sh
keiyaku history aku/worker/0123abcd --for input/456
```

## Structured Outcome

Keiyaku validates the complete terminal provider answer against the frozen
schema. Provider-native structured output may constrain generation but remains
an optional optimization; it cannot define the cross-provider guarantee.

Validation success persists the validated value. Parse or validation failure
persists typed `invalid-output`. Provider execution failure remains `failed`.
Observation timeout does not mutate the eventual terminal outcome.

One Turn cannot carry two answer schemas. Pending schema-bearing inputs
therefore serialize into separate Turns. Plain input may still contribute to a
contract-owned Turn because it declares no competing answer contract.

## Honest Cost

- A schema-bearing Tell never live-steers an already-open Turn. The caller
  cannot both retroactively steer that Turn and claim a new independently
  validated answer from its single outcome.
- Contract inputs waiting behind an open Turn require durable ordered pending
  admission and one-per-Turn service.
- `wait` is bivalent: set lifecycle observation by default, exact one-input
  result observation with `--for`. Grammar and types make the modes exclusive.
- Plain exact-answer ownership without schema is not introduced because no
  current requirement demonstrates it. Schema presence is the current answer
  contract signal.

## Superseded Alternatives

### Ask And Result Verbs

Rejected after user review. It exported answer ownership as a caller verb
choice and either required predicting idle state or returned a running refusal
after a check-then-act race. It also expanded the CLI with Ask and Result.

### Durable Exchange

Rejected because it added `exchangeId` beside `turn/N`, requiring a permanent
binding table and duplicate retrieval/history semantics to buy an unproven
general queue.

### Schema Tell With Frontier Retrieval

Rejected because selecting the first Turn after a Tell sequence is not causal.
Multiple pending Tells can fold into one Turn and at-least-once replay can move
delivery. The revised design instead reserves one contract input per Turn and
writes the input-id-to-Turn binding exactly once.

### Separate Steer

Rejected because the caller cannot safely decide routing from runtime state.
Plain Tell retains automatic current-versus-successor routing.

## Open Rulings Before Implementation

1. Settle atomic contract-input admission, ordered service, one-time Turn
   binding, and crash recovery.
2. Settle the initial Call input id surface in the owner library.
3. Settle public InputId grammar. TellId storage exists, but no public browsing
   grammar currently exists.
4. Settle schema dialect, codec, validator, limits, references, and diagnostics.
5. Settle persisted schema, validated value, invalid-output, and raw-answer
   byte shapes and the Heart schema cut.
6. Settle status/history/fork projections for structured and invalid outcomes.
7. Settle forwarded Body Request transport for schema-bearing Call, Tell,
   Wait-for-input, and History-for-input.
8. Settle CLI text/JSON receipt and result rendering.

## Authority Promotion Map

If accepted, promote the design through these owner chapters:

- [`akuma-execution.md`](../akuma-execution.md): plain versus contract input
  routing, ordered successor Turns, one-time binding, and replay.
- [`akuma-heart.md`](../akuma-heart.md): schema-bearing Tell admission,
  input-to-Turn binding, structured outcomes, and persisted bytes.
- [`akuma-provider.md`](../akuma-provider.md): provider-neutral schema input and
  result, plus optional native mapping.
- [`akuma-public.md`](../akuma-public.md): widened Tell, answer/history reads,
  initial input receipt, and lifecycle-versus-input Wait.
- [`akuma.md`](../akuma.md): schema-bearing initial Call input.
- [`public-akuma.md`](../public-akuma.md): facade composition and result shapes.
- [`akuma-requests.md`](../akuma-requests.md): forwarded transport and recovery.
- [`cli.md`](../cli.md) and [`cli-output.md`](../cli-output.md): flags, mutual
  exclusions, receipts, and text/JSON projection.

## Provenance

Faye's first 2026-08-27 ruling recommended Call/Ask/Tell/Result. The user
rejected its command count and the requirement to choose steering versus
successor work. Faye explicitly overruled that export in her second ruling and
retained only the answer-contract invariant. This draft records the revised
Call/Tell/Wait/History design.
