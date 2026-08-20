# CLI Output

This chapter owns help, rendering, and exit status.

## Shared Akuma Rendering

Status, non-answered waits and calls, tell, interrupt, and kill share one
snapshot renderer; history reuses its row vocabulary without snapshot budgets.
It consumes typed public values only. Answered default call, answered ordinary
single wait, and `history --last` write exact answer bytes; JSON never clips
them.

`show` is a raw Contract read. Text writes the exact guidance Markdown with no
status header or explanatory wrapper. JSON is exactly
`{ "contract": ContractId, "guidance": string }`. Its bytes come from the
workspace renderer owned by [workspace.md](workspace.md); the CLI does not
assemble a second projection. Audit remains unchanged and omits guidance.

`history kei/...` renders the same-snapshot Contract history. Text begins
`history <kei/...> · <J> journal · <D> dispatch`, then orders journal and
Dispatch events by their recorded times. Each row retains the exact kind,
entry or AkuId, actor when present, and decision-relevant fact fields. Equal
times claim no causality. JSON is the exact `ContractHistory`; missing
Contract exits `1`, corruption exits `3`, and success exits `0`. There is no
Contract cursor, pagination, last-event shortcut, section split, or Akuma
history expansion.

## Help

Root help includes:

```text
  nuke [--confirm <WorldRoot>]
    Remove Keiyaku-owned data from one confirmed World.
```

The bare form uses the existing refusal envelope and exit status to print the
exact literal confirmation invocation. It does not suggest repository cleanup
or generic World teardown. JSON is the same typed refusal or execution value.
A confirmation mismatch uses the same envelope and prints one mismatch line
followed by the exact retry command using the resolved WorldRoot.

Each command family owns its help rows. Root help composes those rows;
validation, usage refusal, namespace help, and leaf help read the same syntax,
usage, and purpose values. Only Task remains a namespace.

`--help` is a reserved parser token. After optional `-C`, its presence requests
help for the longest legal command-word prefix even when later tokens are
invalid. Root, namespace, and leaf help render their owning rows; leaf help may
add supplemental guidance or one minimal example. There is no `help` command,
`-h`, per-row flag, or JSON help.

Help writes stdout, exits `0`, reads no stdin or product state, and works
without a Keiyaku world. `-C` is accepted but has no effect.

A syntax refusal renders the deepest reached owner's usage to stderr and exits
`1`. Source-selection and nonblank refusals are the same pre-invocation class.
A bare invocation is refusal; root help renders the same root projection as
successful help.

The adapter chooses actor testimony in this order: explicit nonblank `--actor`,
then `KEIYAKU_ACTOR_ID`, then no actor. Explicit input wins over the
environment. Missing input is a typed usage refusal with one usage line; the
CLI does not prompt.

## Rendering And Exit Status

Plain text is the primary CLI projection. `--json` is a secondary projection
of the same typed value; it never excuses missing or degraded text facts.

After stdin acquisition, external-command or substantial Git work writes one
stderr line: `⧖ preparing keiyaku` for bind, `⧖ delivering`,
`⧖ auditing`, `⧖ reconciling`, or `⧖ installing skills`. It is a start fact,
not progress or durable state. Wait/Akuma observation add none; `--json`
suppresses it.

## Shared Scanner Grammar

Text surfaces share a small scanner grammar, not a shared layout. Renderer words
are lowercase; `·` separates facts on a summary line; evidence is indented by
two spaces; a glyph is paired with its word; and a complete coordinate remains
copyable and is never truncated. Confirmed absence has no placeholder row, while
an observed empty collection is represented by its honest zero. Numeric counts
and ages align to the right when a surface uses columns. These rules are
presentation laws only: they do not add facts to JSON, journal authority, or
read models.

