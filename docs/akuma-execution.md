# Akuma Execution

This chapter owns body execution and the tell, interrupt, kill, and fork lifecycle verbs.

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

Four facts, at-least-once; the provider deduplicates:

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
waking means new input through `tell`. The verb set is call, of,
listArchetypes, list, status, wait, tell, interrupt, history, fork, and kill.

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

Synchronous evidence has four values: `killed`,
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
