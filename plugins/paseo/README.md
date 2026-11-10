# Akuma runtime mirrors

Two plugins form one bridge:

- Install `plugin/` as a Paseo directory-source plugin (`keiyaku-paseo`).
- Separately install the Keiyaku forwarder from the World root, then enable it
  in that World's Settings. The core package does not install this observer:

```sh
npm install @astrosheep/keiyaku-plugin-paseo
```

Package names resolve from the World, not from the Keiyaku installation. A
user-level setting selects the observer but does not install it into each World;
each selected World must be able to resolve the package through ordinary Node
package resolution. Existing bundled installations must install the forwarder
separately before upgrading the core. No ledger or permission migration is
needed. A missing selected package reports an activation diagnostic without
blocking the Keiyaku operation.

Enable it with:

```json
{ "plugins": { "paseo": { "package": "@astrosheep/keiyaku-plugin-paseo" } } }
```

A present `plugins` namespace is the explicit plugin set. Include a Square entry
as well if that observer should remain enabled.

Ordinary CLI calls capture the host's native identity: Codex `CODEX_THREAD_ID`,
Pi `PI_SESSION_ID`, or Claude `CLAUDE_CODE_SESSION_ID`. The existing external
caller records the provider and session ID; no Paseo session-open env injection
is installed. A complete Akuma parent declaration wins. Multiple nonempty native
host IDs refuse as ambiguous instead of guessing. With no native ID, the existing
`KEIYAKU_EXTERNAL_CALLER` fallback remains supported.

A born Akuma caller is matched only against Paseo's complete public agent
directory, including archived and background entries. The bridge compares the
persisted Keiyaku provider identity and canonical
caller World/AkuId, then refreshes the sole match and checks identity and
unarchived state again before creating the child beneath it. Archived, missing,
ambiguous, changed, or unreadable parent evidence logs non-attachment and does
not affect birth. Canonical path aliases still match; titles, cwd, ancestry,
native provider sessions, and aliases never identify a parent. External and
legacy Paseo callers keep their existing selection behavior.

A born signal carries that frozen caller to Paseo. The bridge enumerates public
agent snapshots with the supported `includeArchived` filter, never an active-only
scope, matching only
the native provider in `persistence.metadata.provider` (falling back to
`persistence.provider` when absent) plus `persistence.sessionId`, never Pi's
file-path handle. This preserves native identity for custom providers such as
`wwz` extending `claude`, without treating a provider alias alone as evidence.
It refreshes the sole candidate and attaches only if its identity is unchanged
and it is not archived. Missing, multiple, archived, or stale mappings diagnose
non-attachment without affecting Keiyaku creation. Stored `paseo` callers retain
the direct Paseo-ID lookup for compatibility.

Child creation reuses daemon idempotency for the Akuma's canonical World and
identity, not an identity registry or duplicate worker. Its creation title stays
the bare full AkuId so alias moves never change the creation fingerprint. After
successful attachment and after each successful Turn-start, Turn-outcome and
Body-end runtime refresh, the forwarder makes one awaited, bounded title attempt
for that Akuma on a separately owned local client. It renames matching mirrors to
`@reviewer (aku/elite/1234abcd)` or, with multiple aliases,
`@audit, @reviewer (aku/elite/1234abcd)`. All aliases retain their markers and
canonical order. With no aliases the title is the bare full ID. A failed title
attempt logs a warning and closes its own client, without preventing the ordinary
runtime refresh, failing a successful attachment, or closing the cached runtime
client. Body-end still releases the runtime client. No title work is queued or
detached.

Aliases come from `Akumas.of(world).aliases({ akumaIds })`, with one mapping
snapshot for the selected exact-World mirror identities after complete directory
enumeration. Neither a full Kanshi observation, a bounded roster, nor decoded
storage resolves names. Alias read failure retains prior titles rather than
treating unavailable bindings as empty.

Mirror matching uses the public Paseo snapshot's Keiyaku provider persistence
metadata and its canonical World plus AkuId, never the title or an opaque session
ID. Titles are bridge-owned presentation, including previously customized titles.
A rename neither creates a child nor reattaches, resumes, or unarchives it.
Directory enumeration completes before renames, so title changes cannot reorder
the bridge's own in-flight pagination. Existing mirrors, including archived
entries, can be backfilled without replaying birth or creation. The Paseo
directory supports both `includeArchived` and `includeBackground`; title backfill
intentionally includes archived entries but keeps its existing background scope.

