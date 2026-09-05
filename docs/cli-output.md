# CLI Output

CLI Output owns help composition, shared rendering, and process outcome
classification. It consumes typed public values only. It does not reread
authority, change an owner's judgment, or make a display convenience durable.

## Help and outcome

Root help is a compact index of product pillars and repository utilities.
Each command family supplies its own purpose and leaf help; leaf help is the
sole user-facing owner of literal invocation grammar. Help remains available
without a World, input stream, or product observation. A syntax or input-source
refusal retains its specific cause and exposes the smallest applicable usage
and help handles without trying the command or appending a complete help page.
Explicit help remains complete, including supported invocation coordinates.
Operation and recovery handles do not prescribe a working directory; any
workspace coordinate is a separate fact for the caller to use.

Text is the primary readable projection and JSON is the complete typed
projection of the same result. Rendering retains the meaningful distinctions
between success, substantive refusal, retryable conflict, absent authority,
and operational failure. Contract text labels tender and target integration as `tender commit` and `integration commit`, patch-id as `content identity (not commit)`, keeps ContractHead and journal blob custody out of ordinary text, and retains typed fields in JSON. A completed placement
reads like Git movement, identically for a review and a deliver that placed
the candidate: the title states the verdict or delivery and the Contract, one
movement row states the reference the placement advanced as `old..new  ref`,
satisfied Verification adds one fact row `verification satisfied · on <sha>`
naming the commit the verdict ran against — placement made that commit the
reference's new head, so the two rows share one sha — and the final lifecycle
state is one explicit `claimed` row. Receipt, status, and history render that
verified commit with one `verification satisfied · on <sha>` vocabulary;
status falls back to the bare verdict only when the recorded subject names no
snapshot. Verification mode words never appear in ordinary receipt text and
stay in JSON and `history`. A deliver that did not complete placement keeps
its tender and content-identity rows and its current diagnostic shape.

Ordinary fact rows state labeled human facts. No verb receipt states its own
recording with a `journal` row, and no ordinary receipt text carries a
26-character journal entry id; entry ids are evidence handles carried by JSON
and `history` alone. Fact rows never enumerate persisted record fields or
splice raw JSON into text, and an attestation subject renders only its
snapshot as a short sha while segment components stay in JSON. Dashed machine
keys render as words, as in `require branches up to date`.

## Shared rendering

Renderers show complete public identity and decision-relevant evidence without
inventing status, hiding section failure as zero, or turning unknown evidence
into a positive result. The text vocabulary is closed and eight marks wide:
`●` moving or present, `○` calmly waiting or absent, `⧖` time in flight —
running and in-flight activity, `⧗` time spent waiting — pending tells, on-hold
Tasks, and tendered or otherwise waiting Contracts, `✓` an affirmed verdict,
`×` a denied verdict, `!` attention, and `?` unknown; the word after a mark
carries the detail. The hourglass marks are temporal and the verdict marks are
affirmative or negative, so the earlier fold that reduced time and verdict to
presence and attention is reversed: waiting is not absence, and an unsatisfied
gate is not generic attention. `│` is the neutral continuation and ordinary-row
mark and carries no state; `NAME // qualifier` frames a catalogue section
rather than a banner. Facts are label-value rows joined
with ` · `; `key=value`, decorative rulers, banners, and bracket state
alphabets are not text vocabulary. Git identities render at 7 characters in
text and full length in JSON. Paths stay absolute and copyable where they are
the answer, and stay out of board and catalogue rows where they are not.
Absent facts are absent rows; zero counts and empty containers print nothing.
Multi-line payloads sit directly under their label, bounded, and name their
own truncation. Recording review testimony and completing placement
remain distinct facts; absence of completion does not establish a candidate. They may make a terminal-readable view denser, wrap
prose, and use non-semantic terminal emphasis, but cannot truncate a copyable
identity or replace a public discriminant with decoration.

