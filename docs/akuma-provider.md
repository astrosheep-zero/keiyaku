# Akuma Provider Boundary

This chapter owns the provider-neutral protocol and native adapter obligations.
The shared recipe codec owns the provider-neutral execution envelope. Its
`config` member is an opaque provider escape hatch: the codec only requires an
object and preserves it unchanged (apart from its immutable snapshot). The
selected adapter is the sole owner of its fate. Codex, Claude, and OpenCode
route opaque objects to their native options/config boundaries, with
Keiyaku-owned fields applied afterward. Pi's native boundary is the closed
`CreateAgentSessionOptions` interface, which has no generic config field; Pi
therefore refuses an opaque config only immediately before native session
creation, where that concrete shape cannot be consumed. ACP and Grok own their
launch/argv dialects and decode or map their config as adapter-owned metadata.
The provider map never parses, filters, or rejects a config on an adapter's behalf.
Recipe inspection remains adapter- and SDK-free; selected adapter construction
is asynchronous, and that adapter loads its native SDK only when it starts or
resumes a native session.

## Structured answer capability

Structured-answer schema is a Turn-start capability, not a live-tell mutation.
Claude Agent SDK accepts `outputFormat` when a query starts, and Codex
app-server accepts `outputSchema` on `turn/start`; neither exposes a schema
setter on live steering. OpenCode's v2 prompt surface accepts
`format.json_schema`, but its newer steer/queue input has no format field, and
the current Keiyaku OpenCode adapter uses an entry point that does not send
that option. A schema change therefore requires a successor Turn for all three.

Pi's native session API has no assistant final-answer schema, but Pi is
extensible: a Keiyaku Pi plugin may carry a schema-bearing prompt through its
own extension boundary and perform native or post-answer validation. Pi's lack
of a built-in SDK field is not a product-level impossibility.

Grok Build has two distinct surfaces. The xAI HTTP SDK supports
`response_format` with a JSON schema. The Grok Build ACP source also contains
an optional per-prompt `outputSchema`, while `x.ai/interject` remains text-only
and cannot replace an active Turn's schema. The installed Grok Build CLI and
the current Keiyaku `grok-build` adapter have not established that ACP field as
a stable local contract and do not currently send it. Until capability is
verified at the selected executable, Grok structured answers remain
Keiyaku-owned post-validation; any future schema-bearing prompt must be a new
Turn, never an interjection.

## Turn Correlation

Provider fences and tell receipts are correlated to the admitted Turn, not to
the enclosing Body and not to wall-clock order. Launch and live tell attempts
remain typed attempts for the same Tell admission. A terminal provider result
closes its Turn once. An adapter may freeze native terminal evidence earlier,
but it ends the Session event stream before exposing `completion`; Body drains
that one narration boundary before reading the result. Completion and events
are not competing terminal judges, and later narration cannot create another
outcome.
The turn owner is the sole completion settlement point: a rejected
`Session.completion` is observed there and folded into the existing typed
provider failure result, even when the event iterator remains open; request
admission stops as soon as that rejection is observed. Adapters do not add
duplicate completion continuations or a second failure surface.

## Provider boundary

The adapter contract has one option-admission result, one synchronous attempt
owner, and one Session boundary. Start, resume, and fork return their attempt
before SDK loading, process or runtime creation, connection, subscription,
native-session creation, or prompt admission begins. The attempt exposes its
eventual result, graceful abort, forced disposal, and one mandatory `closed`
proof. `closed` settles only after every resource created by that attempt has
retired; cleanup failure rejects that proof. An admitted drive carries the body,
launch tells, cwd, options, and optional request directory. A Session exposes
typed events, completion, graceful abort, forced disposal, and optional live-
tell and receipt operations, but never a second disposal proof. Admission and
tell results carry only an opaque provider fence or `turn-ended`; the provider
never returns product identities through this boundary.

`ProviderFence` is an adapter-authored opaque submission coordinate unique to
one delivery group within one Turn. Its durable correlation key is the
Heart-owned `turnSequence` plus that fence. One Body may drive successive
Sessions; when a native coordinate has narrower scope, the adapter namespaces
it inside the opaque fence. Provider Core adds no execution or Session identity.
A fence is never matched across Body sequences or retries. Its codec is part of
the adapter boundary.
`ReceiptKind` is the provider-authored receipt word; Provider Core does not
close or reinterpret that vocabulary.

Fresh start, typed events, completion, abort, forced disposal, Body Request transport, option admission,
and `launchTells` are unconditional Provider Core. Resume, fork, and live tell
are capabilities expressed only by the corresponding optional operation. An
adapter without live tell still receives pending tells through `launchTells`
after Body custody is retired; an adapter without resume starts fresh only
when no durable resume promise exists. There is no capability registry,
declaration table, probe, independent `SteerControl`, or `ExecutionObserver`.

