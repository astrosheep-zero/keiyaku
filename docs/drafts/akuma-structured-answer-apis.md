# Design Draft: Akuma API And Structured Answers

> Status: design for Faye review. This is not authority until the reviewed
> decisions are promoted to the owning `docs/` chapters in the same accepted
> change.

## Goal

The public library presents one thing: an Akuma. A caller creates one, tells it
something, receives that tell's answer, waits for its lifecycle when needed,
reads its timeline, and kills it. The caller never names an owner, Body, born
record, handle, Turn, provider session, or routing mode.

The CLI is a consumer of this library. It keeps its existing command vocabulary
and output contracts by composing the library operations; the library does not
imitate CLI command shape.

## Public Akuma API

The `keiyaku/akuma` export contains one public class and supporting value/type
exports. Construction over an existing identity is synchronous and read-free;
birth and all Heart/provider operations are asynchronous.

```ts
import { Akuma, Schema } from "keiyaku/akuma";

const aku = await Akuma.birth("reviewer", { root, alias: "reviewer" });
const existing = Akuma.select(root, "aku/reviewer/0123abcd");

const text: string = await existing.tell("continue");
const result = await existing.tell("return the audit", {
  schema: Schema.zod(auditSchema),
});
await existing.tell("stop and take this path", {
  schema: Schema.zod(nextSchema),
  interrupt: true,
});
await existing.idle({ timeoutMs: 300_000 });
const timeline = await existing.history({ limit: 100 });
await existing.kill();
```

The exact public declarations are:

```ts
export type JsonSchema = Readonly<Record<string, unknown>>;

export type Schema<T> = Readonly<{
  readonly jsonSchema: JsonSchema;
  readonly decode: (value: unknown) => T;
}>;

export const Schema: Readonly<{
  zod<T extends import("zod").$ZodType>(schema: T): Schema<import("zod").output<T>>;
  json<T>(jsonSchema: JsonSchema, decode: (value: unknown) => T): Schema<T>;
}>;

export class Akuma {
  static birth(
    archetype: string,
    options: Readonly<{
      root: WorldRoot;
      alias?: string;
      readonly?: true;
      allowed?: readonly AllowedAction[];
      contract?: string;
    }>,
  ): Promise<Akuma>;
  static select(root: WorldRoot, selector: string): Akuma;

  readonly id: AkuId;
  tell(text: string): Promise<string>;
  tell<T>(text: string, options: Readonly<{ schema: Schema<T>; interrupt?: boolean }>): Promise<T>;
  idle(options?: Readonly<{ timeoutMs?: number }>): Promise<void>;
  history(options?: HistoryOptions): Promise<ActivityHistory>;
  kill(): Promise<void>;
}
```

There is no public `call`, `of`, `status`, `wait`, `interrupt`, `AkumaHandle`,
Turn type, or result/receipt object. `birth` creates only the Akuma; it does not
submit a prompt. A fresh prompt is an ordinary `tell`, so CLI `call` is simply
`birth` followed by `tell`.

The return type of `tell` has only a static overload distinction: no schema is a
string answer; a statically typed `Schema<T>` is a `T` answer. Runtime flags do
not change the return type. Admission, routing, provider failure, and output
decode failure all reject this same Promise with typed errors. An empty provider
answer is a successful empty string (or a schema decode failure), never a
special missing-answer value.

`Schema.zod` uses the installed Zod v4 `toJSONSchema` conversion and `parse`
decoding. `Schema.json` is the provider-neutral escape hatch for callers that
already own a JSON Schema and decoder. Both constructors clone/freeze the JSON
Schema, reject non-JSON values, and enforce the same size and keyword limits.
The public schema object is immutable; provider adapters never receive the
decoder function.

## Tell Semantics

Tell admission is one Heart transaction. It verifies Soul existence, allocates
an opaque internal TellId, stores the text and (when present) canonical schema
JSON, and records ordering. The transaction either admits the Tell or rejects
without leaving future input behind.

Plain Tell keeps its current meaning: an open live-capable Body may consume it;
otherwise it remains pending and wake starts a successor. Several plain Tells
may be consumed by one successor Turn. The caller never chooses this route.

