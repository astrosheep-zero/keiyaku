# Draft: Akuma Structured Answer APIs

> Status: non-authoritative design draft, last updated 2026-08-27.
>
> Current law and implementation still expose `call`, `tell`, `wait`, and
> string Turn answers. This draft records three API alternatives and Faye's
> recommendation. It is not product authority. A settled change must update
> the owning chapters listed at the end.

## Decision

Keiyaku needs schema-constrained output for both:

1. the first Turn created with a fresh Akuma; and
2. a later Turn on an existing idle Akuma.

The API has three independently designed surfaces:

- the owner library exported from `./akuma`;
- the package-root `Keiyaku` facade;
- the `keiyaku` CLI.

The ordinary detached path must remain one dispatch followed by one wait. A
fresh call must not become `spawn`, then `tell`, then `wait` merely to expose a
schema-capable primitive.

## Current Execution Fact

The decisive fact is that a current Tell is not a request and does not own a
Turn. Heart first records it on the Body timeline. The Body later decides how
to deliver it:

- a live-capable Session can accept it into the current open Turn;
- an ended or non-live-capable Session leaves it pending for a successor;
- an idle Akuma wakes and opens a successor Turn from every pending Tell at
  that checkpoint;
- several pending Tells can therefore share one successor Turn and one answer.

The original Turn remains a distinct closed `turn/N` in Heart history. A later
Turn never overwrites or reopens it, even when the provider session preserves
conversation context.

Consequently, `tell(body, schema)` has no intrinsic answer coordinate under
current semantics. One Tell may join an existing Turn, several Tells may be
folded into one new Turn, and replay may deliver a pending Tell again. Schema
needs an answer owner that current Tell admission does not provide.

## Deciding Invariant

Faye's recommended invariant is:

> Schema is frozen by the same durable admission that creates the answer
> coordinate, and every Turn has exactly one opener.

The existing `turn/N` coordinate should identify the owned answer. Lifecycle
observation over an Akuma or fleet remains distinct from waiting for or reading
one exact Turn result.

## Design A: Turn-Opening Admission

This is Faye's recommendation.

### Ontology

Every Turn has exactly one opener:

- `call` opens the initial Turn while creating a fresh Akuma;
- `ask` opens one successor Turn on an existing idle Akuma;
- the Body may still open an unowned successor Turn by folding ordinary pending
  Tells, preserving today's Tell behavior.

The opener freezes the body and optional schema while admitting `turn/N`.
`tell` remains delivery or steering and never owns an answer. An Ask against an
Akuma with an open Turn returns a typed running refusal; it does not queue or
merge into that Turn.

### Owner Library

Representative surface:

```ts
type TurnId = `turn/${number}`;

type TurnRef<T = string> = Readonly<{
  id: TurnId;
  outcome(options?: { timeoutMs?: number }): Promise<TurnOutcome<T>>;
  result(options?: { timeoutMs?: number }): Promise<T>;
}>;

type CallResult<T = string> = Readonly<{
  akuma: AkumaHandle;
  turn: TurnRef<T>;
}>;

type AskAdmission<T = string> =
  | Readonly<{ kind: "opened"; turn: TurnRef<T> }>
  | Readonly<{ kind: "running"; turn: TurnId }>;

const world = Akuma.of(worldRoot, { home, settings });

const fresh = await world.call({
  archetype: "worker",
  body: "Audit src/routes.",
  schema: routeAuditSchema,
  cwd,
});

const later = await fresh.akuma.ask({
  body: "Audit the fixes.",
  schema: fixAuditSchema,
});

await fresh.akuma.tell("Also inspect the generated routes.");
await fresh.akuma.wait(); // lifecycle only
await fresh.turn.result(); // exact initial result
```

The exact return spelling may preserve the current handle return by exposing
`initialTurn` on it. The semantic requirement is that successful Call exposes
both the durable Akuma and its initial `turn/N` without a second public birth or
input operation.

### Package-Root Facade

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

Keiyaku.ask<T>({
  path,
  akuma,
  body,
  schema?,
  mode?: "wait" | "detach",
  timeoutMs?,
  repo?,
}): Promise<ComposedAskResult<T>>;

Keiyaku.result<T>({
  path,
  akuma,
  turn,
  timeoutMs?,
  repo?,
}): Promise<ExactTurnResult<T>>;
```

`CallResult` gains the initial Turn coordinate. `AskResult` contains the exact
successor coordinate or a typed running refusal. `result` addresses one Akuma
and one Turn. Existing `tell`, `wait`, `status`, `history`, `interrupt`, `fork`,
and `kill` retain their current meanings.

### CLI

```text
keiyaku call <archetype> [birth/composition flags]
  [--schema <file>] [--wait <duration> | --detach]
  (<prompt> | -)

