# Akuma Heart

This chapter owns Akuma durable facts, custody, schemas, and projections.

## Async Boundary And Transaction Judge

Every Heart operation exported through the owner index returns a Promise when
it observes or changes the Heart or leash. Fulfillment means the requested
observation or mutation has completed; callers do not receive lazy snapshots
or synchronous wrappers.

Inside that boundary, one `DatabaseSync` connection may remain only for a
bounded Heart or leash section that reads, adjudicates, and writes one owner
database transaction before closing or returning custody. The section contains
no `await`, performs no unrelated filesystem work, and admits no parallel
writer. This synchronous SQLite section preserves Heart's atomic row order and
single-writer law; it is not a public synchronous API, cache, mirror, daemon,
or queue.

Any Heart observation assembled from multiple SQL queries uses one read-only
SQLite transaction, so every value in that observation comes from one
snapshot. It does not acquire writer or leash custody.

SQLite open is the first and sole existence attempt for an existing Heart or
leash. Existing custody opens read-write without create; initialization is the
only create-capable path. `CANTOPEN` alone does not prove absence: only after
that failure may the Heart owner await filesystem metadata, and only `ENOENT`
becomes the caller's existing null or heart-gone result. An existing path, any
other metadata result, or a database that opens with an invalid schema
preserves a hard failure. No filesystem precheck participates in that judgment.

## Turn Timeline

The retained Heart timeline sequence is the only order visible to public Akuma
projections. A Body owns its live descendant handles and holds the leash;
Heart owns Body, stop, pause, kill, and Body Request facts. A Turn is one provider start
or resume within that Body, and one Body may contain many Turns.

Every admitted Turn has a `turn-start` coordinate before provider invocation.
The optional initial call, provider activity, tell admission and delivery, and
one `turn-end` refer to that coordinate. An interrupted or crashed Turn may
remain open; Heart never fabricates a provider outcome. Unsupported resume is
refused before a Turn is admitted. Old schemas are rejected without migration
or compatibility reading.

Retention removes old closed Turn groups as a bounded dependency closure. It
keeps pending tells, open Turns, and the Turn structure required by retained
rows. Cursors, gaps, and history loss refer to persisted timeline sequence.

The pure public projector folds that one retained sequence into a Turn ledger.
Each ledger Turn is a readonly `open` or `closed` arm. An unmatched tool start
enters an open Turn as `active`; admitting that Turn's end purely rewrites any
remaining active rows to `unsettled` in the closed arm, without adding a
completion fact or `ToolResult`.
Its snapshot frontier is one open Turn, otherwise the latest closed outcome,
or unborn. Pending tells are the body-scoped actionable exception to that Turn
frontier. For an open Turn, the selector retains the newest three rows as its
tail and independently retains the newest three `said` or `thought` rows
strictly before that tail. Every active tool and pending tell is pinned outside
both budgets; the union is deduplicated, restored to timeline order, and its
omitted count covers only hidden open-Turn rows. Each contiguous hidden run
becomes a typed read-time gap entry at its actual position; the gap counts sum
to `omitted`. These entries are not Heart facts or history cursors. History
alone owns retained-boundary and loss interpretation. The projector
may fold a final assistant row whose complete bytes exactly equal its answered
Turn outcome, but it never changes or creates Heart facts.

## The heart

Row kinds and their atomic order are law. Table layout is implementation
freedom.

Heart facts self-date when the event occurs. These timestamps are retained
because the write-time truth cannot be reconstructed after a detached process
dies; their existence does not depend on a current control-flow reader.

- **soul** — one row, written at birth: id, archetype, optional description,
  resolved provider execution, admitted options, optional `ReadonlyRestraint`,
  summon cwd, origin, confinement, created-at. The restraint is the exact
  provider-admission fact, not a Heart judgment. Heart owns the exact Soul
  envelope and its cross-field consistency; identity and provider-recipe
  members are decoded only by their own authorities.
- **bodies** — one row per Body: sequence, leash-taken-at, and optional explicit
  end (`exited` / `broke-off` / `put-down`). No process coordinate or
  reconstructable termination authority is durable.
- **turns** — one row per admitted Turn, keyed by its `turn-start` timeline
  sequence. It may remain open or carry exactly one `turn-end` outcome. An
  answered outcome carries the complete answer and may carry an exact
  provider-owned fork point; a failed outcome carries only its diagnostic.
