# Akuma Execution

This chapter owns body execution and the tell, interrupt, kill, and fork lifecycle verbs.

A Body first revokes delegated Heart-write and spawn authority, then races its
Session `abort()` against the control response window. Abort rejection or
timeout races mandatory adapter-owned `forceDispose()` against the same window.
Forced success retires custody normally. Forced rejection or timeout appends
the latest Body's `hung { diagnostic, at }`, records one diagnostic activity,
ends that Body `broke-off`, and returns from the Body process. It never sleeps
while holding the leash and never records ordinary `put-down` or handoff after
that result.

## Body And Turn

The Body is the process lifetime. Its loop may drive multiple provider Turns.
Before `start` or `resume`, execution admits a Turn and its initial call into
Heart. Provider activity and live tell delivery then carry that Turn coordinate.
Normal completion writes exactly one Turn end with the complete answer or typed
failure. Start failure writes a failed end. Stop, interrupt, kill, and process
loss may leave the Turn open and do not synthesize a provider result.

After the initial Turn outcome is committed, Body derives the WorldRoot from
its launch paths, opens `<WorldRoot>/.square/PUBLIC.square`, and implicitly
joins as its own AkuId. Unless that identity is already done, it emits exactly
one bare activity containing the answer or failure diagnostic. The activity
contains at most the first 1,000 characters; a longer outcome appends
`keiyaku history <AkuId> --last` so the caller can read the complete latest
outcome. Heart retains the complete answer and diagnostic. It never calls
`done`; the Aku remains joined. Missing Square and delivery failures are
best-effort, logged, and do not change Heart truth or Body terminal state.

Body construction never hides Heart or filesystem observation. Its supervisor
and request pump are opened asynchronously, and every control tick, Heart
refresh, request recovery, and durable write is awaited within the existing
serial ownership order. If the Heart disappears between an observation delay
and the awaited refresh, the supervisor classifies that disappearance and
aborts its owned provider custody through the same Body signal.

## The body

On wake, Body claims the leash under the seal, judges abandoned control,
records its Body fact, and resumes the latest session or starts fresh at
`soul.cwd`. While it owns the leash, Heart rows become provider actions,
provider events become Heart facts, and Body Requests become in-process calls.

**Wake is level-triggered.** The wake predicate is `pending Tells exist && no
live Body holds the leash`. Tell, interrupt, kill, and every existing
Heart-custody entry re-evaluate it; after releasing its leash, a Body performs
one final re-evaluation and, when the predicate holds, initiates one detached
successor and releases its handle. Successful launch ends that recovery without
observing Heart delivery, child admission, or child exit; launch failure leaves
the Tell pending. No daemon heals it without a later interaction.

Kill recovery uses the same detached handoff after its leash evidence is
settled; kill returns its lifecycle evidence without waiting for successor
admission, Heart delivery, or child exit.

A waker establishes its cancellable Heart observer before unconditionally
spawning one child. It never probes the leash or joins a leash observation to a
Body row. Fresh Heart delivery evidence returns `told`; a later Body fact
returns `pursuing` with that fact's sequence; only the child's atomic leash
refusal returns `held`; and any other child exit before either Heart witness
returns `failed`. A held result names no holder, promises no delivery, and
writes no losing Body fact. Concurrent callers can therefore receive different
honest receipts while their children converge through the one leash.

Observer establishment failure returns `failed` before spawn and leaves the
Tell pending. Aborting an established observer wakes a pending generator read,
closes its underlying observer, and lets cleanup finish; there is no polling
fallback. The observer is a replaceable cross-process prompt over Heart's
durable storage: it carries no fact, may merge or repeat prompts, and must
deliver at least one prompt after an external Heart settlement. Subscription
precedes the initial Heart read, so a write between those steps cannot be
missed. A pre-admission child failure records its actual waitpid code or signal
plus a bounded `{ path, from, to }` reference into the shared run log.
The interval may contain interleaved output, includes the child's exit marker,
and is not captured stderr or a child-attributed file tail.