keiyaku ask <aku/...|@alias>
  [--schema <file>] [--wait <duration> | --detach]
  (<prompt> | -)

keiyaku result <aku/...|@alias> turn/N [--timeout <duration>]

keiyaku tell <aku/...|@alias> (<prompt> | -)
keiyaku wait <selector>...
```

The schema uses a separate file because stdin remains the prompt source. The
schema dialect and file codec remain a later settlement.

Examples:

```sh
# Fresh structured result, observed now.
keiyaku call worker --schema route-audit.schema.json "Audit src/routes."

# Fresh detached work. Output includes aku/... and turn/N plus canonical result command.
keiyaku call worker --schema route-audit.schema.json --detach "Audit src/routes."
keiyaku result aku/worker/0123abcd turn/1

# Existing idle Akuma, later structured result.
keiyaku ask aku/worker/0123abcd --schema fix-audit.schema.json "Audit the fixes."

# Live steering has no independent answer.
keiyaku tell aku/worker/0123abcd "Also inspect generated routes."

# Existing ordinary path stays unchanged.
keiyaku call worker --detach "Audit src/routes."
keiyaku wait aku/worker/0123abcd
```

### Result Semantics

Schema presence selects a distinct terminal success type:

```ts
type TurnOutcome<T = string> =
  | Readonly<{ kind: "answered"; turn: TurnId; output: T }>
  | Readonly<{ kind: "failed"; turn: TurnId; diagnostic: string }>
  | Readonly<{ kind: "invalid-output"; turn: TurnId; diagnostic: string }>
  | Readonly<{ kind: "timed-out"; turn: TurnId }>;
```

For a text Turn, `output` is its complete string answer. For a structured Turn,
`output` is the validated value. Timeout ends only the observation and leaves
the admitted Turn running or recoverable. Provider-native schema support is an
optional generation optimization; Keiyaku-side validation provides the common
guarantee.

### Cost

- Adds `ask` and exact `result` operations.
- Requires Call/Ask admission to allocate the durable Turn coordinate before
  the Body drives it.
- Makes Ask versus Tell decidable: use Ask when the caller owns an answer; use
  Tell when it only delivers or steers input.
- Adds no ceremony to existing Call, Tell, lifecycle Wait, or fleet paths.
- Reuses one existing coordinate and avoids a second durable request identity.

## Design B: Durable Exchange

### Ontology

An Exchange is a second durable noun containing one body and optional schema.
It receives an `exchangeId` at admission. The execution loop serves one Exchange
into one Turn and persists the `exchangeId -> turn/N` binding. Call carries an
initial Exchange so fresh structured work still uses one operation.

Unlike Design A, an Exchange admitted while a Turn is open can queue for a
successor rather than returning running.

### Owner Library

```ts
const fresh = await world.call({
  archetype: "worker",
  exchange: { body: "Audit src/routes.", schema: routeAuditSchema },
});

const exchange = await fresh.akuma.exchange({
  body: "Audit the fixes.",
  schema: fixAuditSchema,
});

await exchange.settle();
await fresh.akuma.tell("Also inspect generated routes.");
```

### Package-Root Facade

```ts
Keiyaku.call<T>({ path, archetype, exchange: { body, schema? }, ...composition });
Keiyaku.exchange<T>({ path, akuma, body, schema?, repo? });
Keiyaku.settle<T>({ path, exchange, timeoutMs?, repo? });
```

### CLI

```text
keiyaku call <archetype> --exchange [--schema <file>]
  [--wait <duration> | --detach] (<prompt> | -)