Kanshi alone derives compact age text from each row's source timestamp and the
report's one `observedAt`. It floors nonnegative elapsed time to `Ns` below one
minute, `Nm` below one hour, `Nh` below one day, and `Nd` thereafter; a later
source is `future` and lawful absence is `—`. Contract phase is
`<phase> · <age>` before target facts, and born Akuma life is `<life> · <age>`.
Selected Contract gates retain `<mark> <gate> <age>` detail; world-board gate
slots are age-less. JSON retains the source timestamps and never contains the
derived age.

Bare Kanshi text begins with its first section and uses KEIYAKU, FLEET, TASK in
that order. Each section has a `[ <SECTION> ]  <N> live` header, at most ten
hot-first live rows, and an exact complete or partial footer owned by
[kanshi.md](kanshi.md). It has no aggregate signature, cwd, state coordinate,
or status presentation flag. `--json` retains the complete typed report; the
`keiyaku ls kei/`, `keiyaku ls aku/`, and `keiyaku ls task/` catalogs are the
complete text inspection paths. FLEET remains only a section name, never a
count unit. Other commands start with their operation identity and do not
receive a banner.

Every invocation renders exactly one final plain result object on stdout:

| Kind | Product content | Exit |
| --- | --- | --- |
| `accepted` | closed Contract-mutation union discriminated by literal `bind` \| `amend` \| `deliver` \| `review` \| `arc` \| `abandon` \| `audit`; common envelope plus that verb's flat fields | 0 |
| `refused` | typed refusal and observed grounds | 1 |
| `retry` | exhausted, collision, or publication-failed detail; caller-addressed verbs use the caller's contract coordinate, while bind has no contract segment | 2 |
| `observation` | view data, including observed effects when present | 0 |
| `integration-conflict-materialized` | exact public `IntegrationConflictMaterialized` value: judged `targetHead`, ordered `conflictPaths`, and appointed `workspace` | 0 |

Text and `--json` render this same object. Both write to stdout; JSON serializes
it without another output schema. A corrupted authority or other exception
writes its verbatim diagnostic to stderr and exits `3`.

Akuma text shares that snapshot across the named commands; history remains the
unbounded browsing surface. An idle answered default call or ordinary single
wait writes the exact answer, including empty bytes, with no framing or added
newline. Every other state remains an identity-bearing snapshot, and plural
wait renders each answered member as `✓ came back <AkuId>`, the
snapshot-width ruler, and its exact answer; the collection then ends with
`<done> of <total> done`. Successful detach ends with
`$ keiyaku -C <world> wait <@alias|AkuId> --timeout 5m`, using the successful
Alias or complete AkuId and canonical World; failure adds no command or life.
`said` and `thought` occupy at most two terminal lines with visible clipping.
Text never changes the public JSON value.

Akuma life words are rendered from the public union. Running text is exactly
`● STILL RUNNING`; other words keep their public spellings. `hung` means the
latest Body durably recorded provider custody that did not retire; a public
timeout with only a held leash remains `running`. `untidy` means the leash is
free but the latest Body has no explicit end. Both use the conservative `?`
mark. Mutation renderers preserve `hung`, `untidy`, and `unavailable` evidence
and return failure status without inventing an external termination attempt.