An explicit one-shot title sync can also update existing mirrors:

```sh
cd /Users/astrosheep/Developer/keiyaku-v4
node plugins/paseo/forwarder/backfill-titles.mjs /Users/astrosheep/Developer/keiyaku-v4
```

The script uses the existing local connection setup: `PASEO_HOME` (or Paseo's
local default), daemon readiness, and the stored local credential. It prints only
the rename count or an error, never the credential. No daemon restart, plugin
reload, or agent creation is performed. It owns and closes its connection and
bounds the operation to 30 seconds. Append one full AkuId to limit the backfill:

```sh
node plugins/paseo/forwarder/backfill-titles.mjs /Users/astrosheep/Developer/keiyaku-v4 aku/elite/abcd
```

The operation only lists and renames existing matching agents; it is safe to
repeat and skips already-correct titles. Partial rename failure may leave some
titles updated; rerunning converges without duplicate creation. An alias move
alone emits no title update. Each old or new alias target converges on its next
ordinary runtime refresh, successful attachment, or explicit title sync. Inactive
mirrors can use the explicit backfill; there is no immediate alias-move signal,
watcher, or background retry. The provider's timeline refresh alone does not
update titles.

Completed creation replay does not reattach a detached child or revive an
archived child. Unknown and unsupported callers create no automatic mirror. A
missed birth can remain unattached; there is no creation backfill, polling, or
retry queue. Registration recovery belongs to the provider-session lifecycle,
not attachment.

Before a `keiyaku` provider session opens, the plugin establishes and awaits a
Paseo-owned agent-directory subscription. It includes archived and background
entries, but ignores its initial snapshot and any updates until that exact host
agent's provider observation is ready. After the manager registers the agent and
publishes its idle state, a fresh Keiyaku observation updates normal history and
reannounces only a Turn that is still open. This covers create, resume, refresh,
and import; it does not wait for future registration in the hook, replay cached
running state after an unreadable read, duplicate timeline history, or submit
execution. The one-shot subscription is released after handoff and on close,
archive, plugin unload, failed setup, timeout, or a later open replacing it.
The provider advertises `session.can_stop_runtime` and answers false for every
open mirror, including idle sessions; an absent local provider session may answer
true. Host close and archive release observation only and never kill the Akuma.

When a refresh signal has no matching local session, the plugin completes a
public directory traversal including archived and background agents, then
matches only the versioned provider persistence data's canonical World and
AkuId. It does not infer identity from title or opaque session ID. Each candidate
is refreshed and rechecked for the same provider identity and non-archived state
before `timeline.refetch({ limit: 0 })` asks Paseo to load the existing agent for
read-only history. The response's error and fresh agent identity are checked as
well. No agent is created, unarchived, sent input, interrupted, or resumed via an
execution operation. Concurrent recovery of one exact agent is coalesced, and
`woken` counts only matching open or successfully recovered mirrors. Paseo does
not make archive checking and this history read transactional: a concurrent
archive can race between the final pre-read check and the host read. Paseo's
history load preserves archive state and performs no execution, but the bridge
cannot promise that the host will not briefly load an archived record in that
race. Incomplete pagination or a missing, archived, or changed mapping is not
reopened.

Create a Paseo agent with `config.provider: "keiyaku/mirror"`, a working directory,
and `config.options` (translated by the client to opaque `providerOptions`, not
model settings):

```json
{
  "cwd": "/absolute/path/to/workdir",
  "config": {
    "provider": "keiyaku/mirror",
    "options": { "world": "/absolute/path/to/world", "akuId": "aku/archetype/id" }
  }
}
```