keiyaku exchange <aku/...|@alias> [--schema <file>] (<prompt> | -)
keiyaku settle <exchange-id> [--timeout <duration>]
keiyaku tell <aku/...|@alias> (<prompt> | -)
keiyaku wait <selector>...
```

The precise fresh Call union could retain plain `body` as shorthand, but doing
so creates two spellings for first input.

### Cost

- Creates a second durable identity beside `turn/N`.
- Requires permanent Exchange-to-Turn binding and consistency between Settle
  and Turn history.
- Makes every future history, fork, interrupt, cancellation, and retention
  change answer what an Exchange means.
- Buys a durable queue for later answer-owning work, but no current requirement
  demonstrates that queue is needed.
- Adds more ceremony and future-change friction than Design A.

## Design C: Schema-Bearing Tell And Frontier Wait

### Ontology

No new verb or durable noun is introduced. Call and Tell accept schema. A
schema-bearing Tell is prevented from live routing and deferred to a successor
Turn. Its receipt exposes a Heart sequence. Result retrieval selects the first
closed Turn after that frontier.

### Owner Library

```ts
const akuma = await world.call({ archetype: "worker", body, schema });
const receipt = await akuma.tell("Audit the fixes.", { schema: fixAuditSchema });
const result = await akuma.waitResult({ after: receipt.sequence });
```

### Package-Root Facade

```ts
Keiyaku.call<T>({ path, archetype, body, schema?, ...composition });
Keiyaku.tell<T>({ path, akuma, body, schema?, repo? });
Keiyaku.wait<T>({ path, akuma, resultAfter?, timeoutMs?, repo? });
```

### CLI

```text
keiyaku call <archetype> [--schema <file>]
  [--wait <duration> | --detach] (<prompt> | -)

keiyaku tell <aku/...|@alias> [--schema <file>] (<prompt> | -)
keiyaku wait --result <aku/...|@alias> --after <sequence>
  [--timeout <duration>]
```

### Cost And Rejection

This is the smallest surface change and the weakest semantic design:

- adding schema silently changes Tell from live-capable steering to deferred
  successor work;
- multiple pending Tells can still fold into one Turn, forcing an arbitrary
  schema winner or silent schema loss;
- at-least-once Tell replay can change which Turn consumes the input;
- the first Turn after a sequence is not proof that it consumed that Tell;
- lifecycle Wait becomes mixed with causally loose result retrieval;
- an agent caller receives ambiguity where the product promises typed facts.

The current execution model falsifies this design. It is retained here only as
the minimal-surface alternative that the other designs must beat.

## Recommendation

Choose Design A.

It places answer ownership on the existing domain identity rather than adding
an Exchange identity or guessing from a Tell frontier. It preserves current
Tell delivery, current lifecycle Wait, and the ordinary detached Call path. It
also leaves a narrow extension point: Ask may return running today and gain an
explicit queue only if a real caller later requires one.

The vocabulary follows the ownership rule:

```text
call   = create Akuma and open its initial owned Turn
ask    = open one owned successor Turn on an existing idle Akuma
tell   = deliver or steer input without owning an answer
wait   = observe Akuma lifecycle, including sets
result = await or read one exact turn/N outcome
```

Tell may still wake an idle Akuma and contribute to an unowned successor Turn.
That does not make it Ask. It becomes Ask only when the caller durably owns the
answer coordinate.

## Open Rulings Before Implementation

1. Settle the atomic Call/Ask-to-Turn admission and crash-recovery protocol.
2. Settle whether owner Call returns `{ akuma, turn }` or preserves the handle
   return with `initialTurn` attached.
3. Settle the schema dialect, codec, validator, limits, reference policy, and
   diagnostic bounds.
4. Settle persisted structured success and invalid-output byte shapes, raw
   answer visibility, history projection, and fork eligibility.
5. Settle text versus structured generic overloads and typed timeout/refusal
   results.
6. Settle forwarded Body Request transport for Ask and exact Result.
7. Settle CLI text/JSON rendering and the canonical detached result command.

## Authority Promotion Map

If Design A is accepted, promote it through these owner chapters rather than
treating this draft as law:

- [`public-akuma.md`](../public-akuma.md): package-root Call, Ask, Result, and
  composition.
- [`akuma.md`](../akuma.md): Call birth plus initial Turn ownership.
- [`akuma-execution.md`](../akuma-execution.md): Turn-opening admission, busy,
  Tell interaction, execution, and recovery.
- [`akuma-heart.md`](../akuma-heart.md): admitted Turn/schema facts, structured
  outcomes, persisted bytes, and schema gate.
- [`akuma-provider.md`](../akuma-provider.md): schema-bearing drive input,
  provider-neutral output, and optional native optimization.
- [`akuma-public.md`](../akuma-public.md): handle Ask/Result, Turn references,
  outcomes, history, and lifecycle Wait boundary.
- [`akuma-requests.md`](../akuma-requests.md): forwarded Ask/Result transport.
- [`cli.md`](../cli.md) and [`cli-output.md`](../cli-output.md): grammar and
  text/JSON projection.

## Provenance

This draft incorporates Faye's 2026-08-27 ruling in PUBLIC Square after she was
given the current owner-library, facade, CLI, Heart Turn, Body Tell-folding,
provider, wait, and history facts. Faye recommended Design A and rejected the
other two for, respectively, unnecessary second identity and causal ambiguity.
