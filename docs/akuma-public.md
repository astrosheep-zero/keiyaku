# Akuma Public Surface

This chapter owns Akuma public handles, status, wait, history, and fleet values.

## Public surface

```ts
const world = Akuma.of(root, settings?); // root is already resolved; no climbing

const a = await world.call({ archetype, body, cwd? }); // returns after birth
world.of({ id });
world.listArchetypes();                    // canonical names in byte order
world.list();                              // compact fleet rows; no history scan

a.id                                       // aku/<archetype>/<hex8>
a.status()                                 // current state + bounded activity
a.wait(predicate?, { timeoutMs? })         // same status carrier on either outcome
a.history({ before?, since?, limit? })      // persistent execution-history page
a.tell(body)                               // typed mutation result
a.interrupt(body)                         // synchronous put-down, then tell
a.fork({ at: historyId })                 // exact retained native fork point
a.kill()                                   // evidence: four values
```

A rerouted call that reaches a terminal non-served request throws
`AkumaBodyRequestError`. Its closed fields are `kind: "akuma-body-request"`,
`outcome: "refused" | "voided"`, and the terminal `diagnostic`. Direct-call
errors retain their existing types; Body Requests do not wrap them before
heart admission.

`status()` is a watch on one living Akuma: leash and collar probes, the newest
retained turn, and one activity snapshot. It is not a fleet row and does not
extend, embed, or inherit `AkumaListRow`. Its shape is:

```ts
type AkumaStatus = {
  id: AkuId;
  life: AkumaLife;
  collar: CollarProbe;
  answer?: string;
  answerHistoryId?: string;
  failure?: string;
  outcomeAt?: string;
  activity: ActivitySnapshot;
  strandedReason?: "resume-unsupported";
};

type ActivitySnapshot = {
  entries: readonly (
    | { kind: "row"; row: ActivityRow }
    | { kind: "gap"; count: number }
  )[];
  lowestRetained: number | null;
  highest: number | null;
};

type TellAdmission = {
  tellId: TellId;
  fact: "recorded";
};

type TellResult = {
  admission: TellAdmission;
  wake: "spawned" | { kind: "failed"; diagnostic: string };
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
  | { kind: "said"; sequence: number; bodySequence: number; at: string; text: string; truncated?: true }
  | { kind: "thought"; sequence: number; bodySequence: number; at: string; text: string; truncated?: true }
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
      truncated?: true;
    }
  | { kind: "note"; sequence: number; bodySequence: number; at: string; text: string; truncated?: true }
  | {
      kind: "tell";
      sequence: number;
      at: string;
      tellId: TellId;
      text: string;
      state: "pending" | "told";
    };
```

`tell(body)` returns one typed mutation result: the allocated TellId, its
recorded Heart admission, and whether the level-triggered waker was spawned. It
does not imply delivery, provider observation, or turn entry. Delivery and
provider receipts fold into ordinary Akuma observation as one `pending` or
`told` tell row at the admission's original timeline position. Pending tell
rows are pinned outside snapshot budgets because they can still change the
caller's action; settled tell rows share the ordinary activity budget. Text and
JSON expose the same two-state row and no provider fence, five-stage
lifecycle, or stage timeline. Tell
rows are the sole detailed public tell projection; `AkumaStatus` carries no
pending-ID collection, description, Archetype name, or confinement. Those stay
on the fleet row, the identity, or the soul. There
is no separate public TellId browsing workflow. A global `status()` value is
useful context but is not a mutation receipt and cannot alter this result.

`strandedReason: "resume-unsupported"` appears when a durable native coordinate
exists but the selected adapter lacks resume. The coordinate and pending tells
remain intact; status does not suggest or perform a fresh start.

`wait(predicate?, options?)` polls `status()` and returns the first complete
`AkumaStatus` accepted by the predicate. Its default predicate is
`status.life !== "running"`. `options.timeoutMs`, when present, is a
nonnegative millisecond duration. If it arrives first, `wait` returns the
current `AkumaStatus`; it adds no timeout arm or flag. The caller can reapply
its predicate to the returned observation. One status read prevents a torn
timeout result assembled from separate liveness and snapshot observations.
`wait` does not promise that every recorded tell was delivered: a crash can
kill body and waker together and legitimately leave tells pending.

`history()` is the sole public execution-history read. It returns one stable
activity page plus the completed-turn facts whose bodies occur in that page;
the read model, not Heart or the CLI, owns that join. Cursor coordinates are
persisted activity sequences. `before` and `since` are exclusive and mutually
exclusive. Status and wait never carry a full history page. The final answer
is not activity text: the explicit last-answer read selects the last answered
`TurnFact` by durable sequence. The handle returns `{ kind: "answer", answer }`
or `{ kind: "no-answer" }`; an empty answered string stays in the answer arm.
CLI `history --last` writes exact answer bytes.

An akuma that answered and whose latest Body was later killed reports both:
`life: "killed"` with the retained answer still attached. What to do about a
stranded or headless
akuma is the flagship's decision; the surface puts the state and available
verbs in front of her and says nothing more.

`list()` is the compact fleet scan, not a smaller `status()`. Born fleet rows expose id,
Archetype and description snapshots, life, collar evidence,
confinement, and pending tell count, but no activity, history, or latest outcome. The public
types share `id`, `life`, and `collar` by coincidence, not by inheritance. The id is
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
Provider observation is defined in [akuma-provider.md](akuma-provider.md); this
public surface does not reinterpret native events. Package-root selector and
cross-product composition are owned by [public-akuma.md](public-akuma.md), CLI
grammar and rendering by [cli.md](cli.md), and Kanshi composition by
[kanshi.md](kanshi.md).
