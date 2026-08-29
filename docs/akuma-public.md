# Akuma Public Surface

This chapter owns Akuma public handles, status, wait, history, and fleet values.

## One Timeline Projection

Status and history read the retained Heart timeline once, project one typed
Turn ledger in persisted sequence order, then apply their snapshot or cursor
policy. They do not join outcomes by timestamp or read a second Turn
projection. A snapshot is current actionable observation: an open Turn exposes
only that Turn's tail-three plus independent pre-tail voice-three union, active
tools, and actionable pending tells. Tail and voice are taken from ordinary
window rows; an active tool does not occupy a tail slot. With
no open Turn it exposes only the latest outcome and actionable pending tells.
Monitoring snapshots (`status`, `wait`, and `call`) also pin the single
retained Tell row with the greatest timeline sequence whose state is `told`,
when one exists. That latest settled Tell is pinned outside the ordinary
budget, even when it sits outside the current open Turn or idle ordinary
window, and it appears once at its persisted sequence. Pin selection happens
before tail and voice fill, so the Tell never consumes an ordinary slot.
Mutation receipt snapshots (`tell` and `kill`) keep the ordinary last-activity
policy. A `tell` receipt additionally pins only the Tell admitted by that
invocation at its persisted timeline sequence, outside the ordinary budget;
`kill` receipts do not pin settled Tells.
Every snapshot arm, including unborn, also carries `reportedChanges` and
`reportedChangesOmitted` from that same frontier Turn. Eligible source rows
are completed `fileChange` tools with successful result status; each native
change stays its own item, with the tool row's start sequence and timestamp.
The newest five items are restored to original order; the omitted count is
exactly the older remainder and is independent of snapshot `omitted`, tail,
voice, pins, and typed gaps. Repeated paths remain repeated operations. An
empty frontier summary is `[]` and `0`. It never samples activity across
closed Turns. Contiguous hidden open-Turn runs
remain visible at their actual positions as typed read-time gap entries whose
counts sum to the snapshot's `omitted` total. `history` exposes pages of the
complete retained ledger in global order and does not consume snapshot gaps.
`history --last` is the exact full-answer read for the latest retained answered
Turn.

## Public surface

```ts
const world = Akuma.of(root, { home?, settings? }); // root is already resolved; no climbing

const a = await world.call({ archetype, body, cwd? }); // returns after birth
world.of({ id });
await world.listArchetypes();              // canonical names in byte order
await world.list();                        // compact fleet rows; no history scan

a.id                                       // aku/<archetype>/<hex8>
await a.status()                           // current state + bounded activity
await a.wait(predicate?, { timeoutMs? })   // same status carrier on either outcome
await a.history({ id?, before?, since?, limit? }) // exact retained outcome or execution-history page
await a.tell(body)                         // typed mutation result
await a.interrupt(body)                    // bounded pause, leash proof, then tell
await a.fork({ at: historyId })            // exact retained answered point
await a.kill()                             // typed settlement evidence
```

Each handle operation that reads Heart, leash, or filesystem state is a
Promise boundary and fulfills only after that observation completes. The handle
itself and its `id` remain synchronous because they carry only resolved value
coordinates.

The public lifecycle unions are closed:

```ts
type AkumaLife = "running" | "hung" | "untidy" | "asleep" | "stranded" | "killed";
type InterruptPutDown = "was-idle" | "self-aborted";
type InterruptUnavailable = "hung" | "untidy" | "unavailable";
type KillEvidence = "killed" | "already-killed" | "already-stopped"
  | "hung" | "untidy" | "unavailable";
```

None contains process coordinates or a capability to signal a described
process.

A rerouted call that reaches a terminal non-served request throws
`AkumaBodyRequestError`. Its closed fields are `kind: "akuma-body-request"`,
`outcome: "refused" | "voided"`, and the terminal `diagnostic`. Direct-call
errors retain their existing types; Body Requests do not wrap them before
heart admission.