A schema-bearing Tell is an answer contract for one new Turn. If a live Body is
running, admission without `interrupt: true` rejects with a typed busy refusal
and does not record the Tell. Busy is judged solely by the Heart's Body life
fact, using the same running/non-running split as lifecycle completion; whether
a Turn row is currently open is not a busy test. With `interrupt: true`, the existing interrupt
protocol settles the exact Body and proves leash custody, then records this Tell
and wakes a successor. When no live Body is open, the Tell is recorded and wake
starts the successor directly. A schema-bearing Tell is never inserted into an
already-open Turn and never silently interrupts one. On an idle Akuma,
`interrupt: true` has no Body to settle and is equivalent to record-plus-wake.

The busy judgment and Tell admission are one Heart transaction. Body life is a
durable Heart fact; no provider-process observation may be performed between a
busy check and admission. Concurrent schema Tells therefore cannot both pass a
stale observation during a wake window.

The Turn is born with at most one schema. Every Tell, plain or schema-bearing,
is bound exactly once to the Turn that consumes it: a live steer binds while the
open Turn is selected, and successor drain binds pending Tells as the Turn is
opened. The binding is immutable and idempotent under at-least-once delivery.
Drain is admission order: the first pending Tell opens the Turn; following
plain Tells join it; a schema Tell stops the drain when that Turn is already
open and is opened by a later successor Turn. Plain Tells may join a
schema-owned Turn because they declare no competing answer contract. Multiple
schema Tells therefore receive separate Turns and separate answers rather than
being refused merely because another schema Tell is pending.

After provider terminal evidence, Body parses JSON syntax for a schema-owned
Turn. Valid JSON is persisted as `answer_json`; malformed JSON persists an
`invalid-output` terminal with the original raw answer. Schema decoding is a
caller-side operation: the owner invokes the frozen decoder after reading the
exact answer. Decode success resolves the tell Promise with `T`; decoder
failure rejects with `AkumaInvalidOutputError` and is not persisted. Provider
failure rejects with `AkumaTurnFailedError`. These terminal facts remain in
Heart and are visible in the ordinary activity timeline; waiting never selects
a latest Turn.

## Exact Answer Association

The Promise returned by `tell` closes over its generated TellId. The owner does
not inspect status and does not infer a frontier. It waits for one of the
following durable facts for that TellId: terminal provider outcome, typed
undelivered outcome, or a terminal admission/routing failure. Delivery rows
provide the TellId-to-Turn sequence for every Tell, plain or schema-bearing;
the owner then waits on that exact Turn until its terminal outcome. A later Turn
cannot satisfy an earlier Tell. If a Body becomes inert through crash, kill, or
hung cleanup while a bound Turn is open, that same owned cleanup pass writes a
failed terminal with exit evidence. Every Tell bound to that Turn rejects with
`AkumaTurnFailedError`; the Turn is never replayed. Unconsumed pending Tells
retain the existing disposition and wake rules.

`idle()` is lifecycle-only and returns `void`. It waits until the Akuma is not
running and has no pending Tell, or until its timeout, then resolves with no
answer. `history()` remains the activity timeline and accepts the existing
history selectors; it is not converted into prompt/answer pairs. Public history
rows retain opaque `turn/N` ids for exact internal/fork operations without
exporting a Turn type.

## Heart Persistence

Heart remains the sole durable authority. The schema cut adds only facts read by
the new behavior:

- `tells.schema_json`: canonical provider-neutral schema for a schema-bearing
  Tell, null for plain input;
- `turns.schema_json`: the frozen schema copied at Turn birth, null for a plain
  Turn;
- `turns.answer_json`: the exact provider answer bytes when the Turn is
  schema-owned;
- `turns.outcome = 'invalid-output'` with a diagnostic when JSON parsing or
  decoding fails.

Existing string answers remain in the existing answer column for plain Turns.
The migration is a versioned Heart schema cut, never an in-place best-effort
upgrade: old Hearts are refused as unsupported until the repository migration
command creates the new schema. No schema or answer is reconstructed from
provider events. Kill, timeout, and process loss never discard an admitted Tell
or fabricate an answer.

## Ownership By Layer

**Owner (`src/akuma/akuma-product.ts` and the internal Akuma owner):** owns the
public object, Tell Promise lifetime, selector validation, and the exact
TellId-to-terminal-outcome wait. It translates durable facts into the typed
public errors and values. It never reads latest status to answer a Tell.

**Facade/composition (`src/library/`, CLI invocation):** resolves WorldRoot and
selectors, chooses local versus Body Request execution, forwards the same
provider-neutral schema JSON, and renders CLI receipts/results. It does not
create a second answer authority, expose owner/Body/Turn concepts, or redefine
schema routing.