Snapshot omission is positional: every typed snapshot gap renders as
`      ⋮ N omitted` at its actual break between visible rows, with the vertical
ellipsis in the glyph column, and the gap counts sum to the typed `omitted`
total. History retains its own cursor and loss metadata and does not
reinterpret snapshot gaps. Text is clipped by terminal display width without
splitting grapheme clusters. A `run` command remains one row and preserves
recognizable head and tail when clipped; the completed outcome is omitted
before the command subject is lost. A cue and ellipsis alone are not a
subject. Every timeline rendered line fits the requested display width. Mutation
receipt opaque tokens may physically exceed it when indivisibility requires.
Display-only transport unwrapping does not change persisted command
bytes or timeline layout. The five-column gutter prints `HH:MM` on the first
visible event and when its displayed minute changes; otherwise it stays blank.
One space follows the gutter, then the semantic glyph, one space, then a fixed
verb field sufficient for `say`, `think`, `note`, `tell`, and tool labels; body
text begins at one stable column. Say, think, tell, and answered-outcome bodies
are wrapped in `U+201C`/`U+201D`; tool, note, call, and error bodies are not.
A wrapped body line places a vertical bar in the glyph column and aligns its
body with the first line's body. Event glyphs
remain: ordinary voice, note, and told rows use `│`, completed success uses
`✓`, completed failure uses `!`, active tool uses `⧖`, pending tell uses `⧗`,
unsettled tool uses `?`, and continuation uses `│`. There is no aggregate
omission token on the first row, standalone minute divider, second rule
between relation and activity, or changed snapshot selection. One `fileChange`
with one `unspecified` change renders as `edit` with its path.

```text
aku/expert-akuma/5659b10d (@expert)
─────
└─ kei/make-non-git-runtime-observation-honestly-async
      ⋮ 171 omitted
14:36 │ say    “I’m editing the architecture allowlist to mirror the completed-”
      │        “migration: synchronous filesystem authority remains only in the two documented…”
      ⋮ 17 omitted
14:46 │ think  “The migrated Heart and Body slices now pass except one real-”
      │        “async race exposed by the new boundary…”
14:47 ✓ run    $ npm run test:focused — ok
      ! run    $ npm test — failed
      ⋮ 11 omitted
14:49 ✓ run    $ npm test — ok
      ⧗ tell   “Please also inspect the termination path.”
14:50 ⧖ run    $ npm run test:focused
tasks 2
  ● task/repair-maintainability-limit · Repair maintainability parameter limit · in_progress · P0
  ‖ task/restore-nuke-fixture · Restore Nuke fixture API · blocked · P1
changes 15
  +3 -2    /tmp/keiyaku-integration.uAA0a9/repo/tests/nuke.test.ts
  +15 -10  /Users/astrosheep/Developer/keiyaku-v4/.git/keiyaku/wt/valhalla/src/cli/invoke.ts
  +10 -10  /tmp/keiyaku-integration.uAA0a9/repo/src/cli/invoke.ts
  ⋮ 10 earlier changes

● STILL RUNNING
```

The identity and optional alias occupy the first line. The next line is the
five-column `U+2500` ruler, exactly as wide as `HH:MM`; it marks the boundary
between identity and the rest of the snapshot. When a Contract is associated,
its complete `kei/...` coordinate follows on the separate hanging relation line
beginning with `U+2514` and `U+2500`; an unassociated Akuma omits that line.
Identity rows never contain current life.
Activity follows the identity and optional relation directly, keeping typed
gaps in persisted order. Created Task context, when supplied, follows the
timeline; the reported-change block follows Tasks. Status, wait, unfinished
observed call, and kill then place life last: one blank line, then a top-level
life line. Ordinary and interrupt tell output and history omit life. Running
life is exactly `● STILL RUNNING`; an asleep Akuma renders as `✓ came back`,
`× killed`, `? stranded`, `? hung`, and `? untidy`.

A present created Task observation renders:

```text
tasks <N>
  <mark> <complete TaskId> · <title> · <disposition> · P<n>
```

Each Task is one logical row indented two spaces: existing disposition mark,
complete TaskId, title, disposition, and priority. Titles may wrap with a
four-space continuation. Complete TaskIds never truncate. The renderer invents
no Contract relation, `unbound` word, or blocker line. Zero matches render
`tasks 0`; failure renders `! tasks failed <diagnostic>`. Absent Task context
adds no block.

Reported changes keep the typed operation count `shown + omitted` and group
visible operations by exact path in first-visible order:

```text
changes <N>
  +N -N    <complete path>
  ⋮ N earlier changes
```

