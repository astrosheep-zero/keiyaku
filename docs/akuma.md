# Akuma

This chapter owns Akuma identity, heart facts, life, detached bodies, provider
boundaries, lifecycle verbs, and persistence. The current surface ships the
Claude and Codex app-server providers, public handles, status, wait, interrupt,
fork, Body Requests, CLI skin, and Kanshi rows. Body Requests reroute the
existing call surface; they do not add a public verb.

An akuma is a summoned agent: useful, dangerous, cheap, and it can die. The
flagship calls one, watches it, steers it, and collects what it brings back —
in TypeScript first. The CLI is argv skin over the same surface.

## Shape

One akuma is a set of durable facts in one place — its heart. Processes come
and go; the heart stays.

- **heart** — the closed custody core in `heart/`. It privately owns `heart.db`
  and `leash.db`; typed facts cross its index boundary, SQL rows and schemas do
  not. One authority boundary does not require one source file: facts, row
  mechanics, and transaction judges remain separate paragraphs of the same
  heart. Raw statements are row mechanics; they do not speak in the judge's
  transaction language.
- **soul** — the immutable birth facts: id, persona, description, resolved
  provider execution, provider options, summon cwd, origin, confinement, and
  optional Contract association.
  The association is opaque `kei/...` identity bytes meaning "summoned for";
  it carries no Contract lifecycle or carrier behavior. The cwd is the akuma's
  seat, not a native resume coordinate; resumability remains a session fact.
- **body** — the detached, unsandboxed process currently driving the akuma.
  At most one body at a time; most of the time, none.
- **leash** — an exclusive transaction in `leash.db`. Whoever holds it is the
  body. Held for the body's whole life; the OS releases it on death. The same
  database holds the seal, so birth and sealing have one judge.
- **collar** — the body's recorded process coordinates: pid, process group,
  spawn time. The only safe grip for putting a body down.
- **seal** — a control row that closes a coordinate forever: a sealed
  directory will never be born.
  Written only under the leash; a late body's birth claim checks the seal
  in the same transaction and self-aborts if present.
- **provider** — the agent process the body drives through the built-in adapter
  kind selected by its frozen execution recipe. Its writable reach is a typed
  confinement fact, never an admission gate.

The dependency direction is fixed:

```text
cli -> akuma -> {body, heart, identity, persona, provider(codec), publication, requests, providers(map), settings, runtime/proc(collar)}
persona -> {identity, provider, providers(map), settings}
body -> {heart, provider, providers, requests, runtime/proc}
requests -> {heart, identity, provider, providers(map), publication}
publication -> {heart, identity, runtime/proc}
provider -> heart types
providers/* -> {provider, runtime/proc/line-rpc}
providers/codex-app-server/index -> {events, provider, heart, runtime/proc/line-rpc}
providers/codex-app-server/events -> {provider, runtime/proc/line-rpc(type)}
kanshi -> akuma public values
```

The two process-tree duties are distinct. The body puts down a predecessor
before driving; the public `kill` verb is the killer and performs its own
collar duty. Both consume domain-free `runtime/proc` evidence, and neither
moves lifecycle adjudication out of the heart.

## Life

Five states for a born akuma, all computed from two probes — try the leash,
check the collar. Never from a clock, never from a pid table, never from
trust.

| state    | leash | collar               | meaning                                     |
| -------- | ----- | -------------------- | ------------------------------------------- |
| running  | held  | —                    | a body is driving a turn                    |
| asleep   | free  | proven gone          | last turn completed; tell and fork ready    |
| stranded | free  | proven gone          | last turn broke off; that work is lost, typed |
| headless | free  | **not proven gone**  | tree alive, or collar unverifiable — the
                                                evidence says which; wait or kill          |
| dead     | —     | —                    | a death row exists                          |

`headless` never claims more than the probe can prove: it carries the collar
evidence (`alive` / `unverifiable`). A recycled pid is never group-killed
blind; unverifiable stays unverifiable until the flagship acts or the tree
exits.

A headless akuma whose collar stays unverifiable is an in-model dead end:
`tell` refuses (waking requires putting the predecessor down first) and
`kill` reports `unavailable`. The escape is documented, not automated —
fork the work out of retained history; once a human confirms the tree is
gone, remove the run directory by hand. Rare (same-user process identity
is readable on every supported platform in the normal case), but the law
names the dead end rather than pretending it isn't there.

Before birth a directory is **unborn**: either being born or abandoned by a
crashed caller — indistinguishable by reading, and no fact about the akuma
is claimed. Certainty costs the leash: take it; a soul means born; no soul
means you may seal it, and sealed is permanently **stillborn**. Age is
evidence for humans, never a judge.

Natural death does not exist. A finished akuma is asleep, not dead. Failures
are turn facts, not entity death. Death has exactly one writer: `kill`.
Retained history outlives death — a dead akuma can still be forked, and its
answers remain readable.

Death closes every outstanding caller obligation in the same heart
transaction: pending tells become `voided-by-death`, and `admitted` or
`reserved` Body Requests become `voided` with death evidence. A reserved
request copies its child coordinate into that evidence before clearing the
state field. Death-void is receipt-scoped: it proves no caller can ever receive
a receipt, not that the separately judged child failed to be born. A child that
did finish birth remains a real, origin-bearing akuma.

## Identity and birth

