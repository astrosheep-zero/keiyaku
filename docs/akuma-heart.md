# Akuma Heart

This chapter owns Akuma durable facts, custody, schemas, and projections.

## Turn Timeline

Heart schema version 10 is a hard cut. Its retained timeline sequence is the
only order visible to public Akuma projections. A Body owns process, leash,
collar, stop, pause, kill, and Body Request facts. A Turn is one provider start
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

## The heart

Row kinds and their atomic order are law. Table layout is implementation
freedom.

Heart facts self-date when the event occurs. These timestamps are retained
because the write-time truth cannot be reconstructed after a detached process
dies; their existence does not depend on a current control-flow reader.

- **soul** — one row, written at birth: id, archetype, optional description,
  resolved provider execution, admitted options, summon cwd, origin,
  confinement, created-at.
- **bodies** — one row per body: collar, leash-taken-at, end (exited /
  broke-off / put-down).
- **turns** — one row per admitted Turn, keyed by its `turn-start` timeline
  sequence. It may remain open or carry exactly one `turn-end` outcome. An
  answered outcome carries the complete answer and exact provider-owned fork
  pair; a failed outcome carries only its diagnostic.
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
  the caller UUID, Archetype, frozen provider recipe, body, optional cwd,
  normalized world, admission time, and exactly one monotonic state: `admitted`,
  `reserved` with the child coordinate, `served` with the child coordinate,
  `refused` with a diagnostic, or `voided` with evidence. `served`, `refused`,
  and `voided` are terminal.
- **stop / pause** — distinct transient control rows. Stop freezes the current
  Body sequence and asks that Body to end for `kill`; pause asks it to yield for
  `interrupt`. A leash holder must physically settle the frozen predecessor,
  write its kill witness, and clear stop before creating a successor Body.
- **kills** — immutable witnesses that `kill` stopped one exact Body sequence.
  Only the latest Body's witness projects `killed`; a successor Body supersedes
  it without deleting history.

The seal is the one row that must not live in `heart.db`: the birth claim is a leash
transaction, and "check the seal in the same claim" is only atomic if the
seal sits under the same lock. The seal therefore rides the leash's
database, not `heart.db`. Both schemas and their typed interpretation are
owned inside the closed `heart/` custody core; no store or repository interface
sits between callers and its index.

Heart schema version is `10`; leash schema version remains `4`. Heart version 10
hard-cuts every child origin to one `parent` field. It retains the shared
activity-and-tell timeline, Body-scoped kill witnesses, and the Archetype and
Contract-column hard cut. This is a hard cut: an
older heart fails the existing schema gate; no migration or compatibility
decoder exists. Absence is stored as SQL `NULL` and omitted from public values.

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

`activitySlice({ before?, since?, limit? })` is the sole activity-history
primitive. It joins provider activity and tell facts by their one shared
timeline sequence; it does not copy tell state into activity persistence.
`before` and `since` are mutually exclusive, exclusive sequence
coordinates. `before` returns the newest page whose rows precede an already
seen sequence; `since` returns rows following an already seen sequence; an
inputless slice returns the newest page. It returns rows in ascending sequence
order together with `lowestRetained` and `highest`. The numbers are persisted
activity sequence coordinates, not semantic-row counts. A sequence below
`lowestRetained` is permanently unavailable. Gaps inside the retained range
are reported arithmetically from the rows, never by persisted marker facts.

The activity fold and the snapshot selector are separate pure readers. The
fold decodes events, pairs tool start and completion by provider id, retains
both timestamps, derives completed duration, projects each tell as exactly one
`pending` or `told` semantic row at its recorded sequence, and
produces semantic rows before any budget is applied. A completed event whose
start was pruned is a settled row without duration; a retained start without
completion is in flight. The snapshot selector pins every in-flight tool and
every pending tell outside its budget, selects the newest three settled
semantic rows, and additionally retains the newest five `say` or `thought`
rows even when they precede that tail. It deduplicates the union and returns
semantic order as typed `row | gap` entries. Each hidden interval stays at its
actual position and counts folded semantic rows, not stored events or sequence
differences. A one-row interval is expanded as its original row; only two or
more hidden rows become `gap`. `status()` and `wait()` use this one selector.
Action feedback uses the same fold and selector with only the tail-three settled
budget while retaining the same in-flight and pending pins. Full history pages
do not apply snapshot pinning or category budgets.

The shared timeline is the sole retained Turn projection. Its `turn-start` and
`turn-end` rows provide answer, failure, and boundary order. The fork-point reader is the only targeted
`turns` read: it exact-matches one answered `historyId` and returns that fact's
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

`list()` remains a compact fleet read and never scans activity or turns. It
isolates each member read: malformed identity, heart, or schema silently omits
that member. Only inability to read the Akuma run root fails the list. There is
no member diagnostic or partial marker.

One judge per question:

- Birth vs seal: both live under the same leash claim. Judge: the leash.
- Kill vs Body replacement: the killer acquires the leash after physical stop,
  re-reads the latest Body, and records a witness for that exact sequence in one
  Heart transaction. A repeated witness is idempotent; a stale sequence is
  rejected. Judge: leash ownership plus the Heart transaction.
- Body exit vs concurrent tell: the heart and the leash are two locks, so
  neither alone may judge. The exit check (no pending tells, same
  transaction) is necessary but not sufficient; the waker closes the gap —
  see Wake.
- Child birth (for forwarded calls): judged by the **child's** leash, never
  by looking across databases. The parent heart only remembers where to
  look.

No cross-database atomicity is claimed anywhere. No clock enters the law.