Statistics form a fixed left column. Complete grouped diffstats sum to `+N -N`;
any missing diffstat in the group renders `+? -?`. Paths are never truncated
and may exceed the terminal width. The omitted line stays indented two spaces
and keeps the typed `reportedChangesOmitted` value. JSON and the public
snapshot retain every repeated operation; aggregation is text-only. Empty
summaries print `changes 0`. Neither block consumes the timeline budget. Raw
answered wait/call, history, and compact FLEET remain unchanged. Renderers
perform no Task, Heart, or Dispatch lookup. JSON values, timeline semantics,
and history model remain unchanged.

Post-admission physical or settlement failures remain inside the accepted
object as typed lags. Text and JSON expose them without changing the Contract
fact, command kind, or exit status. The adapter never hides the existing
Contract or automatically abandons it.

Accepted Contract mutation results are one flat closed union discriminated by
`bind`, `amend`, `deliver`, `review`, `arc`, `abandon`, and `audit`; reconcile
remains an observation. The common envelope carries `kind`, `verb`, `contract`,
non-null `head`, `facts`, `effects`, `settlement`, and optional nonempty `lag`.
Verb fields remain flat: bind
requires `target` and exactly one Region answer (`overlaps` or
`overlapFailure`); amend requires `diff`, including the empty string, and
that same Region answer; deliver and review may carry the same optional
`completion`, `verification`, `verificationReuse`, `verificationSummary`,
`placement`, `cleanup`, and `leak` fields, while review additionally carries
its `verdict` and optional `workspace`; arc and abandon carry no
verb-specific field; audit requires `report` and alone may carry its
top-level `cleanup` and `leak`. An arm cannot carry another arm's fields.
JSON remains that same flat value; there is no payload envelope, second
schema, or compatibility arm.

The renderer is a pure exhaustive projection over `InvocationResult`; it
invents no fields, rereads no authority, and does not change exit semantics.
JSON serializes that same public value.

Accepted deliver and review results may carry the typed final `completion`:
`{ integration: SnapshotId, verification?: { mode: "ran" | "reused", verdict:
"satisfied" | "unsatisfied" } }`. It exists only for an accepted placement;
the nested Verification is absent when no declaration applied. The renderer
projects this value directly and never reconstructs a target from facts or
folded state.

When accepted facts contain `reintegrated`, delivery and review text show one
neutral `~ target moved · re-integrated x<N>` deviation, where N is the count
of those facts. The final target line is projected only from `completion` and
includes `· verified (ran|reused)` only for a satisfied nested Verification;
no-declaration completion has no `verified` word, while an unsatisfied nested
Verification adds `! verification unsatisfied (ran|reused)` and its existing
bounded summary when present. Every `reintegrated` journal row retains
`predecessor -> snapshot`. A repeated movement stop shows its integrated
snapshot, observed target, and numeric attempts; the renderer does not infer
these values from history.

An accepted mutation receipt answers the caller's verb-specific question, not
whether Protocol admitted an entry. Its first line names the world change made
by that verb and the Contract identity. Decision-relevant consequences follow;
the exact mechanical record is last. The renderer uses only typed fields on the
invocation result. It never rereads authority, parses prose, or infers state
from a missing effect.

```text
✓ bound — <complete kei/...>
✓ terms replaced — <complete kei/...>
✓ delivered — <complete kei/...>
✓ deliver — not complete — <complete kei/...>
✓ review <satisfied|unsatisfied> — <complete|not complete> — <complete kei/...>
✓ chapter recorded — <complete kei/...>
✓ abandoned — <complete kei/...>
✓ audit — <complete kei/...>

  record
    journal <entry> · <kind>
    head <ContractHead>

  target -> <SnapshotId> [· verified (ran|reused)]
! verification unsatisfied (ran|reused)
! completion blocked · <typed reason and exact scalar facts>
~ workspace <N files changed, N insertions(+), N deletions(-)>
  staged <complete path>
~ overlap <warning or witness>
terms diff

<exact diff bytes>


! <verb> refused
! <refusal kind and exact scalar facts>
! <one exact collection member per row>

? <verb> retry — <complete kei/... when present>
? <retry kind and exact diagnostic facts>
```