The pursuit is only as alive as its pursuers: a reboot or pre-admission child
exit leaves the recorded Tell honestly pending. The next ordinary Heart
interaction re-evaluates and pursues that debt. No daemon wakes anyone
spontaneously, and no bootstrap-failure fact is recorded.

Heart change observation belongs to the direct caller that executes wake under
its host permission. A forwarded provider Tell writes only its granted Body
Request transport; its direct parent executes the Tell and observes Heart. The
observer is established before spawn. An observation failure retains the Tell,
spawns no child, and returns failed; a prompt only prompts a fresh Heart read,
whose successor Body fact is the sole custody evidence. Observation must not
disturb the Heart files it observes: Heart reads use read-only SQLite custody,
and write-only WAL setup remains on Heart creation and write paths.

**Succession.** A new Body never reconstructs custody of its predecessor. A
held leash means wait. A free leash with an explicitly ended predecessor is
settled history. A free leash with no explicit Body end is `untidy`; abandoned
stop control may be adjudicated under the leash before the successor records
its own Body. An outstanding pause makes an ordinary successor yield so the
interrupt composition can judge and clear it. This admits future work without
claiming that the successor physically terminated anything.

A body must not outlive its heart: heart directory gone (ENOENT on tick) ->
abort the live provider session through its owned handles, exit. The world
ended; the body follows.

The Body has one lifetime control observer, one Body-owned `AbortSignal`, and
one obedience decision. Setup, request recovery, and the active drive do not
create their own watchers or register duties. Each phase uses lexical cleanup
with the shared signal. One observation round reads one Heart snapshot and
publishes that same snapshot to stop, pause, and pending-Tell consumers.

A provider Session's `abort()` requests graceful native cancellation. The Body
revokes delegated Heart-write and spawn authority before retirement, bounds
that request, and escalates rejection or timeout to mandatory adapter-owned
`forceDispose()`. Forced disposal fulfills only after every adapter-owned OS
child or native session is disposed, including late resources after
cancellation. Streams, receipts, Tell promises, and iterators are not custody.

`hung` has one source: both graceful cancellation and forced disposal failed
to retire a named external provider child or native session within their
control response windows. The Body records the durable diagnostic and activity,
ends `broke-off`, and returns so the physical leash is released. Local request
recovery and request-pump cancellation cannot produce `hung`.

The detached launch carries a soul seed only before birth. Once birth returns,
including `already-born`, the persisted soul is the only source for provider,
cwd, and origin; an existing-soul wake carries only heart paths.

If the heart disappears while a drive is live, the Body aborts that drive
through the provider capability it owns and exits.

Process descriptions are diagnostic only. Runtime direct spawn returns a
closure-backed live handle to the caller that spawned the child. The Body and
provider adapter retain those handles while supervising and may terminate only
through them. Child exit or close, successful termination settlement, and
explicit release each make the capability inert. Repeated termination after
reap cannot signal again. Releasing a handle gives up that authority. No pid,
process group, start token, or reconstructed identity is stored in the Body
row.

On Windows, Body launch and retained provider children present no visible console; console policy is runtime-private and confers no signal authority.

For each turn the body tracks the actual resumable session: it begins with the
session passed to `resume()`, when any, and advances when the provider emits a
session-admission event. An answered result is persisted only with that exact
session and the provider-authored history id. Answering before either a resumed
or newly admitted session exists violates the provider boundary and is recorded
as a failed turn; the body never manufactures a fork coordinate.

## Tell

Heart records only tell facts with a named witness:

- **recorded** — witnessed by the Heart admission transaction.
- **delivered** — witnessed by provider submission evidence. Its route is
  `live` with a `Session.tell()` acknowledgement or `launch` with a session
  admission. Body correlates its immutable launch TellIds with the returned
  fence. The durable correlation key is the current Heart-owned `turnSequence`
  plus that provider fence.
- **receipt** — provider-authored evidence attached without reinterpretation.
  Its kind preserves the provider's terminal evidence; its correlation is an
  exact TellId or shared fence.

```ts
type TellDelivery =
  | { route: "launch"; turnSequence: number; fence: ProviderFence }
  | {
      route: "live";
      turnSequence: number;
      fence: ProviderFence;
      receipt: "unavailable" | "required";
    };
```

