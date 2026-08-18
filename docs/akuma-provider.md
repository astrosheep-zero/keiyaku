# Akuma Provider Boundary

This chapter owns the provider-neutral protocol and native adapter obligations.
The shared recipe codec owns the provider-neutral execution envelope. The
provider map applies the selected kind's config grammar before any adapter is
constructed; Heart and callers do not repeat or bypass that judgment.

## Turn Correlation

Provider fences and tell receipts are correlated to the admitted Turn, not to
the enclosing Body and not to wall-clock order. Launch and live tell attempts
remain typed attempts for the same Tell admission. A terminal provider result
closes its Turn once. An adapter may freeze native terminal evidence earlier,
but it ends the Session event stream before exposing `completion`; Body drains
that one narration boundary before reading the result. Completion and events
are not competing terminal judges, and later narration cannot create another
outcome.

## Provider boundary

```ts
type ProviderAdapter = {
  admitOptions(options: ProviderOptions): ProviderOptionAdmission;
  start(input: FreshDrive): Promise<Session>;
  resume?(input: ResumeDrive): Promise<Session>;
  fork?(input: {
    session: ResumeCoordinate;
    at: string;
    cwd: string;
  }): Promise<{ session: ResumeCoordinate }>;
};

type ReadonlyRestraint = Readonly<
  | { enforcement: "native"; diagnostic?: never }
  | { enforcement: "none"; diagnostic: string }
>;

type ProviderOptionAdmission =
  | { kind: "admitted"; options: ProviderOptions; readonly?: ReadonlyRestraint }
  | { kind: "refused"; diagnostic: string };
type DriveInput = {
  body: string;
  launchTells: readonly { id: TellId; text: string }[];
  cwd: string;
  options: ProviderOptions;
  requests?: { dir: string };
};

type FreshDrive = DriveInput & { session: { kind: "fresh" } };
type ResumeDrive = DriveInput & {
  session: { kind: "resume"; coordinate: ResumeCoordinate };
};

type Session = {
  admission: SessionAdmission;
  events: AsyncIterable<AgentEvent>;
  receipts?: AsyncIterable<TellReceipt>;
  completion: Promise<TurnResult>;
  abort: () => Promise<void>;
  tell?: (tell: { id: TellId; text: string }) => Promise<TellSubmission>;
};

type TellSubmission =
  | { kind: "accepted"; fence: ProviderFence }
  | { kind: "turn-ended" };
type SessionAdmission = { fence: ProviderFence };
type TellReceipt =
  | { evidence: "exact"; tellId: TellId; kind: ReceiptKind }
  | { evidence: "fence"; fence: ProviderFence; kind: ReceiptKind };
```

`ProviderFence` is an adapter-authored opaque submission coordinate unique to
one delivery group within one Turn. Its durable correlation key is the
Heart-owned `turnSequence` plus that fence. One Body may drive successive
Sessions; when a native coordinate has narrower scope, the adapter namespaces
it inside the opaque fence. Provider Core adds no execution or Session identity.
A fence is never matched across Body sequences or retries. Its codec is part of
the adapter boundary.
`ReceiptKind` is the provider-authored receipt word; Provider Core does not
close or reinterpret that vocabulary.

Fresh start, typed events, completion, abort, Body Request transport, option admission,
and `launchTells` are unconditional Provider Core. Resume, fork, and live tell
are capabilities expressed only by the corresponding optional operation. An
adapter without live tell still receives pending tells through `launchTells`
after Body custody is retired; an adapter without resume starts fresh only
when no durable resume promise exists. There is no capability registry,
declaration table, probe, independent `SteerControl`, or `ExecutionObserver`.

Every adapter implements the same setup and Session custody contract. Setup
accepts the Body signal and disposes any native session or OS child that arrives
after cancellation. Session `abort()` fulfills only after every child and
native session the adapter created or may still create is disposed; a late
resource is never delivered. Streams, receipts, Tell promises, and iterators
are not separate custody duties. Provider-specific cancellation is an
implementation detail and does not create provider-specific lifecycle law.