- **session** — the provider's resumable coordinate, written the moment the
  adapter declares one resumable, not at turn completion. A new body resumes
  from the latest valid session fact; no
  session fact, no resume promise — the body starts the provider fresh and
  says so. Keiyaku never rebuilds a broken native session; it only refuses
  to lose a coordinate the native harness already granted. Its cwd and
  provider options preserve the exact native resume recipe.
  Before any session admission, wake starts fresh from the soul's summon cwd
  and options.
  The coordinate is the closed union `{ sessionId } | { sessionFile,
  sessionId? }`; its strict codec rejects blank, mixed, or additional fields.
  Claude and Codex use the first arm. Pi uses the exact persisted-file arm.
  Heart stores that union without provider tags or parallel Pi custody.
- **launch admissions** — one provider submission fence. Body pairs it with the
  immutable launch TellIds it supplied and records the admission and each
  TellId's launch delivery in one Heart transaction. The adapter never echoes
  those product identities in its admission.
- **activity** — the persistent execution-history sequence
  `(sequence, turn_sequence, event_json, at)`. `sequence` is monotonic and
  never reused. Every row belongs to the Turn that observed it. The body keeps
  the newest 5,000 rows with a bounded write buffer; crossing that buffer
  compacts in one batch rather than enforcing an exact count after every write.
  Recent status is a read-time selection, not a smaller persisted log. Typed, bounded activity is the first and only
  execution-history log. Raw native payloads are never activity facts.
- **tells** — the admitted body and recorded timeline sequence, repeatable
  deliveries with route plus Heart-owned `turnSequence`, provider fence, and
  the live attempt's receipt requirement, provider-authored terminal receipts
  with exact or fence correlation;
  see Tell. Admission allocates its sequence from the same monotonic timeline
  allocator as activity. The tell remains one Heart fact family; no duplicate
  activity row is persisted.
- **requests** — the sole durable authority for Body Requests. One fact holds
  the caller UUID, Archetype, frozen provider recipe and readonly restraint,
  body, optional cwd,
  normalized world, admission time, and exactly one monotonic state: `admitted`,
  `reserved` with the child coordinate, `served` with the child coordinate,
  `refused` with a diagnostic, or `voided` with evidence. `served`, `refused`,
  and `voided` are terminal.
- **stop / pause** — distinct transient control rows. Stop freezes the current
  Body sequence and asks that Body to end for `kill`; pause asks it to yield for
  `interrupt`. Only that live Body may terminate its descendants through owned
  handles. A later leash holder may clear abandoned control but cannot claim
  physical custody of the predecessor.
- **kills** — immutable witnesses that `kill` stopped one exact Body sequence.
  A witness is admitted only after the same Body explicitly ended `put-down`
  and released the leash. Only the latest Body's witness projects `killed`; a
  successor Body supersedes it without deleting history.

The seal is the one row that must not live in `heart.db`: the birth claim is a leash
transaction, and "check the seal in the same claim" is only atomic if the
seal sits under the same lock. The seal therefore rides the leash's
database, not `heart.db`. Both schemas and their typed interpretation are
owned inside the closed `heart/` custody core; no store or repository interface
sits between callers and its index.

Heart schema version is `14`; leash schema version remains `4`. Version 14
adds the named readonly restraint to Soul. Successful completion remains
separate from the optional exact provider fork point; session and complete
answer remain required for an answered Turn. Older hearts
fail the schema gate; no migration or compatibility decoder exists. Absence is
stored as SQL `NULL` and omitted from public values.

Heart custody owns its fact vocabulary, schema gates, row codecs, connections,
transactions, conditional judgments, custody verbs, and durable timeline
reads. The shared timeline owns ordering, slicing, and retention across every
row kind; Tell owns only Tell admission, delivery, receipt, fence, and pending
state. The public semantic timeline has one pure projector outside custody.
Consumers do not access its SQLite handles or row statements. Custody is one
authority boundary; its private file layout is not law.

Every durable fact has a named witness. Heart is the only durable Akuma
authority; an adapter owns only a live native process and never writes Heart.
Body is the only mover and, after the caller's recorded admission, the only
tell-fact writer. A submission acknowledgement or launch admission witnesses
delivery; a provider receipt witnesses only what its typed evidence says.
Provider events, turn completion, process liveness, and Body inference cannot
manufacture tell delivery or processing facts. No observer store, capability
registry, or compatibility copy of the old tell pipeline exists beside Heart.
Exact provider receipts name their TellId. Fence receipts are admitted only
when an existing delivery fact from the same `turnSequence` resolves that fence
to TellIds; an unknown or differently scoped fence cannot create a receipt fact.
Delivery and receipt facts have two readers: the replay/terminality fold and the
public two-state tell projection. They are not a second execution-history log.
The fold is one total rule: any launch delivery, receipt-free live delivery, or
terminal receipt yields `told`; otherwise the tell is `pending`. Kill is not a
Tell fact and cannot settle or discard one.
Retention removes settled tell facts below the same buffered 5,000-row timeline
boundary as settled provider activity. Pending tell facts are pinned until they
become told because Body recovery and status still read them. A
settled fact may remain in the bounded buffer until a later write crosses the
compaction threshold; no command promises an exact physical row count.