Identity is `aku/<persona>/<hex8>`, the registered family in `docs/model.md`.
The physical directory name is the structural projection `/` -> `-`
(`spider-5fa5fb68`) — deterministic topology, not a second identity.
`identity.ts` is the sole interpreter in both directions: identity to directory
and directory name back to identity.

Allocation is the atomic directory create. `EEXIST` means the coordinate is
taken — occupied, closed, or sealed, no difference — so redraw. The
directory is also the write-ahead record: it exists before any process is
spawned.

Birth order: create directory -> spawn body -> body takes the leash and, in
the same claim, checks for a seal (sealed -> self-abort) -> soul row written
under that claim -> visible. `call()` returns only after birth. The window
between create and claim is owned by `call()` while it lives (it polls for
birth; on timeout it takes the leash itself if it can, seals, and reports a
typed spawn failure). If the caller crashes inside the window, the directory
is unborn until someone pays the leash to seal it. Nothing sweeps blind;
nothing adjudicates by age.

Public world and summon coordinates are normalized once at the Akuma boundary.
Soul cwd, heart paths, and detached launch paths are absolute below that point;
downstream layers do not reinterpret relative paths.

Stillborn residue is visible in `list()` with its evidence. No automatic
cleaner ships until a real reader needs one; manual removal is safe because
a body must not outlive its heart (ENOENT -> kill own tree, exit).

## Persona

A Persona is the mask that combines an akuma's personality and provider
configuration. It is call-time input at exactly one path:

```text
~/.keiyaku/akuma/<name>.md
```

The file begins with one strict YAML mapping. `provider` is required;
`model`, `effort`, `access`, `network`, and `description` are optional.
`access` is `read | write | auto`; `network` is `disabled | enabled`; every
other consumed value is a nonblank string. Additional top-level keys are
ignored and never enter Persona options or the soul snapshot. The Markdown body
after frontmatter is the system prompt, including an empty one.

`Akuma.at({ path, settings? })` normalizes the world once. It uses the injected
Settings snapshot when present and otherwise constructs one Settings value for
that world. `call({ persona })` validates the name, reads this one Persona file,
resolves its `provider` as an execution name in the Settings `providers`
namespace, and asks the selected built-in adapter kind to admit the Persona
options before allocating an identity. Missing, malformed, unknown-provider,
and provider-unsupported input is typed failure; a missing or malformed Persona
includes the exact path searched. There is no fallback Persona or directory
layering.

A provider entry is one strict object with required `kind`, optional nonblank
`description` and `executable`, optional object `config`, and optional `env`
whose values are strings. The two kinds are `claude-agent-sdk` and
`codex-app-server`; only Codex consumes `config`. When no same-name Settings
entry exists, Persona names `claude` and `codex-app-server` select their
Akuma-owned default executions. A configured same-name entry replaces that
default wholly under Settings shadow law.

Birth snapshots the Persona name, optional description, complete provider
execution, and admitted options into the soul. The body never reads Settings or
the Persona file. A newly admitted
native session snapshots the exact options used alongside its coordinate and
cwd; resume reads that session recipe. Before admission, the body uses the
soul's options and summon cwd. Thus later edits to Persona Markdown affect only
future akuma.

Provider kind `claude-agent-sdk` consumes `model`, `effort`, and
the system prompt. `access` maps `read` to plan mode, `write` to edit acceptance,
and `auto` or absence to bypass mode. Claude cannot honestly enforce the
portable `network` claim, so either network value is refused before birth.

Provider kind `codex-app-server` runs the selected executable, defaulting to
`codex`, as `app-server --listen stdio://`. It consumes `model`, `effort`,
and the system prompt. Missing `access` and `access: write` both select native
workspace-write rooted exactly at the normalized call cwd; `network` selects
that sandbox's native network flag and defaults to disabled. `read` and `auto`
are refused because this cut has no second honest policy mapping for them. Its
resumable coordinate is the native thread id; its answered history id is the
completed native turn id, and native fork is `thread/fork` at that exact pair.
The frozen `config` object is supplied to native thread start/resume.
Each app-server instance is a detached helper process tree. Drive completion
awaits termination of that complete tree, so provider descendants cannot outlive
the body turn or leave an answered Akuma headless.

## Placement

Hearts live in the primary world:

```text
<world>/.keiyaku/akuma/run/<name>-<hex8>/{heart.db, leash.db, stdio.log}
```

- Never inside a contract worktree. Transport reconcile removes clean
  worktrees lawfully; the akuma pillar must not bleed when that pillar acts.
- `run/.gitignore` containing `*` is written when `run/` is created — the
  ledger ignores itself; the user does nothing.
- Known risk, accepted: `git clean -fdx` in the primary world erases run
  state. Same fate as `.keiyaku/response`; repo-local state is repo-local.
  No defense is built.
- Home keeps Persona configuration only, never state. Nothing reads it back
  after call.

## Confinement

Threat model, ruled: users and agents are assumed **non-malicious**;
malignant errors — a lying ledger, silent loss of recorded facts — are
barred; kernel-grade correctness is not the bar. Defenses against
deliberate forgery are out of scope: a hostile process with host authority
can falsify anything, and no placement law changes that, so none pretends
to.

What remains is accident isolation, and placement already buys it: hearts
never live in a contract worktree — the provider's task surface — so a
zako's `rm -rf` or `git clean` in its own workspace cannot reach them.
When cwd is the primary world itself, the heart sits inside the provider's
reach; that is the same accepted repo-local risk as anyone running
`git clean -fdx` there, and **no refusal is built**. (Revision 2 carried a
hard overlap refusal from v3's `ORGAN_WRITABLE_OVERLAP`; it would have
refused the most ordinary call — an akuma working in the primary world —
to defend against malice this model does not assume. Withdrawn.)