A prerequisite completion stop is one completion row followed by the received
public collection in its existing order:

```text
! completion blocked · prerequisites-unsatisfied
  prerequisite <complete kei/...> · <missing|active|abandoned>
```

The renderer prints each typed `unmet` member exactly once. It does not read
the board, inspect a Contract, or derive a lifecycle category; JSON serializes
that same public collection unchanged.

Bind reports its typed workspace coordinate and optional target; a missing
target renders `no target`. Amend places the exact `terms diff` immediately
after its first line because the diff is its product answer, not mechanical
record. Deliver and review are complete exactly when their typed `completion`
exists, which is the final placement answer. Otherwise each says `candidate
kept`, reports any typed Verification stop, and names the typed completion stop
without exposing the internal `placement` channel name. A claimed result with
Verification satisfied renders `target -> <integration> · verified (ran|reused)`;
without an applicable declaration it renders `target -> <integration>`; an
unsatisfied non-gating Verification renders the target followed by its typed
unsatisfied row and bounded summary. Movement adds only the neutral deviation
row. Review's first line includes its admitted review verdict and completion
state without a second Contract-status row. Arc reports its typed sequence and
title as `chapter <N> · <title>`.
Abandon reports its optional note and only the explicit workspace and recovery
snapshot effects that occurred. Audit reports candidate, Verification, and
target observations without describing the candidate as accepted or approved.

The primary UI does not use `accepted`, `admitted`, `recorded` as an admission
synonym, `placement`, `claim`, `stopped`, `mutation`, or an internal result-arm
name. Journal kinds retain their exact names only inside the record. The clear
domain words `verification`, `target`, `workspace`, `testimony`, `terms`, and
`candidate` remain available. Refused and retry glyphs and exit semantics do not
change.

The record contains every admitted fact identity, head, Git effect, settlement
action and lag. Fact data needed by the first screen is projected into a named
verb field: bind workspace, deliver and review attestation verdict, arc sequence
and title, and abandon note. Shared facts remain identity-only; the adapter does
not expose a generic JournalEntry-data dump. Changed effects precede unchanged
confirmations. Audit text shows admitted testimony but does not fall through to
unrelated reconciliation effects or settlement actions.

An abandonment recovery effect renders
`✓ recovery-snapshot created <SnapshotId> ephemeral`. The word `ephemeral` is
literal: the snapshot has no ref or durable fact and may already be unavailable
after repository garbage collection.

An opaque Contract ID, entry, ref, path, hash, diagnostic, or diff coordinate
is indivisible. The renderer never inserts bytes, whitespace, ellipses, or a
line break inside it. If a token does not fit after its row label, it is emitted
complete on its own continuation line; if that token itself exceeds the
terminal width, physical overflow is accepted rather than splitting it. A
multi-line opaque payload is introduced by one row label, followed by one blank
line, the exact original bytes, and one blank line. No fence glyph, indentation,
trimming, or normalization is added to the payload.

A completed nonempty Region observation groups a repeated identical ordered
witness set once beneath an explicit list of every participating Contract. The
counts are derived checks: every complete Contract ID and every exact
`mine ~ theirs` pair remains visible. Nonidentical sets remain beneath their
own complete Contract ID. Overlap uses the neutral Region relation mark and
never changes accepted into refused. An incomplete observation is one
`~ overlap unavailable` block with the verbatim diagnostic. An empty completed
observation renders no overlap block. JSON exposes the same `overlaps` or
`overlapFailure` property.