When an owner reports a bounded catalogue with additional rows, text signals
that single public fact without adding counts, an exhaustive-mode claim, or a
continuation instruction. A complete catalogue has no omission tail.
The omission marker is therefore only a rendering of bounded observation, not
a recovery route or an instruction to obtain more rows.

Kanshi owns what a composite report means; this chapter owns its terminal
projection. Its world view keeps section grouping and summarizes associations
already visible in other sections; a selected entity exposes its associated
entities when no separate section carries them. Association marks distinguish
entities from counts and ordinary owned facts. Facts keep their labels and
values together, including long copyable identities and paths, and missing
values remain explicit. Compact grouping and narrow-terminal layouts remain
useful where they preserve scanning density and ownership; uniformity alone
does not justify expanding every fact into a separate row. Activity summaries
retain the concrete work observed, rather than substituting a broad category
for useful command, path, or text evidence. Gate evidence retains its compact
visual state notation alongside each declared gate's identity; stale evidence
remains explicitly named.
Task owns Task facts and [cli-task.md](cli-task.md) owns their
Task-facing presentation. Contract, Git, and Akuma renderers receive their
facts from their respective public results. A raw caller answer remains raw
when that operation promises answer bytes, rather than being framed as a new
report. Shared presentation changes preserve the Akuma timeline's activity,
time, continuity, and running-tool distinctions; they do not restyle that
surface into ordinary fact rows.

Detached call receipts foreground the complete Akuma identity with any alias
as a parenthetical supplement. Compact resource rows name the associated
Contract and the actual execution directory; the invocation World is not an
additional text fact. Dispatch, alias, and restraint problems retain their
evidence as attention rows. The receipt stops at facts: it neither claims a
live worker state nor prescribes a follow-up command.

Tell delivery has one text carrier: its corresponding timeline row. A held or
pursuing delivery does not add a separate wake or receipt-status line. A
failed delivery may add one prominent failure fact to that same carrier.

Opaque configuration and observation values retain exact names, scalar types,
collection membership, empty values, and provenance in text. Characters that
need terminal-safe presentation are escaped reversibly rather than replaced.
A selected conflict observation retains its known saved-byte coordinate and
available recovery handle, without inventing either when no receipt exists.
Presentation may
not flatten away those distinctions or imply successful operation merely
because an observation returned. Refusal and recovery text keeps specific
causes, available capture capabilities, and usable recovery coordinates;
removing internal terminology never means removing the underlying evidence.

Progress notices, installation reports, diagnostics, and completion receipts
are ephemeral process observations. They are useful only when they report an
actual boundary, never as simulated progress, persisted facts, or a hidden
alternative protocol. The renderer has no scanner grammar, output schema, or
private status vocabulary of its own.

For delivery, review, and audit, witnessed execution progress is written to
stderr while one complete final text or JSON result remains on stdout. On a
terminal, progress is one status line refreshed in place — current phase, unit,
and ticking elapsed — with bounded output blocks appended beneath it; the
ticking elapsed is the only liveness evidence, and a quiet interval never
claims that a command is hung or alive. Off a terminal, progress degrades to
sparse phase-boundary lines without repeated coordinates. Terminal cancellation
asks the owned operation to stop and waits for its truthful final receipt and
cleanup boundary instead of replacing that result with an early CLI exit.

An observing call reports the same kind of progress. A call that waits, renders
text, and carries no answer contract announces the identity its birth already
established and then each timeline row once it has settled, on the progress
channel as the window advances, while its one complete final result stays on
stdout. The stream restates the timeline's own rows in their final form rather
than inventing a private vocabulary or standing in for the final result; a call
that answers a schema, renders JSON, or detaches has no such stream.

When an exceptional Contract execution already confirmed admissions, the CLI
reports the failure together with those receipts instead of projecting a usage
error or a no-effect refusal. Text and JSON preserve the same admitted facts and
failure boundary. Ordinary cancellation and execution stops retain their phase;
resource cleanup has one invocation-wide carrier with sufficient ownership
coordinates to distinguish problems from different candidates or dependents.