The adapter still states the provider's writable surface. During a declared
drive it can grant the body-owned request transport as an additional writable
root; the transport never moves into the user's worktree. The statement rides
into the soul as a typed `confinement` fact — evidence for triage, never a gate.

## The heart

Row kinds and their atomic order are law. Table layout is implementation
freedom.

Heart facts self-date when the event occurs. These timestamps are retained
because the write-time truth cannot be reconstructed after a detached process
dies; their existence does not depend on a current control-flow reader.

- **soul** — one row, written at birth: id, persona, optional description,
  resolved provider execution, admitted options, summon cwd, origin,
  confinement, optional
  Contract id, created-at. The Contract id is immutable for the soul's whole
  life; there is no reassignment verb.
- **bodies** — one row per body: collar, leash-taken-at, end (exited /
  broke-off / put-down).
- **turns** — append-only completed turns. An answered outcome carries the
  answer and the exact provider-owned fork pair: the `ResumeCoordinate` on
  which that turn actually ran plus its provider-native `historyId`. A failed
  outcome carries only its diagnostic and cannot be forked. History ids are
  never reused and do not shift when retention drops an earlier turn.
- **session** — the provider's resumable coordinate, written the moment the
  adapter declares one resumable (v3's session admission law), not at turn
  completion. A new body resumes from the latest valid session fact; no
  session fact, no resume promise — the body starts the provider fresh and
  says so. Keiyaku never rebuilds a broken native session; it only refuses
  to lose a coordinate the native harness already granted. (rev 3 kept the
  coordinate on completed turns only — a crash after admission but before
  turn completion lost a resume the native harness still offered.)
  Its cwd and provider options preserve the exact Cut 1 native resume recipe.
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
  the caller UUID, Persona, frozen provider recipe, body, optional cwd,
  optional Contract id, normalized world, admission
  time, and exactly one monotonic state: `admitted`, `reserved` with the child
  coordinate, `served` with the child coordinate, `refused` with a diagnostic,
  or `voided` with evidence. `served`, `refused`, and `voided` are terminal.
- **stop / pause / death** — distinct control rows. Stop belongs to terminal
  kill; pause belongs to non-terminal interrupt. One meaning never reuses the
  other's row.

The seal is the one row that must not live in `heart.db`: the birth claim is a leash
transaction, and "check the seal in the same claim" is only atomic if the
seal sits under the same lock. The seal therefore rides the leash's
database, not `heart.db`. Both schemas and their typed interpretation are
owned inside the closed `heart/` custody core; no store or repository interface
sits between callers and its index.

Heart schema version is `5`; leash schema version remains `4`. Heart version 5
adds the activity body coordinate and 5,000-row persistent history to the
version 4 provider-execution recipe. This is a hard cut: an
older heart fails the existing schema gate; no migration or compatibility
decoder exists. Absence is stored as SQL `NULL` and omitted from public values.

The heart is four coherent files with one-way dependencies. `facts.ts` owns the
domain fact vocabulary and the pure `life()` interpretation and has no imports.
`schema.ts` depends only on a type-only SQLite handle and owns both DDL texts,
the single schema version, and its hard-cut gates. `rows.ts` depends only on the
facts plus a type-only SQLite handle and owns private row shapes, named per-fact
codecs, and named single-statement functions. A statement function accepts a
caller-owned SQLite handle, executes exactly one statement, and maps typed
parameters and results;
it may type-import the handle but never constructs, opens, closes, or retains a
connection, starts a transaction, branches into a conditional write, or
composes another statement. `index.ts` is the sole connection constructor and
owns connections, transactions, the leash, every conditional judge, custody
verb, and public projection. Consumers import only the index. Custody is one
authority boundary, not one source file.

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

## The body

Wake -> take the leash (checking the seal) -> put down the predecessor ->
write the body row -> resume the provider from the latest session fact
(fresh at `soul.cwd` when none exists) -> pump. The pump is
the whole job: heart rows become provider actions; provider events become
heart rows; body requests become in-process calls.

**Wake is level-triggered.** A waker that finds the leash held does not exit
blind: it waits for the leash to free and re-observes, and it may stop only
when the tell that woke it is consumed, voided by death, or it takes the
leash itself and serves it. Two wakers converge through the same rule: the
leash serializes them, and the second one finds the work already done.
(The naive "loser exits" rule loses a tell forever when the incumbent's
final exit check and the new tell interleave across the two locks.)

The pursuit is only as alive as its pursuers: a reboot can kill body and
waker together, leaving a recorded tell honestly pending — served at the
next wake, visible until then. No daemon wakes anyone spontaneously.

**Put down.** Before doing anything else, a new body settles its
predecessor by the collar: verify the tree is gone; kill it (process group /
`taskkill /T /F`, via `runtime/proc`) if alive; refuse with `unavailable`
if the collar cannot be verified — the spawn time must match; a recycled
pid is never group-killed blind.

A body must not outlive its heart: heart directory gone (ENOENT on tick) ->
kill own provider tree, exit. The world ended; the body follows.

The body also reads stop control. It aborts the drive, records `put-down`, and
releases the leash. A stop without a following death proves the killer vanished;
the next body clears that abandoned stop under its leash before driving.

The detached launch carries a soul seed only before birth. Once birth returns,
including `already-born`, the persisted soul is the only source for provider,
cwd, origin, and confinement; an existing-soul wake carries only heart paths.

If the heart disappears while a drive is live, the body aborts that drive,
puts down its own provider process group, and exits. It never leaves a detached
provider tree running without observable custody.

The body owns the provider process tree, spawned in its own process group,
collar recorded in the body row before the provider starts. The leash
proves the body; the collar answers for the tree. Neither claim is asked of
the other.

For each turn the body tracks the actual resumable session: it begins with the
session passed to `start()`, when any, and advances when the provider emits a
session-admission event. An answered result is persisted only with that exact
session and the provider-authored history id. Answering before either a resumed
or newly admitted session exists violates the provider boundary and is recorded
as a failed turn; the body never manufactures a fork coordinate.

## Tell

Four facts, at-least-once, provider deduplicates (v3 semantic law; plain
names, same meaning as v3's admitted/submitted/seen/consumed):

- **recorded** — the heart holds it; survives anything
- **delivered** — handed to the provider
- **seen** — the provider acknowledged it
- **consumed** — it entered a turn

`tell()` = record + wake (level-triggered, above). Asleep and stranded wake
the same way: spawn a body, which resumes from the latest session fact. A
tell recorded but never
consumed when death arrives gets a typed `voided-by-death` receipt from the
killer — nothing recorded is ever silently unreachable.

There is no `resume` verb. Providers cannot continue a broken-off turn;
waking means new input through `tell`. The verb set is call, of, list, status,
wait, tell, interrupt, history, fork, and kill.

## Interrupt

`interrupt(body)` is the high-level composition "synchronously put down this
turn, then tell"; it is not terminal kill and writes no death row. Its sequence
is fixed: request pause in a heart transaction that fences death; wait one grace
window for the body to abort and release the leash; if still held, put down the
current verified collar; clear pause under the leash; call the ordinary
tell-record transaction with no death pre-check; then spawn the ordinary wake.

Pause and stop are separate control kinds. The body polls pause beside stop,
aborts its drive, records the existing `put-down` body end, and exits. A new
leash holder clears an orphan pause before driving, just as it clears an orphan
stop. Pause-vs-death and tell-vs-death remain heart transaction decisions;
self-abort remains a body effect; collar fallback remains the interruptor's
public-boundary effect.

The receipt is a sum because later steps may never lawfully begin:

```ts
type InterruptReceipt =
  | { kind: "dead" }
  | {
      kind: "unstoppable";
      evidence: "no-collar" | "collar-unverifiable" | "unavailable"
        | "alive-after-sigkill" | "leash-held-after-put-down";
    }
  | {
      kind: "interrupted";
      putDown: "was-idle" | "self-aborted" | "collar";
      tell: TellReceipt | { kind: "refused-dead" };
    };
```

`dead` is the zero-effect result when the request-pause transaction sees the
death fence; it writes no pause. `unstoppable` means the interruptor did not
obtain the leash within its bounded windows: no recorded collar, an
unverifiable collar, an unavailable or surviving physical put-down, or a collar
reported gone while the leash still remained held. The pause remains, and no
tell, wake, or death row is written. The asynchronous pause signal may still be
observed after this return and cause the body to self-abort; unproven is not
retracted. The next leash holder clears that abandoned pause.

`interrupted` is possible only while the interruptor itself holds the leash.
`putDown` states how it acquired that proof: immediately (`was-idle`), after
the body honored pause (`self-aborted`), or after collar fallback (`collar`). It
then clears pause and calls the ordinary tell transaction. A concurrent death
there yields `refused-dead` and no wake; the already completed put-down remains
in the receipt. Physical killed/already-gone evidence without subsequent leash
ownership is `leash-held-after-put-down`, never success.

## Kill

Stop row -> grace -> put down by the collar -> recheck the leash -> death
row, written by the killer. Kill is a lifecycle verb; the killer is a
legitimate writer.

Synchronous evidence, four values (v3 law, renamed in place): `killed`,
`already-dead`, `alive-after-sigkill`, `unavailable`.

## Fork

`fork({ at: historyId })` requires one exact retained answered-turn match.
The selected fact supplies its inseparable `{ session, historyId }` pair; fork
never substitutes the latest session, chooses a nearby turn, or resumes the
parent session. A failed turn has no history id and therefore cannot be
distinguished from any other absent coordinate at this boundary.

The public result is a closed sum:

```ts
type ForkReceipt =
  | { kind: "forked"; child: AkuId }
  | { kind: "provider-cannot-fork"; provider: string }
  | { kind: "unknown-history"; at: string }
  | { kind: "fork-failed"; diagnostic: string }
  | { kind: "upstream-forked"; childSession: ResumeCoordinate; diagnostic: string };
```

The receipt carries facts, not capabilities: success returns the child id;
`world.of({ id: receipt.child })` constructs its handle. An unstarted address
still throws `AkumaNotBornError`, as status does. The deterministic decision
order is not-born, provider capability, exact retained history, native fork,
local allocation/birth/publication, then success. A provider without the
capability is categorical and is refused before reading `at`. Native rejection
before a child coordinate exists is `fork-failed` and claims no upstream or
local effect. There is no dead or abort arm: fork only reads the parent heart,
so running, asleep, and dead sources may all fork retained history.

Fork is a provider primitive, not something ordinary resume can compose.
`ProviderAdapter` gains an optional `fork({ session, at, cwd })` operation in
Cut 2. An adapter without it returns `{ kind: "provider-cannot-fork", provider
}`; no emulation is attempted. The operation has no abort input: once the
upstream provider has made a child session there is no honest cancellation
point that can erase that fact.

The sequence is provider fork first, then ordinary local allocation and birth.
The child's soul copies the parent snapshot, including its optional Contract
association, except for its id, creation time, and origin `{ kind: "fork",
parent, at }`; no fork override exists. Direct and body-request births retain
their existing arms. Under the birth leash, publication also admits the
provider-created child coordinate as the first `SessionFact`, with the selected
answered turn's provider, cwd, and options recipe. Thus the child is born
asleep with zero turns and its first tell resumes the forked native session.
Upstream success followed by any local allocation, birth, session-admission, or
publication failure returns `{ kind: "upstream-forked", childSession,
diagnostic }`. It is not written into the unchanged parent heart and is not
dressed up as a local child. Claude maps the primitive to native `forkSession`
with the answered turn's session id and outer assistant-message UUID. The SDK
must return a distinct nonblank child session id; a missing source or message
point, native failure, or reused coordinate is `fork-failed`.
Authenticated provider evidence proves that the child transcript retains the
selected prefix and that later parent and child writes do not enter each
other's transcript.

## Body Requests

A provider process lives inside one parent body's drive. If that body dies,
the provider caller is already gone or is put down by predecessor settlement.
Therefore a later body closes old requests by observation only: it never
re-executes one, and never needs an exactly-once claim.

Body Requests exist only for a provider whose confinement is `declared`.
The body injects `AKUMA_REQUESTS` for that drive; a nested `Akuma.call()` or
`keiyaku akuma call` reroutes exactly when that variable exists. An unconfined
provider receives no injection and performs the ordinary direct call. There is
no third mode, second public verb, or generic messaging surface.

### Transport, authority, and judge

Each declared drive gets an ephemeral transport directory owned by the akuma:

```text
<akuma-dir>/requests/<body-sequence>/
```

The adapter grants that directory as an additional provider writable root and
injects its absolute path. A caller writes `<request-id>.request.json` by
temporary-file rename and polls `<request-id>.receipt.json` without a deadline.
The body writes the receipt projection. The request id is a caller-minted UUID.
The directory is best-effort removed after the drive drains, so bytes never
cross drives.

Transport bytes are not facts. Before heart admission they are claims; after
settlement receipts are projections that may be reproduced from the heart.
Missing, malformed, or discarded transport bytes therefore do not create or
erase authority. The parent heart's request facts are the only durable request
authority and have one writer: the body holding its leash. Admission uses the
request id for idempotence, so at-least-once claim observation produces at most
one fact. There is no second store.

The claim decoder validates the complete frozen recipe before Heart admission.
Its provider execution uses the same exact decoder as Persona admission, its
options use the provider-owned option decoder, and its confinement must equal
the selected adapter's pure projection for that cwd. A malformed recipe is a
malformed claim and never becomes a durable request fact.

The child directory and its leash remain the sole judge of child birth. The
parent heart remembers only the reserved child coordinate: where to observe,
not a claim that the child was born. The child soul records origin
`{ kind: "request", parent, requestId }`.

### Admission and service

A request carries the caller's normalized absolute world, Persona name, body,
optional cwd, and optional Contract id. The caller must state the Contract id
explicitly; a request never inherits the parent soul's association. The serving
body requires that world to equal its own world,
loads the Persona from its own home, admits provider options, and normalizes the
cwd at this boundary. The Akuma boundary structurally validates a present id as
the shared `kei` identity family and stores its bytes verbatim. It never checks
whether the endpoint exists or reads Contract state. World mismatch, unknown or
malformed Persona, and option refusal settle `refused`; the body never silently
redirects a request.

Service is serial in heart admission order:

```text
validate -> admit -> allocate directory -> reserve coordinate -> spawn child
         -> await birth -> settle served -> project receipt
```

Allocation remains the atomic directory create. A candidate that loses create
is redrawn and never reaches the request fact. Only after a successful create
does the body advance the request to `reserved`, and only then may it spawn.
The publication owner accepts this reservation as a caller-supplied durable
step between allocation and spawn; ordinary call and fork supply no such step.
It makes no cross-database atomicity claim. A failure after allocation uses the
ordinary local-publication seal and settles the request `voided`.

The closed transitions are:

```text
admitted -> refused { diagnostic }
admitted -> reserved { child }
reserved -> served { child }
reserved -> voided { evidence }
admitted -> voided { evidence }
```

A served receipt returns the child handle. Refused and voided receipts become
typed call errors carrying the diagnostic or evidence.

### Recovery and pump

After predecessor settlement and before driving a turn, a body sweeps every
nonterminal request. An `admitted` request without a reservation becomes
`voided`: its old caller is gone and no body was spawned. For a reserved
request:

1. A missing child directory becomes `voided` with evidence.
2. A lock-free child-soul read that finds a matching origin becomes `served`;
   an origin mismatch becomes terminal `voided` evidence.
3. If the soul is absent, the body tries the child leash and re-reads. Still
   absent under the leash is sealed and becomes `voided`.
4. If the leash is held, the body polls for a soul or seal for the ordinary
   birth timeout. Born becomes `served`, sealed becomes `voided`, and timeout
   remains nonterminal for the next wake.

Soul presence is monotonic, so settlement never takes a healthy child's leash.
The sweep never spawns, replays, or reprojects receipts: its caller is gone.

The live request pump runs concurrently with one provider drive and only inside
the body that holds the parent leash. The entrance opens when the adapter starts
with the drive's request directory. Provider completion, stop, pause, or heart
loss closes it immediately. After closing, no new claim is admitted; every
already-admitted service runs to a terminal request fact and projects its
receipt before the body persists the turn, records put-down, or follows the
heart-loss burial path. A normal body exit therefore has no nonterminal
request. A crash may leave one; the next wake's observation sweep or the death
transaction closes it.
Requests do not enter the idle predicate because live service drains within its
drive scope.

One hop holds at every depth: each provider talks only to its own unsandboxed
body, and each child body grants a fresh drive-local transport when its own
provider is declared.

## Provider boundary

```ts
type ProviderAdapter = {
  confinement(input: {
    cwd: string;
    options: ProviderOptions;
  }): Confinement;
  admitOptions(options: ProviderOptions): ProviderOptionAdmission;
  start(input: {
    prompt: string;
    cwd: string;
    options: ProviderOptions;
    session?: ResumeCoordinate;
    requests?: { dir: string };
  }): Promise<Drive>;
  fork?(input: {
    session: ResumeCoordinate;
    at: string;
    cwd: string;
  }): Promise<{ session: ResumeCoordinate }>;
};

type Drive = {
  events: AsyncIterable<AgentEvent>;
  completion: Promise<TurnResult>;
  abort: () => Promise<void>;
};
```

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
  | { kind: "read"; path: string }
  | { kind: "search"; query: string }
  | {
      kind: "fileChange";
      changes: readonly {
        op: "add" | "update" | "delete";
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

`provider.ts` owns this vocabulary and its strict encode/decode pair. The body
encodes normalized events before handing opaque JSON to Heart; public activity
readers decode through the same owner before history or snapshot folding. Exhaustive
event-type switches make a union change fail typecheck until the codec changes
with it. Heart remains the opaque persistence owner and does not import provider
semantics.

The Codex adapter is one directory with two coherent owners. Its `index.ts`
drives line-RPC, native session admission, fork, and interrupt; `events.ts` owns
native notification/item dispositions and the pure `AgentEvent` translation.
The driver consumes the typed translation result and does not reinterpret native
event payloads.

`session` is authored when the native harness grants a resumable coordinate
(v3's `onSessionAdmission`). The pump records that coordinate immediately as
the heart's authoritative session fact and also appends the event as activity;
it never waits for turn completion. `assistant` contains a bounded completed
agent narration of at most 16,384 characters, never deltas or summaries. The
complete answer is stored separately in `TurnFact` and is never truncated.
`tool` preserves the provider's stable
tool id, the started/completed lifecycle, one provider-neutral call shape, and
the typed result disposition. A started event carries no result; a completed
event requires one. Result `message` is a bounded diagnostic, never stdout,
stderr, or a native result body. `thought` is one completed reasoning summary
or block bounded at 4,000 characters, never raw thinking text or a delta stream.
`note` is one bounded line for non-tool plan, todo, retry, warning, or refusal
narration. Every other persisted activity text field, including tool names,
calls, diagnostics, and unknown native names, is bounded at 16,384 characters.
The provider codec is the sole persistence-bound judge; session coordinates and
tool pairing ids are never truncated. `unknown` contains only the unmapped native kind or method name
and never carries the native payload.

Activity is persistent execution narration. Deleting retained activity changes
history and recent snapshots, but never recovery, resume, fork, outcome,
failure, or life. Complete answer bytes and fork coordinates remain
authoritative only in `TurnFact`; a session row remains the sole resume
authority.

Every adapter owns a total disposition of its native events. Known native
kinds are mapped or explicitly dropped, and every unrecognized kind becomes
`unknown`. Tool, command, and file-change lifecycle maps to `tool`; bounded
completed reasoning summaries map to `thought`; plan or todo updates and
retry, warning, and refusal map to `note`. A native completion
must provide the matching typed tool result. Partial and delta streams, input
echoes, tool-result bodies and command output streams, raw thinking and
reasoning deltas, and token, cost, and rate-limit telemetry are dropped. The Claude adapter's SDK
union disposition is compile-time exhaustive with a runtime unknown fallback.
The Codex app-server method set is open, so its explicit known dispositions end
in an unknown fallback. Tests pin both tables and both unknown paths.

Claude's terminal answer is exactly `result.result`. Codex joins all completed
`agentMessage` texts in order with one blank line. A failed Codex turn preserves
the native explanation from an `error` notification or `turn.error`, using a
generic status diagnostic only when no native detail exists.

File-change adapters preserve every available native operation, path, and
per-change diffstat. Missing optional facts make the public row shorter; an
adapter never invents a diffstat. Codex app-server derives diffstat only from a
native unified patch and preserves the native change operation. Claude derives
add/update from its named write/edit tool and omits diffstat when the SDK does
not provide one. A multi-file public summary prints an aggregate only when
every represented change supplies a diffstat. No terminal file ledger, event
bus, subscription fan-out, usage or cost arm, raw-provider passthrough,
severity taxonomy, or native output body belongs in this boundary.

An answered `TurnResult.historyId` is the provider-owned fork point, not a
generic result identifier. The Claude adapter uses the outer assistant message
UUID associated with the successful result; the result UUID is not a valid
substitute. Together with the session observed by the body, it forms the
answered turn's durable fork coordinate.

Provider execution and option admission are provider-owned validation at the
public boundary, before identity allocation. `start()` is their effect reader.
The execution crosses the detached process boundary in the soul; each native
session records the execution name and exact options. Tell, resume, recovery,
and fork reconstruct the adapter only from those durable facts. A rerouted Body
Request carries its already resolved recipe into the parent heart, so the body
does not reopen Settings to birth the child. A fork inherits its parent's
execution.

`executable` constrains each provider process start. Literal provider `env`
values overlay the ambient environment at every provider interaction whose
native boundary accepts an environment. The ambient environment remains
launch-local and is not a Settings scope or durable fact. Codex start and fork
both use the frozen execution. Claude start uses its frozen executable and env,
but the in-process SDK `forkSession` primitive accepts neither; a Claude
execution carrying env therefore refuses fork instead of silently consulting
the default native session world. Akuma loads no dotenv file and performs no
environment interpolation.

Alongside its adapter, each provider module states its confinement for a
given call: declared writable roots, or `unconfined`. The soul records it;
nothing gates call admission on it. During a declared drive the adapter grants
the body-owned request transport as one additional writable root and injects
`AKUMA_REQUESTS`; an unconfined adapter never receives that input.

No `probe`, plugin registry, or registration schema exists. Provider instance
names are Settings data; `providers/index.ts` remains the closed kind-to-adapter
composition root used by the public boundary and detached body.

## Public surface

```ts
const world = Akuma.at({ path, settings? }); // path is the world; no climbing

const a = await world.call({ persona, body, cwd?, contract? }); // returns after birth
world.of({ id });
world.list();                              // compact fleet rows; no history scan

a.id                                       // aku/<persona>/<hex8>
a.status()                                 // current state + bounded activity
a.wait(predicate?, { timeoutMs? })         // same status carrier on either outcome
a.history({ before?, since?, limit? })      // persistent execution-history page
a.tell(body)
a.interrupt(body)                         // synchronous put-down, then tell
a.fork({ at: historyId })                 // exact retained native fork point
a.kill()                                   // evidence: four values
```

A rerouted call that reaches a terminal non-served request throws
`AkumaBodyRequestError`. Its closed fields are `kind: "akuma-body-request"`,
`outcome: "refused" | "voided"`, and the terminal `diagnostic`. Direct-call
errors retain their existing types; Body Requests do not wrap them before
heart admission.

`status()` combines the current compact heart snapshot, leash and collar probes,
the newest retained turn, and one activity snapshot. Its shape is:

```ts
type AkumaStatus = {
  id: AkuId;
  persona: string;
  description?: string;
  contract?: string;
  life: AkumaLife;
  collar: CollarProbe;
  confinement: Confinement;
  answer?: string;
  answerHistoryId?: string;
  failure?: string;
  outcomeAt?: string;
  pending: readonly TellId[];
  activity: ActivitySnapshot;
};

type ActivitySnapshot = {
  rows: readonly ActivityRow[];
  pendingTells: readonly { id: TellId; body: string; recordedAt: string }[];
  omitted: number;
  lowestRetained: number | null;
  highest: number | null;
};

type ActivityHistory = {
  rows: readonly ActivityRow[];
  turns: readonly TurnFact[];
  omitted: number;
  hasEarlier: boolean;
  hasLater: boolean;
  historyLost: boolean;
  lowestRetained: number | null;
  highest: number | null;
};

type ActivityRow =
  | { kind: "said"; sequence: number; bodySequence: number; at: string; text: string }
  | { kind: "thought"; sequence: number; bodySequence: number; at: string; text: string }
  | {
      kind: "tool";
      sequence: number;
      bodySequence: number;
      at: string;
      completedAt?: string;
      durationMs?: number;
      name: string;
      call: ToolCall;
      state: "running" | ToolResult;
    }
  | { kind: "note"; sequence: number; bodySequence: number; at: string; text: string };
```

`wait(predicate?, options?)` polls `status()` and returns the first complete
`AkumaStatus` accepted by the predicate. Its default predicate is
`status.life !== "running"`. `options.timeoutMs`, when present, is a
nonnegative millisecond duration. If it arrives first, `wait` returns the
current `AkumaStatus`; it adds no timeout arm or flag. The caller can reapply
its predicate to the returned observation. One status read prevents a torn
timeout result assembled from separate liveness and snapshot observations.
`wait` does not promise that every recorded tell was consumed: a crash can
kill body and waker together and legitimately leave tells pending.

`history()` is the sole public execution-history read. It returns one stable
activity page plus the completed-turn facts whose bodies occur in that page;
the read model, not Heart or the CLI, owns that join. Cursor coordinates are
persisted activity sequences. `before` and `since` are exclusive and mutually
exclusive. Status and wait never carry a full history page. The final answer
is not activity text: the explicit last-answer read selects the last answered
`TurnFact`, and CLI `history --last` writes its exact answer bytes.

An akuma that answered and was later killed reports both: `life: "dead"` with
the retained answer still attached. What to do about a stranded or headless
akuma is the flagship's decision; the surface puts the state and available
verbs in front of her and says nothing more.

`list()` is deliberately smaller than `status()`: born fleet rows expose id,
Persona and description snapshots, optional Contract id, life, collar evidence,
confinement, and pending tell ids, but no activity, history, or latest outcome. The id is
projected verbatim and has no endpoint-state interpretation here. Unborn/stillborn rows retain
their existing evidence. This keeps a fleet read from scanning the complete
turn history of every akuma. A corrupt member is silently skipped at this
boundary; healthy members remain visible. Confinement is triage evidence and future Body Request
placement input, never an admission result; no read reaches back into home.

Every attempted provider turn is durable as one outcome: `answered` carries its
actual session, provider-owned history id, and answer; `failed` carries a
diagnostic and no fork coordinates. Failure is not an activity invented by the
body, and it cannot be forked. Activity
contains only events authored by the provider. `status()` exposes the latest
failed diagnostic from history instead of asking activity to reinterpret it.
The provider-observation law and rendering semantics are defined in Provider
boundary above; the public surface does not reinterpret native events.

The CLI exposes Akuma operations as root verbs: `call`, `wait`,
`tell`, `interrupt`, `history`, `fork`, and `kill`. The shared root
`status` verb addresses an exact `aku/...`; bare `status` already carries the
fleet through Kanshi and no second raw-roster flag exists. Call, tell, and
interrupt read their bodies from a final `-`; `--json`
changes
rendering only. Library `world.of()` remains the handle constructor and has no
redundant CLI verb. CLI wait uses the default predicate and may supply a
timeout. Predicate functions are library-only input. CLI tell composes its
write receipt with one subsequent public `status()` read; it uses the same
activity snapshot and never creates a per-verb window. Kanshi obtains its Akuma
section from `Akuma.list()` without reading activity or history.

## Modules

Coherent owner modules, not mechanical-step directories.

```text
src/akuma/
  identity.ts         aku/ constructor/parser, allocation, topology
  persona.ts          one Persona read, Settings provider interpretation, option admission
  heart/
    facts.ts          import-free typed facts and life() interpretation
    schema.ts         private DDL, independent heart/leash versions, hard-cut gates
    rows.ts           private rows/codecs, named single-statement mechanics
    index.ts          connections, leash, transaction judges, custody, projections
  provider.ts         ProviderAdapter, Drive, AgentEvent, activity codec
  activity.ts         pure semantic fold, history page, snapshot selection
  providers/index.ts  provider-execution codec and closed kind composition map
  providers/claude.ts Claude Agent SDK translation
  providers/codex-app-server/
    index.ts          Codex stdio JSON-RPC lifecycle and provider composition
    events.ts         Codex notification/item disposition and event translation
  publication.ts      allocate, initialize, launch, await birth, local sealing
  requests.ts         drive-local transport, heart admission, service, settlement
  body.ts             detached composition root, pump, stop, exit
  akuma.ts            public orchestration and handles; zero adjudication
  index.ts            ./akuma exports
```

Primitives consumed: detached spawn, line-delimited RPC process, and kill-tree
(all from `runtime/proc`, domain-free), exclusive lock try-acquire (SQLite
`BEGIN EXCLUSIVE`), atomic write (directory create, transport temp-file rename;
heart rows ride the SQLite journal), and row polling (poll is watch).

Cut 1 closes the required physical primitives: detached spawn on every
platform, typed process collars, process-tree put-down, and SQLite exclusive
leash release on process death. Platform-specific physical tests remain the
verification evidence for those runtime claims.

Cut 1 established identity + heart + body + boundary + Claude + public
status/wait/interrupt. Cut 2 adds the provider fork primitive, public fork,
origin arm, and retention. The Codex app-server adapter adds a second built-in
provider kind without a plugin registry. Cut 3 adds Body Requests. CLI skin and the
Kanshi compact fleet read ride Cut 1.

## Never built

`src/akuma/core`, a store/repository interface, `leash.ts`, `seal.ts`, pointer
files (`.at`), transaction prechecks, a view-model layer, provider registry,
and event bus are not built. The directory is the record. Replay or adoption
state machines — write-ahead child id plus settlement under the child's
leash is the whole law. A `resume` verb. Request/catalog databases and doubled
event ledgers. The 10-step leash protocol. `probe` on the boundary.
Natural-death terminals. Blind sweeps and age-based adjudication — the
leash and the seal judge; age is evidence. Placement laws that claim to
confine unconfined processes. Confinement gates — confinement facts are
evidence, never admission control. Anti-forgery machinery of any kind —
malice is outside the threat model. Contract lifecycle or carrier knowledge
inside `src/akuma` — structural validation and opaque association bytes are the
whole edge. There is no Task endpoint field, generic metadata bag, binding
registry, existence validation, implicit Body Request inheritance, Contract or
Task back-pointer, association sweep, or behavior conditioned on Contract state
(SOUL: cut any pillar, the other two do not bleed).

Activity does not grow an updated phase, write-time fold, per-verb snapshot
window, usage arm, warning taxonomy, terminal file ledger, truncation metadata
envelope, or native output stream. Each would require a new named reader and a
change to this law.

Inside `heart/`, no generic get/save/find API, query builder, connection-owning
row object, per-table class, or table-by-table module is built. Row codecs do not make
decisions; every conditional write remains visibly inside the index's owning
transaction. Fact-table `SELECT` / `INSERT` / `UPDATE` / `DELETE` syntax and
their `prepare()` calls occur only in `rows.ts`; schema DDL and version reads
occur only in `schema.ts`; connection and transaction SQL remain in `index.ts`.