**Heart (`src/akuma/heart/`):** atomically admits Tells, persists schemas,
binds each schema Tell once to its birth Turn, records raw and decoded terminal
outcomes, and projects the existing timeline. It owns migrations and crash
recovery.

**Body/execution (`src/akuma/body.ts` and execution modules):** performs the
existing plain Tell wake/steer behavior, explicit interrupt settlement, and
successor launch. At Turn start it passes the frozen schema to the provider and
records every Tell binding before provider work. Its owned cleanup pass writes
failed outcomes for open bound Turns before releasing custody.

**Provider (`src/akuma/provider.ts` and adapters):** accepts only a
provider-neutral JSON Schema and returns provider-neutral raw answer text plus
native session/fork evidence. It never sees a public Schema decoder, TellId,
AkuId, or product error. Codex maps the JSON Schema to `turn/start`'s
turn-scoped `outputSchema`; Claude and Pi use their native structured-output
hooks when available and otherwise request JSON text under the same neutral
contract. Native refusal or malformed output is provider evidence, not a new
lifecycle state.

## CLI Composition

No command is added. Existing commands are projections of the library:

```text
call <archetype> <prompt> [--schema file] [--wait duration|--detach]
  = Akuma.birth(...) + aku.tell(prompt, schema?)

tell <aku|alias> <prompt> [--schema file] [--interrupt]
  = Akuma.select(...) + aku.tell(prompt, options?)

wait <selectors> [--any|--all] [--timeout duration]
  = idle() for each selected Akuma; CLI may then render history --last

history <aku|alias> [existing history selectors]
  = aku.history(...)

kill <selectors> = kill() for each selected Akuma
```

`call --wait` races the Tell Promise against its existing observation timer. A
completed schema Tell prints the decoded JSON; timeout prints the current
snapshot and leaves the Akuma alive. Detached call/tell print the existing
admission/wake evidence and attach no answer handle. CLI schema files contain
JSON Schema; the CLI decoder is identity after JSON parsing, so output is JSON.

## Refusals And Recovery

- schema Tell against an active Body without `interrupt` is a typed busy refusal;
  no Tell is persisted;
- `interrupt: true` uses only the existing settle-and-successor protocol; hung,
  untidy, unavailable, or changed custody rejects honestly;
- timeout is an observation result and never kills or changes the eventual Turn;
- kill settles the exact Body, preserves Soul/Heart/history/pending Tells, and
  resolves `void` only after the existing kill evidence is durable;
- unborn, stillborn, corrupt, unsupported, and out-of-world selectors reject
  with existing typed errors;
- replay after a crash is idempotent on TellId and Turn binding; no duplicate
  answer is exposed.

## Package And Compatibility Cut

`package.json` keeps the `./akuma` export. Its barrel changes to export only
`Akuma`, `AkuId`, `Schema`, `JsonSchema`, `ActivityHistory` and row types,
`AllowedAction(s)`, `WorldRoot`, and typed public error classes. Existing
internal projections, receipts, Turn ledgers, and handles move behind internal
imports used by CLI and composition. The package-root facade remains available
for Contract APIs but does not re-export Akuma implementation objects.

The old public `Akuma.of`, instance `call`, `beginCall`, `interrupt`, `status`,
`fork`, `lastAnswer`, and Tell receipt unions are removed in the same major
clean-v4 cut. CLI behavior and existing history text remain compatible except
for the new `--schema` input and structured result rendering.

## Verification Plan

Add focused tests for schema construction and limits, static Tell overloads,
busy refusal versus explicit interrupt, exact Tell-to-Turn association under
concurrent and replayed delivery, provider-neutral schema mapping for Codex,
Claude, and Pi, invalid-output persistence, timeout/kill preservation, Body
Request forwarding, and CLI call/tell/wait/history rendering. Finish with:

```bash
npm test
npm run test:typecheck
npm run build
```

After Faye review, promote the settled law to `docs/akuma.md`,
`docs/akuma-public.md`, `docs/akuma-execution.md`, `docs/akuma-heart.md`,
`docs/akuma-provider.md`, `docs/public-akuma.md`, `docs/akuma-requests.md`,
`docs/cli.md`, and `docs/cli-output.md`, then bind one complete refactor
Contract over the implementation and those owner updates.