Deliveries are repeatable evidence, not a mutable stage. `receipt` preserves
the one fact needed after restart: whether this live acknowledgement settles
the tell or terminal provider evidence is still required. There is no durable
capability registry.

The product fold has exactly two states because only these change the
flagship's next action:

- **pending** (`⧗`) — the tell can still take effect, so observe. This includes
  a recorded tell not yet handed off and a receipt-capable live delivery whose
  terminal receipt has not arrived.
- **told** — the strongest evidence available from that provider proves the
  tell took effect: launch admission, a terminal live acknowledgement under the
  provider contract, or terminal provider receipt evidence.

These are projections, not persisted stages. There is no persisted "in
delivery" state and no harness-owned seen/consumed lifecycle. Nonterminal
native tell observations stay adapter-private; terminal receipt kinds remain
exact evidence and never become product state words. Body is the sole
mover and the sole writer of tell facts after admission. It writes delivered
only after submission evidence and never infers processing from an arbitrary
provider event or completed turn.

`tell()` records one TellId and wakes level-triggered. Soul existence and Tell
insertion are one Heart transaction: an unborn address is refused without a
Tell fact, and no orchestration-layer born pre-check duplicates that judge.
Tell admission belongs to the Body timeline, not to a provider Turn, and never
implies that the tell entered the current Turn. Consequently an actionable
pending tell remains in every current snapshot at its original global timeline
position even when it lies outside the open-Turn tail or no Turn is open.
While a Body holds the
leash, wake nudges it to read pending tells at its checkpoint. When its current
Session supports live tell, Body submits pending tells in recorded order and
records the returned acknowledgement. When the actual Session has no `tell`,
Body retires that provider custody and puts down the Body so the successor
launches the unchanged pending Tell. If the adapter reports that the Session
has already ended, Body records no delivery, stops live submission for that
Session, and retains the Tell for successor launch without changing the
terminal turn result. A
fresh or resumed drive carries every pending tell in
`launchTells`; the Session's launch admission supplies only a provider fence.
Body pairs that fence with the immutable
`launchTells` it constructed and atomically records their shared delivery
witness. Asleep and stranded addresses use this
same launch path after a waker takes the leash.

Body pumps the Session's two typed streams independently: events become
activity, while receipts become tell receipt facts. An exact receipt names its
TellId. A fence receipt applies only through the delivered fence-to-TellId
mapping for that same `turnSequence`; an unknown fence is not evidence and writes
nothing. For launch input, Body commits admission and delivery before consuming
receipts. For live tell, the adapter exposes the receipt only after its
acknowledgement resolves, and Body serializes acknowledgement persistence before
receipt consumption continues.
If receipt persistence fails, Body aborts that Session, closes its request pump,
records the turn failure, and terminates the Body; it never continues execution
after losing the durable receipt writer.

Delivery is at-least-once and correlated by TellId, not exactly-once. If a
provider accepts input and the process dies before Heart records its evidence,
the tell remains pending and may be submitted again. Providers that can
deduplicate by TellId may do so; Keiyaku does not promise it. A reboot can kill
Body and waker together, leaving the tell visibly pending until a later wake.
For a live delivery with `receipt: "required"`, absence of a receipt returns the
tell to the replay set when that Body ends; its successor may add another
delivery attempt. A live delivery with `receipt: "unavailable"` is terminal and
never replayed. Launch admission is terminal. Any terminal witness settles the
tell even when another attempt was already admitted; at-least-once permits that
race without rollback. There is no permanently handed-off product state. Kill
does not settle or discard a Tell; a recorded Tell remains pending until a Body
delivers it.

If Heart has a durable resume coordinate but the selected adapter has no
`resume` capability, Body refuses before `start` and exposes the existing
nonterminal stranded state with reason `resume-unsupported`. It never starts
fresh, deletes the coordinate, or creates a recovery machine. Pending tells
remain pending. Every later wake rejudges the same durable coordinate against
the adapter's current method set, so adding resume capability lets ordinary
wake continue.

