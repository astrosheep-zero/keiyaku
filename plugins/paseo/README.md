# Akuma runtime mirrors

Two plugins form one bridge:

- Install `plugin/` as a Paseo directory-source plugin (`keiyaku-paseo`).
- Enable the bundled Keiyaku forwarder in the World's Settings:

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

A born signal carries that frozen caller to Paseo. The bridge enumerates public
agent snapshots with the supported `includeArchived` filter, never an active-only
scope, matching only
`persistence.provider` plus `persistence.sessionId` (never Pi's file-path handle).
It refreshes the sole candidate and attaches only if its identity is unchanged
and it is not archived. Missing, multiple, archived, or stale mappings diagnose
non-attachment without affecting Keiyaku creation. Stored `paseo` callers retain
the direct Paseo-ID lookup for compatibility.

Child creation reuses daemon idempotency for the Akuma's canonical World and
identity, not an identity registry or duplicate worker. Its creation title is the
bare full AkuId, so an alias move never changes the creation fingerprint.
Completed creation replay does not reattach a detached child or revive an
archived child. Unknown, unsupported, and nested-Akuma callers create no automatic
mirror. Attachment is best effort, with no polling, backfill, or retry
queue; a missed birth can remain unattached. After
successful SDK creation, attachment synchronizes matching open mirror sessions
once: it reads fresh history, publishes normal changes, and reannounces only a
still-open Turn. This compensates for Paseo registering its manager subscription
after the opening events. It never replays timeline items or submits execution.
A failed read retains its notice without reannouncing cached running state or
undoing creation. Repeated attachment may reannounce the same Turn; it does not
start another worker. Automatic resume or reload without attachment is outside
this mitigation, and later host races remain possible. Lookup
and creation are not an atomic transaction. Manual creation remains available.

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

The provider observes through the public SDK's one pull-backed stream in a
dedicated identity-clean worker: every frame is a complete latest bounded
window carrying the producer's own coverage metadata, and the next frame is
pulled only after the previous one settles, so slow consumption bounds what the
mirror holds instead of growing a queue. An incomplete bounded window is
distinct from history the producer reports outside retention; projected
sequence holes are not retention evidence; neither notice nor read failure
cancels a Turn. The same worker can still page public history in overlapping
200-row pages for a caller that asks for one; the mirror's own publication comes
only from its stream.
Tell and Stop use the same public SDK, not CLI arguments or stdout receipts.
The worker locates the installed package through `keiyaku` on PATH and loads
its declared public entry once. Inherited harness, Square and Keiyaku caller
identities are stripped, not replaced; the host environment is never mutated.
The same World and Akuma identity reopen on refresh/resume.

Opening also reads public status and publishes the admitted model through
Paseo's session configuration, with its provider in the model label. This is
read-only display, not model switching. An unspecified model stays unknown;
a failed status read reports a notice without blocking history. The global
catalog remains the mirror attachment entry, not a catalogue of native models.

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

Only nonblank plain text is supported. Commands, attachments, output schemas and
permission changes are refused before submission. The returned Tell identity
replaces the optimistic message through `clientMessageId`, retaining one stable
history item even when refresh races with submission. Correlation is in memory
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
serving the worker protocol (frames, Tell, Stop, status and paging), the real
built public package for history, Tell and Stop, the installed Paseo compiler
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