The retained activity read is the sole raw activity-history primitive. It
returns the complete retained provider-activity and tell fact window in
ascending timeline sequence, together with `lowestRetained` and `highest`. It
joins those facts by their one shared timeline sequence and does not copy tell
state into activity persistence. It does not accept or apply public history
`before`, `since`, or the semantic-row `limit`. Those coordinates belong to
the public Turn-ledger selector. The bound numbers are persisted timeline
sequence coordinates, not semantic-row counts. A sequence below
`lowestRetained` is permanently unavailable. Gaps inside the retained range
are reported arithmetically from the rows, never by persisted marker facts.

The activity fold and the snapshot selector are separate pure readers. The
fold decodes events, pairs tool start and completion by provider id, retains
both timestamps, derives completed duration, and keeps a completed tool at its
start-fact sequence. Completion enriches that row and does not mint another
cursor coordinate. Each tell projects as exactly one `pending` or `told`
semantic row at its recorded sequence, and semantic rows exist before any
budget is applied. A completed event whose start was pruned is a settled row
without duration and does not reconstruct that start; a retained start without
completion is in flight. The snapshot selector pins every in-flight tool and
every pending tell outside the independent tail-three and voice-three budgets.
Tail is the newest non-pinned ordinary window rows; voice is the newest eligible
pre-tail ordinary said or thought rows. Active tools stay at their actual
positions and do not occupy tail slots. Settled tool rows remain ordinary.
Voice inside the tail does not consume the voice budget; `note`, `call`, `tell`,
tool, and outcome rows are not voice candidates. It deduplicates the union,
restores timeline order, and replaces each contiguous hidden run with a typed
gap entry carrying that run's semantic-row count. The gap counts sum to the
snapshot's total omitted count and never represent persisted loss.
`status()` and `wait()` use this one selector. Full history pages do not apply
snapshot pinning or category budgets.

The shared timeline is the sole retained Turn projection. Its `turn-start` and
`turn-end` rows provide answer, failure, and boundary order. The fork-point
reader is the only targeted `turns` read: it exact-matches one answered Turn
carrying `historyId` and returns that fact's
inseparable session and native point. It also resolves that session
coordinate's admitted provider, cwd, and options recipe for the native call and
child birth; a retained answered turn without that recipe is authority
corruption, not `unknown-history`.

`readHeart()` does not reinterpret the timeline. Public history reads the same
timeline projector without copying answer bytes into activity. `history --last`
reads at most one answered Turn end, selected by its durable timeline sequence.
No answered row projects typed absence; an answered row
retains its exact `answer` bytes, including an empty string. Recovery,
resume, fork, outcome, failure, and life never read activity. Thus the shared
timeline owns execution chronology and complete outcome bytes, while session
rows remain the sole resume authority.

`list()` remains a compact fleet read and never scans activity or turns. A
directory that is not a canonical physical AkuId is not a member and may be
ignored. Known absence of Heart or leash in the initialization window is not a
member failure; it projects the existing unborn row. After a valid physical
identity, schema mismatch, IO corruption, and other read failures fail the
complete fleet read. The error names the AkuId and directory and retains the
original cause. There is no per-member diagnostic or partial marker.

One judge per question:

- Birth vs seal: both live under the same leash claim. Judge: the leash.
- Kill vs Body replacement: the killer waits for the target Body to release the
  leash, re-reads that exact Body's explicit `put-down` end, and records its
  witness in one Heart transaction. A repeated witness is idempotent; a stale,
  untidy, or superseded sequence is rejected. Judge: leash ownership plus the
  Heart transaction.
- Body exit vs concurrent tell: the heart and the leash are two locks, so
  neither alone may judge. The exit check (no pending tells, same
  transaction) is necessary but not sufficient; the waker closes the gap —
  see Wake.
- Child birth (for forwarded calls): judged by the **child's** leash, never
  by looking across databases. The parent heart only remembers where to
  look.

No cross-database atomicity is claimed anywhere. A held leash alone proves only
that a Body remains live. `hung` requires that Body's durable diagnostic that
owned provider custody did not retire within the response window. Elapsed time
at a public boundary never constructs that fact or grants process authority.
