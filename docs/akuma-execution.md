# Akuma Execution

This chapter owns body execution and the tell, interrupt, kill, and fork lifecycle verbs.

## The body

Wake -> take the leash (checking the seal) -> put down the predecessor ->
write the body row -> resume the provider from the latest session fact
(fresh at `soul.cwd` when none exists) -> pump. The pump is
the whole job: heart rows become provider actions; provider events become
heart rows; body requests become in-process calls.

**Wake is level-triggered.** A waker that finds the leash held does not exit
blind: it nudges the current Body and re-observes, and it may stop only when
the tell that woke it is told, or it takes
the leash itself and serves it. Two wakers converge through the same rule: the
leash serializes replacement Bodies, and the second one finds the work already done.
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

The Body also reads stop control only when it names that Body sequence. It
aborts the drive, records `put-down`, and releases the leash. If the killer
vanishes, the next leash holder first settles the frozen predecessor, writes
its kill witness, and clears stop before creating a successor Body.

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
  fence. The durable correlation key is the current Heart-owned `bodySequence`
  plus that provider fence.
- **receipt** — provider-authored evidence attached without reinterpretation.
  Its kind preserves the provider's terminal evidence; its correlation is an
  exact TellId or shared fence.

```ts
type TellDelivery =
  | { route: "launch"; bodySequence: number; fence: ProviderFence }
  | {
      route: "live";
      bodySequence: number;
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
While a Body holds the
leash, wake nudges it to read pending tells at its checkpoint. When its current
Session supports live tell, Body submits pending tells in recorded order and
records the returned acknowledgement. Otherwise they stay pending until the
turn boundary. If the adapter reports that the Session has already ended,
Body records no delivery, stops live submission for that Session, and retains
the Tell for successor launch without changing the terminal turn result. A
fresh or resumed drive carries every pending tell in
`launchTells`; the Session's launch admission supplies only a provider fence.
Body pairs that fence with the immutable
`launchTells` it constructed and atomically records their shared delivery
witness. Asleep and stranded addresses use this
same launch path after a waker takes the leash.

Body pumps the Session's two typed streams independently: events become
activity, while receipts become tell receipt facts. An exact receipt names its
TellId. A fence receipt applies only through the delivered fence-to-TellId
mapping for that same `bodySequence`; an unknown fence is not evidence and writes
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

`interrupt(body)` is the high-level composition "synchronously put down this
turn, then tell". Its sequence is fixed: write pause; wait one grace window for
the Body to abort and release the leash; if still held, put down the current
verified collar; acquire the leash proving the old Body stopped; in one Heart
transaction clear pause and record the Tell; release the leash; then spawn the
ordinary wake. The old Body can never consume the interrupting Tell.

Pause and stop are separate control kinds. The Body polls pause beside stop,
aborts its drive, records the existing `put-down` body end, and exits. A new
leash holder clears an orphan pause before driving, just as it clears an orphan
stop. Self-abort remains a Body effect; collar fallback remains the
interruptor's public-boundary effect.

The receipt is a sum because later steps may never lawfully begin:

```ts
type InterruptReceipt =
  | {
      kind: "unstoppable";
      evidence: "no-collar" | "collar-unverifiable" | "unavailable"
        | "alive-after-sigkill" | "leash-held-after-put-down";
    }
  | {
      kind: "interrupted";
      putDown: "was-idle" | "self-aborted" | "collar";
      tell: TellResult;
    };
```

`unstoppable` means the interruptor did not obtain the leash within its bounded
windows: no recorded collar, an
unverifiable collar, an unavailable or surviving physical put-down, or a collar
reported gone while the leash still remained held. The pause remains, and no
tell or wake is written. The asynchronous pause signal may still be
observed after this return and cause the body to self-abort; unproven is not
retracted. The next leash holder clears that abandoned pause.

`interrupted` is possible only while the interruptor itself holds the leash.
`putDown` states how it acquired that proof: immediately (`was-idle`), after
the body honored pause (`self-aborted`), or after collar fallback (`collar`). It
then clears pause and records the Tell in one transaction. Physical
killed/already-gone evidence without subsequent leash ownership is
`leash-held-after-put-down`, never success.

## Kill

In one Heart transaction, freeze the latest Body sequence into stop -> grace ->
put down that frozen collar -> acquire the leash -> record a kill witness for
that same sequence and clear stop. A successor that acquires the leash first
must complete the same settlement before creating its Body. The witness preserves
Soul, session, history, pending Tells, and Body Requests. A later Tell wakes a
successor Body on the retained session; that Body supersedes the killed life
projection.

Synchronous evidence has four values: `killed`, `already-killed`,
`alive-after-sigkill`, `unavailable`.

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
Heart, so running, asleep, killed, stranded, and headless sources may all fork
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
diagnostic }`. It is not written into the unchanged parent heart and is not
dressed up as a local child. Claude maps the primitive to native `forkSession`
with the answered turn's session id and outer assistant-message UUID. The SDK
must return a distinct nonblank child session id; a missing source or message
point, native failure, or reused coordinate is `fork-failed`.
Authenticated provider evidence proves that the child transcript retains the
selected prefix and that later parent and child writes do not enter each
other's transcript.