`Session` owns only one live native execution. A live `tell` returns `accepted`
with a provider submission fence, or `turn-ended` when the adapter has already
observed terminal native evidence and submitted nothing. The adapter is the sole
judge of that native boundary; transport and native failures still reject the
operation. When `receipts` exists, an accepted acknowledgement
proves submission only and terminal evidence must arrive through the receipt
stream. When `receipts` is absent, exposing live `tell` promises that its
acknowledgement is the adapter's strongest terminal native evidence for the
text; a harness whose acknowledgement proves only queueing or submission must
omit live `tell` and carry the text through the next launch instead. Start or
resume returns only after its launch input is admitted;
`SessionAdmission` supplies only the provider fence and never echoes TellIds or
other product data. Body pairs that fence with the `launchTells` it constructed
and records the launch delivery.

`events` and `receipts` are separate pull streams with separate vocabularies and
readers. Events remain closed execution narration. The optional receipt stream
is the capability to produce terminal native tell evidence; nonterminal native
observations do not enter Provider Core. Body is its sole reader and the sole
writer of the corresponding Heart facts. An exact receipt names one TellId. For
a fence receipt, Body resolves the fence only through delivery facts it already
wrote; an unresolvable fence produces no fact. `kind` preserves the provider's
strongest evidence without becoming a product state. Missing receipts remain
missing; the adapter and Body never synthesize them. Provider fences do not
cross the public Akuma boundary.

Receipt visibility is causally ordered at the adapter boundary. A launch
receipt is not yielded until `start` or `resume` has returned its admission; a
live receipt is not yielded until the matching `tell()` has resolved its
acknowledgement. Body records the corresponding delivery transaction before it
starts consuming launch receipts or resumes consuming live receipts. Thus a
valid receipt cannot outrun its durable Body-scoped delivery mapping; an
unresolvable fence is corruption or unrelated evidence, not an ordering race.

The presence of `receipts` is the Session's terminal-receipt capability. When
absent, the live-tell contract above makes a successful acknowledgement terminal
for that tell. When present, each yielded receipt is terminal evidence; a live
acknowledgement alone remains replayable after that Body ends.
Launch admission is terminal evidence for its immutable `launchTells` batch.
Body copies that one distinction into the live delivery fact; no capability
table or provider-name branch exists in Heart.

Provider observation is the closed public vocabulary:

```ts
type AgentEvent =
  | { type: "session"; coordinate: ResumeCoordinate }
  | { type: "assistant"; text: string }
  | { type: "thought"; text: string }
  | {
      type: "tool";
      id: string;
      phase: "started" | "completed";
      name: string;
      call: ToolCall;
      result?: ToolResult;
    }
  | { type: "note"; text: string }
  | { type: "unknown"; kind: string };

type ToolCall =
  | { kind: "run"; command: string }
  | { kind: "read"; path: string; offset?: number; limit?: number }
  | { kind: "search"; query: string; scope?: "content" | "files" | "web"; path?: string; glob?: string }
  | {
      kind: "fileChange";
      changes: readonly {
        op: "add" | "update" | "delete" | "unspecified";
        path: string;
        diffstat?: { added: number; removed: number };
      }[];
    }
  | { kind: "other"; display: string };

type ToolResult = {
  status: "ok" | "error";
  message?: string;
  exitCode?: number;
};
```

The provider boundary owns this vocabulary and its strict encode/decode pair. The body
encodes normalized events before handing opaque JSON to Heart; public activity
readers decode through the same owner before history or snapshot folding. Exhaustive
event-type switches make a union change fail typecheck until the codec changes
with it. Heart remains the opaque persistence owner and does not import provider
semantics.

Each native adapter separates process/session control from pure native-event
translation. The Body consumes the typed translation result and does not
reinterpret native event payloads.

`session` is authored when the native harness grants a resumable coordinate.
The pump records that coordinate immediately as
the heart's authoritative session fact and also appends the event as activity;
it never waits for turn completion. `assistant` contains a bounded completed
agent narration of at most 16,384 characters, never deltas or summaries. The
complete answer is stored separately in `TurnFact` and is never truncated.
`tool` preserves the provider's stable tool id, one started/completed lifecycle
per use, one provider-neutral call shape, and the typed result disposition.
A read may carry a positive 1-based `offset` and/or `limit`; a search may carry
`scope` (`content`, `files`, or `web`) plus optional `path` and `glob` when the
native provider supplies them. Absent or invalid optional facts stay omitted.
Provider options, opaque results, domains, fuzzy-file-search notifications, and
unknown fields stay outside `ToolCall`. A nonterminal native update after the
start may refine adapter-local observation but never creates another typed
event; independent ids remain concurrent, and reuse follows completion. A
started event carries no result; a completed event requires one. Result
`message` is a bounded diagnostic, never stdout, stderr, or a native result body.
`thought` is one completed reasoning summary or block bounded at 4,000
characters, never raw thinking text or a delta stream. `note` is one bounded
line for non-tool plan, todo, retry, warning, or refusal narration. Every other
persisted activity text field, including tool names, calls, diagnostics, and
unknown native names, is bounded at 16,384 characters. The provider codec is
the sole persistence-bound judge; session coordinates and tool pairing ids are
never truncated. `unknown` contains only the unmapped native kind or method
name and never carries the native payload.