`status()` watches one Akuma through fresh life evidence and one bounded
timeline snapshot. It is not a fleet row and does not extend or embed the fleet
projection. `status`, `wait`, `call`, `tell`, `interrupt`, and `kill` use the
same readonly snapshot union. Monitoring observations (`status`, `wait`,
`call`) pins the latest settled Tell. A `tell` mutation receipt retains the
ordinary snapshot pins and adds only the Tell admitted by that invocation;
other mutation receipts, including `kill`, do not pin a settled Tell.
An open snapshot may contain an `active` tool; an idle or unborn snapshot
cannot represent one. A closed
Turn's unmatched tool start remains `unsettled` in history and is not a claim
that its process is live. The projected ledger likewise exposes readonly
`open` and `closed` Turn arms: only the open arm admits an `active` tool row,
while the closed arm requires its outcome and excludes `active` from its row
union. Every Turn-scoped row carries its durable Turn
coordinate; Body coordinates remain private to Body lifecycle facts.
`AkumaStatus` also projects the Soul's optional `ReadonlyRestraint` verbatim;
it never re-evaluates provider capability or turns that fact into a warning
type.

Akuma owns one strict Body-boundary schema for its caller-visible status and
timeline projection. Its exported TypeScript projection type derives from that
schema, and local and forwarded readers consume the same decoded value; Fleet
does not restate an Akuma status or activity shape.

`tell(body)` returns one typed mutation result: the allocated TellId, its
recorded Heart admission, and durable wake custody evidence. It does not imply
delivery, provider observation, or turn entry:

```ts
type RunLogReference = Readonly<{ path: string; from: number; to: number }>;
type TellWake =
  | Readonly<{ kind: "told" }>
  | Readonly<{ kind: "pursuing"; bodySequence: number }>
  | Readonly<{ kind: "held" }>
  | Readonly<{
      kind: "failed";
      diagnostic: string;
      child?: Readonly<{ code: number | null; signal: string | null; log: RunLogReference }>;
    }>;
type TellResult = Readonly<{ admission: Readonly<{ tellId: string; fact: "recorded" }>; wake: TellWake }>;
```

`told` names the Tell's Heart delivery witness; `pursuing` names only a later
Body fact; and `held` is the waker child's atomic leash refusal, without a
holder identity or a delivery claim. `bodySequence` is the narrow exception
that exposes a Body coordinate as custody evidence. A failed arm retains the
Tell pending and can carry its actual waitpid code or signal with a bounded
reference into the shared run log; those referenced bytes are not stderr.
Delivery and
provider receipts fold into ordinary Akuma observation as one `pending` or
`told` tell row at the admission's original timeline position. Tell admission
is Body-scoped and does not imply entry into a Turn. Pending tell rows therefore
remain visible outside the open-Turn selection because they can still change the
caller's action. Monitoring snapshots pin the latest settled Tell the same way;
other settled tell rows remain visible through history like other settled
activity. Text and
JSON expose the same two-state row and no provider fence, five-stage
lifecycle, or stage timeline. Tell
rows are the sole detailed public tell projection; `AkumaStatus` carries no
pending-ID collection, description, or Archetype name. Those stay on the fleet
row or the identity. There
is no separate public TellId browsing workflow. A global `status()` value is
useful context but is not a mutation receipt and cannot alter this result.

`strandedReason: "resume-unsupported"` appears when a durable native coordinate
exists but the selected adapter lacks resume. The coordinate and pending tells
remain intact; status does not suggest or perform a fresh start.

`wait(predicate?, options?)` polls `status()` and returns the first complete
`AkumaStatus` accepted by the predicate. Its default predicate is one Akuma-owned
judgment over that complete snapshot: `status.life !== "running"` and no
timeline Tell row has state `pending`. A caller-supplied predicate is an exact
override. `options.timeoutMs`, when present, is a
nonnegative millisecond duration. If it arrives first, `wait` returns the
current `AkumaStatus`; it adds no timeout arm or flag. The caller can reapply
its predicate to the returned observation. One status read prevents a torn
timeout result assembled from separate liveness and snapshot observations.
`wait` does not promise that every recorded tell was delivered: a crash can
kill body and waker together and legitimately leave tells pending.
This standalone handle wait retains its ordinary status-read failures; only the
package-root plural wait has the per-round omission law in
[public-akuma.md](public-akuma.md).