There is no public `resume` verb. A capable provider can resume a durable native
session when Body starts the next drive; waking remains an input through
`tell`. The verb set is call, of,
listArchetypes, list, status, wait, tell, interrupt, history, fork, and kill.

## Interrupt

`interrupt(body)` is the high-level composition "ask this turn to yield, then
tell". Its sequence is fixed: write pause for the current Body; wait one bounded
response window for that Body to abort its owned session and release the leash;
acquire the leash; require an explicit end for the same Body; in one Heart
transaction clear pause and record the Tell; release the leash; then spawn the
ordinary wake. The old Body can never consume the interrupting Tell.

Pause and stop are separate control kinds. The Body polls pause beside stop,
aborts its drive, records the existing `put-down` Body end, and exits. There is
no public-boundary fallback that signals a described process.

The receipt is a sum because later steps may never lawfully begin:

```ts
type InterruptReceipt =
  | {
      kind: "unavailable";
      evidence: "hung" | "untidy" | "unavailable";
    }
  | {
      kind: "interrupted";
      putDown: "was-idle" | "self-aborted";
      tell: TellResult;
    };
```

`hung` requires the target Body's durable diagnostic that its owned external
provider custody did not retire within the response window. A held leash
without that diagnostic remains `running` and reports `unavailable` here.
`untidy` means the leash is free without the required clean Body end. None of
these results records the interrupting Tell or invents process authority.

`interrupted` is possible only while the interruptor itself holds the leash.
`putDown` states how it acquired that proof: immediately (`was-idle`), after
the Body honored pause (`self-aborted`). It then clears pause and records the
Tell in one transaction.

## Kill

Freeze the latest Body sequence into stop, then wait one response window for
that live Body to abort descendants through capabilities it owns and release
the leash. Only an explicit `put-down` end for that same Body permits the leash
holder to record a kill witness and clear stop. The witness preserves Soul,
session, history, pending Tells, and Body Requests. A later Tell wakes a
successor Body on the retained session; that Body supersedes the killed life
projection.

Synchronous evidence is `killed`, `already-killed`, `already-stopped`, `hung`,
`untidy`, or `unavailable`. `hung` retains the stop request and requires the
target Body's durable failed-custody diagnostic. A held leash without that
diagnostic is unproved and reports `unavailable`. `untidy` reports a free leash
without the required clean Body end. `unavailable` also covers a changed or
otherwise unprovable target. None authorizes external signaling.

Forwarded wait, tell, and kill enter these same local executors after the parent
Heart's single permission decision. Tell uses the upstream request id as TellId;
kill retains the lifecycle evidence above; wait remains observation only. The
forwarding request never becomes a second verb implementation or lifecycle judge.

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
local effect. There is no life-state or abort arm: fork only reads the parent
Heart, so running, asleep, killed, stranded, hung, and untidy sources may all fork
retained history.

Fork is a provider primitive, not something ordinary resume can compose.
`ProviderAdapter` has an optional `fork({ session, at, cwd })` operation. An
adapter without it returns `{ kind: "provider-cannot-fork", provider }`; no
emulation is attempted. The operation has no abort input: once the
upstream provider has made a child session there is no honest cancellation
point that can erase that fact.

The sequence is provider fork first, then ordinary local allocation and birth.
The child's soul copies the parent snapshot except for its id, creation time,
and origin `{ kind: "fork", parent, at }`; no fork override exists. Direct and body-request births retain
their existing arms. Under the birth leash, publication also admits the
provider-created child coordinate as the first `SessionFact`, with the selected
answered turn's provider, cwd, and options recipe. Thus the child is born
asleep with zero turns and its first tell resumes the forked native session.
Upstream success followed by any local allocation, birth, session-admission, or
publication failure returns `{ kind: "upstream-forked", childSession,
diagnostic }`. It is not written into the unchanged parent heart or presented
as a local child. Native adapter fork obligations are owned by
[akuma-provider.md](akuma-provider.md).
Authenticated provider evidence proves that the child transcript retains the
selected prefix and that later parent and child writes do not enter each
other's transcript.
