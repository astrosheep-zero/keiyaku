# Akuma Heart

This chapter owns Akuma durable facts, custody, schemas, and projections.

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
- **turns** — append-only completed turns. An answered outcome carries the
  answer and the exact provider-owned fork pair: the `ResumeCoordinate` on
  which that turn actually ran plus its provider-native `historyId`. A failed
  outcome carries only its diagnostic and cannot be forked. History ids are
  never reused and do not shift when retention drops an earlier turn.
- **session** — the provider's resumable coordinate, written the moment the
  adapter declares one resumable, not at turn completion. A new body resumes
  from the latest valid session fact; no
  session fact, no resume promise — the body starts the provider fresh and
  says so. Keiyaku never rebuilds a broken native session; it only refuses
  to lose a coordinate the native harness already granted. Its cwd and
  provider options preserve the exact native resume recipe.
  Before any session admission, wake starts fresh from the soul's summon cwd
  and options.
- **activity** — the persistent execution-history sequence
  `(sequence, body_sequence, event_json, at)`. `sequence` is monotonic and
  never reused. Every row belongs to the body that observed it. The body keeps
  the newest 5,000 rows on write; recent status is a read-time selection, not
  a smaller persisted log. Typed, bounded activity is the first and only
  execution-history log. Raw native payloads are never activity facts.
- **tells** — body plus its delivery state; see Tell.
- **requests** — the sole durable authority for Body Requests. One fact holds
  the caller UUID, Archetype, frozen provider recipe, body, optional cwd,
  normalized world, admission time, and exactly one monotonic state: `admitted`,
  `reserved` with the child coordinate, `served` with the child coordinate,
  `refused` with a diagnostic, or `voided` with evidence. `served`, `refused`,
  and `voided` are terminal.
- **stop / pause / death** — distinct control rows. Stop belongs to terminal
  kill; pause belongs to non-terminal interrupt. One meaning never reuses the
  other's row.

The seal is the one row that must not live in `heart.db`: the birth claim is a leash
transaction, and "check the seal in the same claim" is only atomic if the
seal sits under the same lock. The seal therefore rides the leash's
database, not `heart.db`. Both schemas and their typed interpretation are
owned inside the closed `heart/` custody core; no store or repository interface
sits between callers and its index.

Heart schema version is `6`; leash schema version remains `4`. Heart version 6
renames the persisted Archetype columns and removes Contract columns from soul
and Body Requests. This is a hard cut: an
older heart fails the existing schema gate; no migration or compatibility
decoder exists. Absence is stored as SQL `NULL` and omitted from public values.

Heart custody owns its fact vocabulary, schema gates, row codecs, connections,
transactions, conditional judgments, custody verbs, and public projections.
Consumers do not access its SQLite handles or row statements. Custody is one
authority boundary; its private file layout is not law.

`activitySlice({ before?, since?, limit? })` is the sole activity-history
primitive. `before` and `since` are mutually exclusive, exclusive sequence
coordinates. `before` returns the newest page whose rows precede an already
seen sequence; `since` returns rows following an already seen sequence; an
inputless slice returns the newest page. It returns rows in ascending sequence
order together with `lowestRetained` and `highest`. The numbers are persisted
activity sequence coordinates, not semantic-row counts. A sequence below
`lowestRetained` is permanently unavailable. Gaps inside the retained range
are reported arithmetically from the rows, never by persisted marker facts.

The activity fold and the snapshot selector are separate pure readers. The
fold decodes events, pairs tool start and completion by provider id, retains
both timestamps, derives completed duration, and produces semantic rows before
any budget is applied. A completed event whose start was pruned is a settled
row without duration; a retained start without completion is in flight. The
snapshot selector pins every in-flight tool and every unconsumed tell outside
its budget, selects the newest eight settled semantic rows, and additionally
retains the newest two `say` or `thought` rows even when they precede that tail.
One omitted interval becomes one derived gap whose count is semantic rows, not
stored events. `status()` and `wait()` use this one selector. Full history pages
do not apply snapshot pinning or category budgets.

`readTurns()` is the sole retained completed-turn projection. Its named row
statement returns retained `TurnFact` values in ascending sequence order for
answer, failure, and boundary joins. The fork-point reader is the only targeted
`turns` read: it exact-matches one answered `historyId` and returns that fact's
inseparable session and native point. It also resolves that session
coordinate's admitted provider, cwd, and options recipe for the native call and
child birth; a retained answered turn without that recipe is authority
corruption, not `unknown-history`.

`readHeart()` does not read or reinterpret turns. `readCurrentTurn()` reads only
the newest retained turn for `status()`. Public history joins activity pages to
the relevant body and turn facts without copying answer bytes into activity.
`history --last` reads the final answered `TurnFact` directly. Recovery,
resume, fork, outcome, failure, and life never read activity. Thus activity
owns execution chronology, `TurnFact` owns complete outcome bytes and native
fork points, and session rows remain the sole resume authority.

`list()` remains a compact fleet read and never scans activity or turns. It
isolates each member read: malformed identity, heart, or schema silently omits
that member. Only inability to read the Akuma run root fails the list. There is
no member diagnostic or partial marker.

One judge per question:

- Birth vs seal: both live under the same leash claim. Judge: the leash.
- Caller work vs death: recording a tell checks for a death row in the same
  transaction; writing the death row fences all later tells and atomically
  voids every nonterminal tell and Body Request. Judge: the heart's own
  serialization.
- Body exit vs concurrent tell: the heart and the leash are two locks, so
  neither alone may judge. The exit check (no unconsumed tells, same
  transaction) is necessary but not sufficient; the waker closes the gap —
  see Wake.
- Child birth (for forwarded calls): judged by the **child's** leash, never
  by looking across databases. The parent heart only remembers where to
  look.

No cross-database atomicity is claimed anywhere. No clock enters the law.
