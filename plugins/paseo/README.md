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
agent snapshots, including background and archived records, matching only
`persistence.provider` plus `persistence.sessionId` (never Pi's file-path handle).
It refreshes the sole candidate and attaches only if its identity is unchanged
and it is not archived. Missing, multiple, archived, or stale mappings diagnose
non-attachment without affecting Keiyaku creation. Stored `paseo` callers retain
the direct Paseo-ID lookup for compatibility.

Child creation reuses daemon idempotency for the Akuma's canonical World and
identity, not an identity registry or duplicate worker. Completed replay does not
reattach a detached child or revive an archived child. Unknown, unsupported, and
nested-Akuma callers create no automatic mirror. Attachment is best effort, with
no polling, backfill, or retry queue; a missed birth can remain unattached. Lookup
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

The provider reads `keiyaku -C <world> history <akuId> --json --limit 200` and
submits plain text through `keiyaku -C <world> tell <akuId> --json -`, with the
text on stdin. Both use the existing identity-cleaned environment: inherited
harness, Square and Keiyaku caller identities are stripped, not replaced. The
same World and Akuma identity reopen on refresh/resume.

Messages submitted in the app's Steer mode use one ordinary Tell and never
request an interrupt. Confirmed durable Tell admission is a successful send,
including when immediate delivery is absent or wake fails. Live delivery and
model consumption are best effort. For an active Steer request, the acknowledgement
uses the observed Paseo Turn captured before submission as presentation
correlation, not a new Keiyaku delivery or Turn-binding fact. Publication of racing
history waits until admission is correlated to the optimistic message.

For an idle send, the provider refreshes history once while publication is held.
A receipt or refreshed history that names a real running Turn can associate the
host request with that Turn. Otherwise Paseo may start and complete its own
`command-<clientMessageId>` send-command lifecycle. This only completes the send
command: it does not mean the Akuma answered, completed, or stopped. Later Akuma
starts and outcomes still come from Keiyaku history. A wake failure retains its
diagnostic without turning the recorded message into failure or adding a pending
message UI. Initial retention notices are unchanged.

Only nonblank plain text is supported. Commands, attachments, output schemas and
permission changes are refused before submission. The returned Tell identity
replaces the optimistic message through `clientMessageId`, retaining one stable
history item even when refresh races with submission. Correlation is in memory
only; reopening reads history and never resends. Missing or invalid admission
receipts, cancellation and timeout preserve an uncertain-outcome diagnostic and
reject that prompt operation to prevent host fallback and automatic resubmission.
Each owned CLI process is bounded to 30 seconds; closing observation aborts and
awaits it without killing the Akuma. Provider-side archive is unsupported.

The app defaults to Steer. User-selected Interrupt is explicit replacement and
is outside ordinary message semantics. Service callers that omit the send mode
may default to Interrupt. A Turn transition before the plugin receives the prompt
can still make Paseo reject the presentation correlation after the Tell was
recorded; the tested transition reports the host error without killing or
resubmitting. This integration makes no absolute race-free UI promise. Until the
independently delivered Stop change is integrated, interrupt only cancels
observation; it does not stop Akuma execution.

Opening reads once. Turn-start, turn-outcome and Body-end signals send refresh
hints over one lazy authenticated local Paseo client. Body-end releases that
client. Only TCP daemon listeners are supported. A failed hop is a single host
plugin diagnostic, not a Keiyaku failure or a retry queue.

No polling repairs lost hints. A mirror remains stale until another hint or
Paseo refresh. Retention gaps and read failures appear as timeline notices;
read failure retains the previous mirror.

Focused tests use mocked reads/transports and a fake public CLI executable, not a
live daemon/UI. Isolated native-host evidence and its limits are retained in
`plans/paseo-native-subagent-evidence.md`; Claude 2.1.299's native Bash export was
verified without a model or exporter hook. Tests do not restart the user's Paseo.
Live experiments, if
explicitly requested, must use a temporary `PASEO_HOME` and an unused TCP port.