Every adapter implements the same attempt and Session custody contract. The
Body signal is cancellation notification only: it is never a custody key,
resource registry, identity, or cleanup proof. The attempt owns every setup and
live resource, including anything that arrives after cancellation. Its Session
controls delegate to that same attempt. Streams, receipts, Tell promises, and
iterators are subordinate to it, never separate custody duties. Provider-
specific cancellation is implementation detail and does not create lifecycle
law. Forced disposal fulfills only after proof that the same adapter-owned
child or native session has been forcibly disposed: an owned OS child is
forcibly terminated and its exit awaited, and an in-process session awaits its
native disposal completion. No PID, host, boot, registry, or other OS identity
crosses the Provider Core boundary. Fork attempt custody includes temporary
SDK, process, and session-creation resources, but does not claim to revoke a
durable remote child coordinate already created upstream.

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

Provider observation is a closed vocabulary: session coordinates, assistant and
thought narration, notes, typed tool start/completion pairs, and an `unknown`
arm. Tools preserve native names and available paths, search selectors,
file-change operations, diffstat, and result status; absent native facts stay
absent. The boundary owns the codec and Heart stores its encoded bytes opaquely.

The body encodes normalized events before handing opaque JSON to Heart; public
activity readers decode through the same owner before history or snapshot
folding. Heart never imports provider semantics.

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
line for non-tool plan, todo, retry, warning, or refusal narration. Codex
`hook/started` notes preserve the first nonblank native hook name supplied by
`name`, `hookName`, or `hook_name`, and use `Hook unknown started` only when
none is usable. Every other
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

Adapters preserve each provider's terminal and tell evidence without making
transport acknowledgements into product completion. Codex and Claude expose
different native tell checkpoints; OpenCode and Pi carry pending tells into the
next launch. A terminal result closes the Turn once, unmatched tool starts stay
unsettled, and no adapter fabricates completion or consumes a tell without its
native evidence.

File-change adapters preserve native operation, path, and available diffstat;
missing facts remain absent. Diffstat may come only from provider-native patch
evidence, never from workspace observation or prose. Unknown tools remain
`other`, and this boundary has no file ledger, usage arm, raw-provider
passthrough, or native output body.

An answered `TurnResult.historyId`, when present, is the provider-owned fork
point, not a generic result identifier. Completion does not require one and no
session or generated identifier may substitute for it. The Claude adapter uses
the outer assistant message UUID associated with the successful result; the
result UUID is not a valid substitute. Together with the session observed by
the body, it forms the answered turn's durable fork coordinate.

Provider option admission occurs before identity allocation. Akuma resolves the
one-way Archetype-or-call readonly selection before calling the selected
adapter's `admitOptions()` exactly once; the adapter alone judges readonly
realization. Native restraint has no diagnostic; `none`
names the enforcement gap, and missing enforcement remains admitted. Sessions
persist execution name and exact options, from which tell, resume, recovery,
and fork reconstruct adapters. Fork inherits execution and restraint.
Generic provider execution, option, and restraint decoders validate the
provider-neutral envelope and ignore additional envelope members. `config` is
not a provider-neutral grammar: it remains opaque until the selected adapter
owns its fate.

When `systemPrompt` is present, `systemPromptMode` selects append or replace.
Each adapter maps the effective mode to its native prompt input; unsupported
replacement is a typed refusal. Historical options without a mode retain their
old interpretation, and persisted options are never rewritten. Generic ACP
owns only configured portable mappings; dialect literals stay in their kind.
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

This exposure is provider transport setup, not a Library routing decision. The
provider child captures it once at its CLI composition root; the parent service
uses an explicit local composition and never inherits a recursive forwarding
choice.

## ACP

`acp` is the standard protocol kind, not a product family. Its execution config
owns launch argv and portable option mappings. Missing mappings remain typed
admission refusals. It has no portable readonly enforcement, live tell, or
fork, and it never gains behavior from the execution name.

The shared ACP core owns stdio custody, initialize, session new/load/prompt,
event mapping, cancellation, and cleanup. Standard `acp` adds no wire methods.
The core exposes no client-side filesystem, terminal, permission, or elicitation
capability, and contains no product extension vocabulary. It may accept opaque
fresh-session and load-session metadata from its caller and copy that object to
the standard request `_meta`. Empty metadata is omitted. The core never names,
parses, or owns `rules`, `systemPromptOverride`, or any other Grok literal.

One ACP prompt response is the terminal authority. The exact session id is the
resume coordinate. Message identity separates assistant messages; unidentified
v1 chunks remain one message. The final message is the complete answer while all
messages remain activity. Completion follows process cleanup, and cleanup
failure is a failed Turn.

`grok-build` is a distinct ACP dialect kind. It owns the trusted noninteractive
launch, every `x.ai` literal, and the `rules` / `systemPromptOverride` session
metadata constructed from an admitted prompt mode; generic ACP and the shared
core do not. A live Grok session maps provider-neutral tell to exactly one
`x.ai/interject` using the session id, unchanged text, and TellId as
`interjectionId`.

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