When that codec shortens any persisted narration, tool name, call, result, or
unknown-kind text, the typed event carries `truncated: true`; ordinary shorter
events omit the field. Adapters provide their complete translated value and do
not pre-truncate it, so the codec remains the only judge and the activity fold
can preserve exact truncation evidence for public rendering. Activity is
persistent execution narration. Deleting retained activity changes history and
recent snapshots, but never recovery, resume, fork, outcome, failure, or life.
Complete answer bytes and fork coordinates remain authoritative only in `TurnFact`;
a session row remains the sole resume authority.

Every adapter totally disposes native events: known kinds are mapped or
explicitly dropped, and unknown kinds become `unknown`. Tool lifecycle maps to
`tool`, completed reasoning summaries to `thought`, and plan, retry, warning,
or refusal narration to `note`. Deltas, input echoes, result bodies, raw
thinking, and usage telemetry are dropped. Closed native unions are exhaustive;
open method sets end in the unknown fallback.

Codex translates admitted notifications in native order. The first
`turn/completed` freezes the terminal result while already admitted narration
drains; a bounded one-second fallback ends an uncooperative producer without
rewriting that result. Terminal observation closes steer admission and rejects
unacknowledged steers. Only native `item/completed` produces a completed tool;
terminality never repairs an unmatched start.

The public projector inserts an unmatched start as `active` in its owning open
Turn. On that Turn's end it converts each remaining active row to `unsettled`
while constructing the typed closed Turn. This revokes current-running
qualification but does not fabricate a tool completion or terminate a process.
History flattens an open Turn's tool as `active` and a closed unmatched tool as
`unsettled`. Snapshot and history lifecycle are derived from the typed start,
completion, and Turn facts, never from renderer inference.

Claude's terminal answer is exactly `result.result`. Codex emits every completed
`agentMessage` as assistant activity, while its terminal answer is exactly the
last completed `agentMessage` text. A failed Codex turn preserves
the native explanation from an `error` notification or `turn.error`, using a
generic status diagnostic only when no native detail exists.

Codex exposes live tell through native `turn/steer`. The adapter submits one
text input with the TellId as `clientUserMessageId` to the admitted thread and
active turn, accepts only a response naming that same turn, and then returns an
opaque fence scoped to that native acknowledgement. Codex supplies no receipt
stream: successful `turn/steer` acceptance is its strongest terminal evidence.
Terminal turn observation returns `turn-ended` for new steers immediately, but the adapter keeps
only acknowledgements received before that terminal observation as native
acceptance evidence. An already-submitted steer still awaiting acknowledgement
is rejected when terminal observation closes request admission; terminal
settlement never waits indefinitely for it, and a later response cannot invent
acceptance across the closed boundary.

Claude uses one long-lived streaming-input Query. SDK demand for the next item
proves submission and yields only a submission fence. A later successful
`result` is the consumption checkpoint and yields exact `consumed` receipts for
previously acknowledged tells, after `tell()` resolves. Earlier results prove
nothing; accepted tells without a later checkpoint remain replayable. Terminal
Query returns `turn-ended`, and pre-acknowledgement failure rejects.

OpenCode V1 treats `promptAsync` as launch admission. Only the matching native
user message opens the Turn's terminal epoch; same-session idle or error closes
it, and a same-session error after submission may close a launch before that
identity appears. The final assistant message supplies answer and fork coordinate but cannot
create another completion decision. Events are isolated by session id. V1
claims no live tell; pending tells enter the next prompt. Archetype `effort`
maps to native `variant`.

Pi's `steer()` acknowledgement likewise proves queueing only. Pi omits live
tell and receives pending text in the next launch input.