Document diff is labeled, then the exact public content, including an empty
string. The CLI never computes another diff or makes availability a lifecycle
decision. Audit omits diff unless `--diff` is present. That flag keeps the
public value only on `report.candidate.diff`; text consumes that report-owned
value exactly once, including an empty string, and never adds a second
top-level `diff`. The accepted audit renderer owns the complete receipt. After
the invocation line the required order is candidate,
verification, target. Workspace is subordinate evidence under candidate, not
a row before it. Ready identity uses `tender=`, `integration=`, and `change=`.
Recorded delivery evidence is `delivery change=<id>` with its relation.
Verification `summary` is a subordinate bounded payload, not inline. Each
answer uses the existing glyph vocabulary. `--json` retains the complete typed
mutation result. Deliver and review text make the nested `completion`
Verification mode and verdict visible when present; `verificationReuse` remains
available as a typed non-final attestation detail.
For terminal Verification, audit renders the complete already-producer-bounded
`summary` with the receipt payload grammar: its original bytes and line
structure remain intact, with no parsing, whitespace collapse, or second
truncation. It omits that payload only when the public summary is absent. Audit
text does not inspect journal entries or raw process output.

The flat `lag` array remains the public `ReconcileResult` shape defined in
[git-reconciliation.md](git-reconciliation.md). JSON exposes that same array.
An `unsealed-bytes` or `target-checkout-retained` lag does not turn an accepted
result into a refusal or alter its exit status.

A dirty-workspace refusal uses the refused header, then the refusal kind,
classified path collections, Git shortstat wording from the public counts, and
authorization option. The option is unavailable exactly when dirty submodule
internals are present. JSON carries the same refusal facts plus the CLI-owned
option projection. The renderer does not run Git or infer another path
classification.

An `unmerged-paths` refusal uses the refused header, then its kind and one
complete path per row. JSON exposes that same public value.

A deliver `integration-failed` conflict refusal exposes `reason`, `targetHead`,
ordered `conflictPaths`, and both recovery values in text and JSON. Plain text
labels them `recovery materialize conflicts · deliver --materialize-conflict`
and `recovery continue after resolve and commit · deliver`; both labels read
the typed recovery values without reconstructing invocation arguments.
`merge-state-present` exposes the appointed workspace kind and path.
`integration-conflict-materialized` is not a refusal: JSON is the exact public
value, text names that kind, `targetHead`, `conflictPaths`, and workspace, and
the process exits `0`.

An accepted review that observed ordinary dirty workspace bytes hangs one
`~ workspace` shortstat line and one evidence row per nonempty classification
in public collection order. Empty classifications are omitted. A path present
in staged and unstaged appears in both. A clean review has no workspace block.
The block names uncommitted bytes sealed into the review ChangeId. It has no
authorization option because review observes a projection. Dirty submodule
internals still refuse before review admission. The same shortstat wording is
used in dirty-workspace refused text. Neither surface uses `files=`,
`insertions=`, `deletions=`, or invented porcelain XY codes.

The glyph column is the only lightweight grouping: `!` is an unresolved
obligation, `~` is a neutral deviation, and record rows keep their existing
low-weight, changed, and unchanged marks. There are no section headings or
decorative blank-line groups.

Each stop is independent: Verification never suppresses the placement attempt,
and one accepted invocation may render both a `! verification` row and a
`! claim` row. An environment
failure keeps its command index and typed command failure in the obligation row.
A declaration timeout is an unsatisfied attestation fact, not a stop. A failed
scratch destroy command renders as an unresolved cleanup obligation without
claiming that the worktree remains. A leak row reports a disposable Verification
worktree that could not be removed after admission; it does not change the
accepted exit status and is not a repair command.
Region reads render one row per declaration, decisive overlap pair, or path
match. Empty arrays render no rows; a failed Region section renders one
`region failed <diagnostic>` row. JSON carries the same Kanshi `Section` value,
with no actual touched paths, Git conflicts, ownership, or action advice. A
Region read is an observation, so both present and failed sections exit `0`;
the failure remains visible in the typed/text value rather than being mapped to
the mutation retry status.