The Paseo plugin requires host version `>=0.14.0`, which supplies provider
runtime-safety negotiation and the owned public directory subscription used for
registration handoff and background mirror discovery. The provider observes
through the public SDK's one pull-backed stream in a
dedicated identity-clean worker: every frame is a complete latest bounded
window carrying the producer's own coverage metadata, and the next frame is
pulled only after the previous one settles, so slow consumption bounds what the
mirror holds instead of growing a queue. An incomplete bounded window is
distinct from history the producer reports outside retention; projected
sequence holes are not retention evidence; neither notice nor read failure
cancels a Turn. The mirror's own publication comes only from its stream.
Tell and Stop use the same public SDK, not CLI arguments or stdout receipts.
The worker locates the installed package through `keiyaku` on PATH and loads
its declared public entry once. Inherited harness, Square and Keiyaku caller
identities are stripped, not replaced; the host environment is never mutated.
The same World and Akuma identity reopen on refresh/resume.

At native agent creation, the plugin reads the exact Akuma status from
`providerOptions`, keeps the native provider as `keiyaku`, and persists a known
model as `config.model`. It removes the `mirror` placeholder when status is
unknown or unavailable and leaves that diagnostic-only condition without
blocking creation. The provider catalog stays `{ "models": [], "modes": [] }`;
this create-time correction is for new or recreated mirrors. Existing persisted
`mirror` sessions are outside the guarantee. The opened session still publishes
its current status through session configuration for runtime observation, with
no live model-change refresh.

Progress reports appear as informational notifications with stable report
identity; they do not start or finish a Turn or constitute its answer.
Unknown or malformed records with trustworthy identity produce a bounded
incomplete-observation warning, without displaying their payload or blocking
later records. Invalid window or record identity still fails the observation.

Tool records map to native `tool_call` items with actual call, result, exit
status, duration and truncation. Where the installed producer reports a tool
result's own `output`, that text is what run, read and search display; the
diagnostic `message` is only the stand-in an older record wrote instead, so an
honestly empty output is never replaced by its diagnostic. A single-file
`fileChange` whose change carries an observed `patch` becomes a native edit
detail with that file path and its unified diff, a trailing truncation marker
included. Multiple files, and a single change without an observed patch, keep
the fallback detail with the complete change list and the result, so one file
never stands in for the whole operation. The mirror never reconstructs a patch
or write content from the filesystem, Git, or proposed inputs, and absent
producer evidence stays absent. Tool identity is the public
producer's `toolId` scoped by its Turn, so starts and results update one native
item even for identical concurrent calls. An unwitnessed result ends only that
tool's presentation as canceled, with the original `unsettled` state retained;
it never cancels the Turn or invents a tool result. An installed producer that
reports no `toolId` shows an observation notice while the tool is active and a
settled record, without guessed pairing. Thoughts map to reasoning and notes to
notifications. No
pairing by names, arguments or timestamps is used. Intermediate speech maps to
native assistant messages. An answered outcome that exactly replaces the final
narration carries the producer-owned `foldedSaidSequence`; the mirror then reuses
that live speech identity, and Paseo suppresses the identical final upsert. The
adapter never repeats the producer's text comparison. An installed producer that
reports no such linkage publishes the outcome under its own identity instead of
guessing which speech it replaces, so that final text appears a second time.
A durable canceled outcome finishes its exact Turn as canceled without an error
item. External kill and interrupt have this same meaning as app Stop; replay or
reopen treats that outcome as already terminal rather than restarting it. Genuine
failed outcomes still finish failed and display their error.

Messages submitted in the app's Steer mode use one ordinary Tell and never
request an interrupt. Confirmed durable Tell admission is a successful send,
including when immediate delivery is absent or wake fails. Live delivery and
model consumption are best effort. For an active Steer request, the acknowledgement
uses the observed Paseo Turn captured before submission as presentation
correlation, not a new Keiyaku delivery or Turn-binding fact. Publication of racing
history waits until admission is correlated to the optimistic message.

For an idle send, the provider reopens its observation once while publication is
held. A receipt or freshly observed window that names a real running Turn can
associate the host request with that Turn. Otherwise Paseo may start and complete its own
`command-<clientMessageId>` send-command lifecycle. This only completes the send
command: it does not mean the Akuma answered, completed, or stopped. Later Akuma
starts and outcomes still come from observed Keiyaku windows. A wake failure retains its
diagnostic without turning the recorded message into failure or adding a pending
message UI. Initial retention notices are unchanged.