File-change adapters preserve every available native operation, path, and
per-change diffstat. Missing optional facts make the public row shorter; an
adapter never invents a diffstat. Diffstat may be derived from a provider-native
unified patch, never from workspace observation or prose. Claude, Pi, and
OpenCode capture only known native names and those fields.
`unspecified` applies only when the provider reports a file edit and path but
no add, update, or delete subtype. It records that native absence; it is never
an inference failure or compatibility value.
A similarly named unknown tool stays `other`; a missing read path or search
query omits the fact. Codex web search keeps only query and drops fuzzy search.
Claude derives add/update from write/edit and omits missing diffstat. Pi edit
keeps update and may add patch-derived counts; Pi write stays `other` until a
native result establishes add or update. A multi-file public summary aggregates
only when every change has a diffstat. No
terminal file ledger, event bus, usage or cost arm, raw-provider passthrough,
or native output body belongs in this boundary.

An answered `TurnResult.historyId`, when present, is the provider-owned fork
point, not a generic result identifier. Completion does not require one and no
session or generated identifier may substitute for it. The Claude adapter uses
the outer assistant message UUID associated with the successful result; the
result UUID is not a valid substitute. Together with the session observed by
the body, it forms the answered turn's durable fork coordinate.

Provider option admission occurs before identity allocation; `admitOptions()`
alone judges readonly realization. Native restraint has no diagnostic; `none`
names the enforcement gap, and missing enforcement remains admitted. Sessions
persist execution name and exact options, from which tell, resume, recovery,
and fork reconstruct adapters. Fork inherits execution and restraint.
Generic provider execution, option, and restraint decoders validate known
members and ignore additional members.
`executable` constrains process start; literal `env` overlays only ambient
launch environment and is neither durable nor interpolated. Claude execution
with `env` refuses fork because native `forkSession` cannot accept it.

Claude fork uses the answered session and outer assistant-message UUID and
requires a distinct nonblank child session. Pi uses the exact answered
`sessionFile` and `historyId` and requires a distinct returned file. Missing
source points, native failure, or reused coordinates are `fork-failed`.

Every drive receives a body-owned request transport. Each adapter injects its
absolute path as `AKUMA_REQUESTS` into the provider command environment. A
Codex app-server `workspaceWrite` turn additionally grants the directory as a
writable root of its native sandbox; a `readOnly` turn does not. Claude passes
the directory as an SDK `additionalDirectories` permission root so a configured
Claude sandbox can reach it without replacing the caller's sandbox settings.
When Pi admits bash, it injects the path through that drive-local bash spawn
environment rather than mutating the Body process environment; readonly Pi
still excludes bash. Provider-specific transport wiring does not change the one
provider-neutral drive contract.

## ACP

`acp` is the standard protocol kind, not a product family. Its execution config
owns launch argv and portable option mappings. Missing mappings remain typed
admission refusals. It has no portable readonly enforcement, live tell, or
fork, and it never gains behavior from the execution name.

The shared ACP core owns stdio custody, initialize, session new/load/prompt,
event mapping, cancellation, and cleanup. Standard `acp` adds no wire methods.
The core exposes no client-side filesystem, terminal, permission, or elicitation
capability, and contains no product extension vocabulary.

One ACP prompt response is the terminal authority. The exact session id is the
resume coordinate. Message identity separates assistant messages; unidentified
v1 chunks remain one message. The final message is the complete answer while all
messages remain activity. Completion follows process cleanup, and cleanup
failure is a failed Turn.

`grok-build` is a distinct ACP dialect kind. It owns the trusted noninteractive
launch and every `x.ai` literal; generic ACP and the shared core do not. A live
Grok session maps provider-neutral tell to exactly one `x.ai/interject` using
the session id, unchanged text, and TellId as `interjectionId`.

Every Grok dialect payload branch requires either its serializer in pinned
reference source or a captured real provider transcript. Fixtures alone are
insufficient evidence. Unsupported payloads remain `other`, and Heart retains
their encoded event bytes opaquely.

Only a successful `queued` response acknowledges admission. It yields an
accepted submission with no receipt stream and makes no safe-point-consumption
or provider-deduplication claim. Request failure or terminal observation before
acknowledgement yields no acceptance, so the durable Tell remains available to
the Body's successor path. Grok has no fork.
No other `x.ai` method, passthrough, probe, capability registry, extension bag,
or registration schema exists. New dialect behavior must first satisfy an
existing provider-neutral capability or receive a separate product ruling.