`history()` is the sole public execution-history read. It pages the same
persisted-order Turn ledger used by status; it does not join a second Turn
projection. Heart supplies the complete retained raw fact window and its
retained bounds. The public selector folds that window once into the Turn
ledger, then applies `before` or `since` and the requested row `limit`
exactly once to folded semantic rows. A completed tool keeps the start fact's
sequence; completion enriches that row and does not mint another cursor
coordinate. Cursor, retained-boundary, gap, omitted-count, and history-loss
metadata belong only to this history selector; snapshots carry no history
cursor or retained-boundary fields. Cursor coordinates are those semantic-row
sequences. `before` and `since` are exclusive and mutually exclusive.
`before=N` selects semantic rows with sequence less than `N`; `since=N`
selects rows with sequence greater than `N`. `limit` counts folded semantic
rows and remains 1..5,000; an omitted limit selects the newest 12 rows. Status
and wait never carry a full history page.
Every completed answered or failed Turn has one stable, nonblank Heart-owned
`historyId` in the form `turn/<turnSequence>`, present on history outcome rows
and status/wait outcomes. Provider-native coordinates remain private.
`history({ id })` selects exactly one retained outcome with its complete answer
or diagnostic; blank IDs are invalid
input, unknown IDs are typed unknown-history results, and `id` cannot be
combined with cursor or limit options. `fork({ at })` accepts this same ID and
only answered outcomes are forkable.
The explicit last-answer read selects the latest retained answered Turn by
durable order and preserves its complete bytes, including an empty answer.

An Akuma that answered and whose latest Body was later killed keeps both facts
visible on their independent axes: life remains killed while the answered Turn
remains in the timeline. What to do about a stranded, hung, or untidy Akuma is the
flagship's decision; the surface puts the state and available verbs in front of
her and says nothing more.

Status and fleet project durable latest-Body `hung` even after that Body ended
`broke-off` and released the physical leash; its life timestamp remains
`hung.at`. Interrupt and other control observations report that same condition
as `hung`, never as ordinary untidy. Tell input may remain pending, but wake
cannot admit a successor through Heart's permanent gate. Fork remains available
because it creates a distinct Akuma identity.

`list()` is the compact fleet scan, not a smaller `status()`. Born fleet rows expose id,
Archetype and description snapshots, life and its source Heart timestamp,
`lastActivityAt`, and pending tell count, but no activity, history, or latest
outcome. `lastActivityAt` is the highest-sequence retained Heart timeline row's
timestamp, or `null` when no timeline activity exists. Its bounded lookup does
not load retained history and is distinct from life and its timestamp. The
public types share `id` and `life` by coincidence, not by inheritance. The id is
projected verbatim and has no endpoint-state interpretation here. Unborn/stillborn rows retain
their existing evidence. A valid allocated directory that is otherwise readable
is not omitted for the recognized unborn/stillborn cases: missing Heart or leash
in the initialization window is `unborn`; seal without Soul is `stillborn`; Soul
selects the born row. Invalid directory names may be ignored. Hard read failures
while projecting one valid physical identity, including schema mismatch and
corruption, silently omit that row and do not suppress readable peers. There is
no public per-row failure arm,
diagnostic row, or retry. Direct reads of that AkuId retain their ordinary
failure. This keeps a fleet read from scanning the complete
turn history of every akuma. No read reaches back into home.
The life timestamp is the current Body's leash time for running, its hung
evidence for hung, the matching kill witness for killed, and the latest Body end
for asleep or stranded. Untidy has no honest beginning time. Unborn and
stillborn rows do not acquire a life timestamp.

Every admitted provider Turn starts on the shared timeline and has at most one
provider outcome. Answered outcomes retain the complete answer and any real
provider fork coordinate; an answer without one remains a normal answer but is
not an exact fork point. Failed outcomes retain a diagnostic and cannot be forked. A
terminated or crashed Turn may remain open rather than inventing an outcome.
Provider activity contains only provider-authored events; neither Body nor CLI
reinterprets failure as activity.
Provider observation is defined in [akuma-provider.md](akuma-provider.md); this
public surface does not reinterpret native events. Package-root selector and
cross-product composition are owned by [public-akuma.md](public-akuma.md), CLI
grammar and rendering by [cli.md](cli.md), and Kanshi composition by
[kanshi.md](kanshi.md).