Only nonblank plain text is supported. Commands, attachments and output schemas
are refused before submission. A host-requested clear of stale permission
prompts is accepted and ignored: Paseo asks for it on ordinary steering, and
this mirror owns no permission requests, so there is nothing to clear. The
returned Tell identity replaces the optimistic message through
`clientMessageId`, retaining one stable history item even when refresh races
with submission. Correlation is in memory
only; reopening reads history and never resends. Missing or invalid admission
receipts, cancellation and timeout preserve an uncertain-outcome diagnostic and
reject that prompt operation to prevent host fallback and automatic resubmission.
Each ordinary SDK request is bounded to 30 seconds; an idle stream frame has no
bound. Cancellation stops waiting and drops
late responses without terminating other sessions' requests. Public reads that
lack cancellation may finish in the worker; closing a mirror does not kill the
Akuma. Plugin teardown retires the worker. Provider-side archive is unsupported.

The app defaults to Steer. User-selected Interrupt is explicit replacement and
is outside ordinary message semantics. Service callers that omit the send mode
may default to Interrupt. A Turn transition before the plugin receives the prompt
can still make Paseo reject the presentation correlation after the Tell was
recorded; the tested transition reports the host error without killing or
resubmitting. This integration makes no absolute race-free UI promise.

An explicit Stop calls the public SDK's kill operation through the same
bounded, identity-cleaned worker. Only a proven stopped receipt ends its captured
observed Turn as canceled; refusal or uncertainty retains its diagnostic. A natural
outcome, including one held during Tell correlation, keeps its own terminal event.
Overlapping Stops share one attempt, and each request receives its own response.
Stop preserves identity, history and session for later Tell. Refresh, close and
plugin unload remain observation-only and never initiate kill.

Opening observes once. Turn-start, turn-outcome and Body-end signals send refresh
hints over one lazy authenticated local Paseo client. Body-end releases that
client. Only TCP daemon listeners are supported. A failed hop is a single host
plugin diagnostic, not a Keiyaku failure or a retry queue.

A session owns one live observation for its whole life, idle included: the
public stream, pulled one frame at a time. The opening frame of a skipped
history seeds retained state instead of announcing it; every other frame
publishes through the same mirror semantics, including mid-turn records and a
Turn that starts after an idle stretch. There is no interval, no timer and no
idle expiration; an idle frame simply waits for the next change. Session or
plugin teardown releases the subscription, settles the frame in flight and
discards a late one, while ordinary history, Tell, Stop and status requests
proceed beside it. A signal, an explicit refresh, a Tell and a proven Stop all
reopen that one observation and await its current frame, so hints coalesce,
publication stays serial, and a late window can never overwrite a newer one. A
failed or ended observation keeps the previous display, reports the read surface
as unavailable, and is never retried on a timer: only the next explicit refresh
opens a fresh one. Which observation the bridge can open is the installed
package's own capability, exactly like the surface it already probes; a package
without the public stream reports the unavailable read surface rather than
inventing one. Retention gaps and read failures appear as timeline notices, and
a producer record without its own identity is reported as observation and never
paired by guesswork.

Focused tests use mocked transports and stream frames, a fake public SDK package
serving the worker protocol (frames, Tell, Stop and status), the real
built public package for its stream, Tell and Stop, the installed Paseo compiler
and evaluator running the real plugin bundle through production PATH discovery,
and installed native consumer tests. A package that declares `Akuma.stream` is
exercised through that stream end to end: the real open Turn, a mid-turn record
and a later Turn after an idle stretch, all with no timer in the session.
`KEIYAKU_PUBLIC_PACKAGE` points those same tests at another built package, which
is how a lane whose own build predates their prerequisite proves the streaming
path for real instead of reporting the surface it could not open. The embedded
worker type-checks against the installed declarations, including the streaming
shape whenever the package declares it. They do not update or use
the live daemon/UI. Isolated
native-host evidence and its limits are retained in
`plans/paseo-native-subagent-evidence.md`; Claude 2.1.299's native Bash export was
verified without a model or exporter hook. Tests do not restart the user's Paseo.
Live experiments, if
explicitly requested, must use a temporary `PASEO_HOME` and an unused TCP port.
