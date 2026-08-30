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

The bare form uses the existing refusal envelope and exit status to print the
exact literal confirmation invocation. JSON is the same typed refusal or
execution value.
A confirmation mismatch uses the same envelope and prints one mismatch line
followed by the exact retry command using the resolved WorldRoot.

Each command family owns its help rows. Root help composes those rows;
validation, usage refusal, namespace help, and leaf help read the same syntax,
usage, and purpose values. Only Task remains a namespace.

Root help is a compact index grouped around the three product pillars, with
repository-level utilities kept separate. Each row carries only the command
name and its owner-provided purpose. Leaf help is self-contained, cites no
repository-internal documentation, and carries complete command usage. The
fork usage documents both complete AkuIds and world-local `@alias` selectors.
Contract history has no pagination controls; those flags remain
Akuma-history-only refusals.

`--help` is a reserved parser token. After optional `-C`, its presence requests
help for the longest legal command-word prefix even when later tokens are
invalid. Root and namespace help render each spec's usage and purpose. Leaf help
renders the same spec's purpose, usage, and optional opaque details text owned by
that spec. There is no `help` command,
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

For status rows, ANSI tone is a TTY-only emphasis on the leading glyph, never
a new status fact; existing section-failure text remains alert. Alert is red
and takes precedence for Contract error or unavailable observation, and
stillborn, hung, or stranded Akuma.
Attention is yellow for a non-alert tendered Contract whose phase is at least
15 minutes old, or a waiting/bound Contract whose phase is at least one hour
old. Recent is green when no stronger tone applies and the latest Contract
journal or running Akuma life/activity timestamp is no more than five minutes
old. Killed Akuma are dim; an asleep Akuma is recent for five minutes after its
latest life or activity timestamp and dim afterward. Other rows are unstyled.

Age is derived only from the row timestamp and the report's producer-sampled
`observedAt`; a future timestamp is `now`. Tone never changes text, ordering,
width, glyph vocabulary, exit status, or typed values. When color is disabled,
including `NO_COLOR`, the emitted bytes are exactly the existing uncolored
projection. JSON, journals, Heart, Kanshi, and persisted authority carry no
tone, threshold, urgency, or ANSI fact.

The first-party Pi extension is a second window over the Kanshi report. Its
resident widget is only a compact count summary; `/keiyaku` opens the existing
world-status text projection in an overlay. It reads through the CLI surface,
adds no facts or verbs, owns no lifecycle decision, and never presents a
second authority. The widget and overlay use the same observation boundaries
and keep section failure, absence, identity, and activity text as returned by
Kanshi. A refresh is a new read, not persisted extension state.
Resident refresh is best-effort background work: it never delays Pi session
startup or an agent turn, and refresh failure never escapes into Pi lifecycle.

Kanshi text is a pure projection of its typed report. Bare world status opens
with `契 KEIYAKU // WORLD`, then uses `CONTRACTS`, `AKUMA`, and `TASKS` headers
with scoped objective counts. Contract rows are natural-flow decision summaries
with complete identity, age, title, blockers, edges, gate states, and target
facts; linked Akuma are represented by one compact summary, while complete
identities remain in AKUMA and selected Contract detail. Candidate
existence starts the candidate/target fact line as `candidate` or `no candidate`;
gate glyphs stay beside gate names, and stale gates append `(stale)`. Fleet remains
the bounded Akuma activity surface. `keiyaku ls kei/` is the pure active
Contract catalog: it keeps the relevant Contract facts without Task or Akuma joins,
candidate coordinates, or workspace and merge internals. Named Contract status renders only the selected Contract. A multi-selector
status renders one selected Contract or Akuma projection per input selector in
input order; JSON exposes those entries as an ordered array.
using lowercase semantic blocks for `after`, `dependents`, `gates`,
`candidate/integration`, `target`, `workspace/merge`, `attachments`, and
`namespace tasks`. Git object IDs use the existing unique-prefix primitive;
Contract, Change, Task, and Akuma identities remain complete.

The catalog of available Akuma is headed `available Akuma <N>`; it lists names
that can be called, not Akuma instances. The instance selector renders a
bounded text view headed `akuma instances <returned> of <total> known`; relative ages are
derived against the list's producer-sampled `observedAt` fact. A partial
unscoped view exposes the exact `keiyaku ls "aku/*/*"` recovery command, while
a scoped view preserves its `aku/<akuma>/` selector. JSON remains the
complete catalog with exact timestamps and full rows.

World and catalog Contract attachments show all non-terminal Akuma, or only the
most recent terminal attachment when none are non-terminal. Selected Contract
status shows every attached Akuma, including terminal retry history.

Fleet activity text is bounded presentation only: a visible latest semantic
activity or idle outcome renders as one safe-text-normalized physical line,
`activity "<bounded text>"`, clipped to the requested display width. The
durable ActivitySnapshot, its retention, and JSON values are unchanged. A row
without a latest activity or idle outcome omits the activity text.

After stdin acquisition, external-command or substantial Git work writes one
stderr line: `⧖ preparing keiyaku` for bind, `⧖ delivering`,
`⧖ auditing`, `⧖ reconciling`, or `⧖ installing harness integrations`. It is a start fact,
not progress or durable state. Wait/Akuma observation add none; `--json`
suppresses it.

The final write boundary terminates each complete ordinary stdout or stderr
message with exactly one trailing LF. It adds `\n` when the rendered bytes omit
it and does not add another when they already end with one. Help, usage,
catalogs, guidance, status, observation, receipts, diagnostics, JSON, and
successful or refused text all take this terminator. JSON values, renderer
return values, library results, persisted facts, provider bytes, and the
guidance Markdown itself are unchanged; the terminator applies only at emit.

Answered default `call`, answered ordinary single `wait`, and `history --last`
write retained answer bytes unchanged, including empty answers and answers that
do not end with `\n`. Those three paths receive no framing newline. JSON for
the same reads remains ordinary and is LF-terminated. With no retained answer,
`history --last` remains ordinary text. Exact Akuma history selected by
`--id` writes only the complete retained answer or diagnostic; JSON exposes the
selected outcome and its single Heart-owned `historyId`, never provider-native
coordinates.

## Shared Scanner Grammar

Tell delivery state is rendered once on its timeline row: a told row is `✓ told`
with its body, while a pending row is `⧗ tell`. Held and pursuing receipts add
no wake fact. A failed receipt emits exactly one loud `! tell delivery failed ·
<diagnostic>` fact; child evidence appends its factual shared run-log path and
byte range without calling those bytes stderr. Ordinary Tell exits 0 for
`told`, `pursuing`, and `held`, and 2 for `failed`; JSON remains the typed
result. There is no separate pending-tells summary.

Kill receipts keep the identity header and life result but render at most the
single newest activity row from the observed timeline. They do not render an
activity gap, pending-Tell summary, task or change blocks, or a separate
`kill <evidence>` fact; the final result line is the sole kill evidence carrier:
`✓ killed`, `✓ already killed`, `✓ already stopped`, `! not killed · hung`,
`! not killed · untidy`, or `! not killed · unavailable`.

Text uses lowercase words, `·` fact separators, indented evidence, complete
coordinates, and honest empty results; these presentation rules add no facts.

Final plain results are:

| Kind                                | Product content                                                                                                                                                                   | Exit |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `accepted`                          | closed Contract-mutation union discriminated by literal `bind` \| `amend` \| `deliver` \| `review` \| `arc` \| `abandon` \| `audit`; common envelope plus that verb's flat fields | 0    |
| `refused`                           | typed refusal and observed grounds                                                                                                                                                | 1    |
| `retry`                             | exhausted, collision, or publication-failed detail; caller-addressed verbs use the caller's contract coordinate, while bind has no contract segment                               | 2    |
| `observation`                       | view data, including observed effects when present                                                                                                                                | 0    |
| `integration-conflict-materialized` | exact public `IntegrationConflictMaterialized` value: judged `targetHead`, ordered `conflictPaths`, and appointed `workspace`                                                     | 0    |

World `reconcile` remains this observation kind. JSON places the public
`RepoReconcileReport` under `report` and never copies that report's
discriminant onto the envelope. Completed text keeps the existing observation
rendering, including `contracts: []`. `world-observation-failed` writes exactly
`reconcile: world observation failed · <diagnostic>` and exits `1`; it does
not render an empty successful board or a synthetic Contract row.

Text and `--json` render this same object. Both write to stdout; JSON serializes
it without another output schema. A corrupted authority or other exception
writes its verbatim diagnostic to stderr and exits `3`.

Akuma text shares that snapshot across the named commands; history remains the
unbounded browsing surface. An idle answered default call or ordinary single
wait writes the exact answer, including empty bytes, with no framing or added
newline. Every other state remains an identity-bearing snapshot, and plural
wait renders each answered member as `✓ came back <AkuId>`, the fixed twelve-
character ruler, and its exact answer, followed by its `tasks` and
`changes` blocks; the collection then ends with
`<done> of <total> done`. Successful detach ends with
`$ keiyaku -C <world> wait <@alias|AkuId> --timeout 5m`, using the successful
Alias or complete AkuId and canonical World; failure adds no command or life.
`said` and `thought` occupy at most two terminal lines with visible clipping.
Akuma life words are rendered from the public union. Running text is exactly
`● STILL RUNNING`; other words keep their public spellings. `hung` means the
latest Body durably recorded provider custody that did not retire; a public
timeout with only a held leash remains `running`. `untidy` means the leash is
free but the latest Body has no explicit end. Both use the conservative `?`
mark. Mutation renderers preserve `hung`, `untidy`, and `unavailable` evidence
and return failure status without inventing an external termination attempt.

Snapshot gaps remain positional (`⋮ N omitted`) and history keeps its own loss
metadata. Timeline text fits the requested width without splitting graphemes;
opaque receipt coordinates remain complete even when they overflow. Gutter,
glyph, wrapping, and life vocabulary are presentation rules; JSON and persisted
bytes are unchanged.

Kill text keeps only the identity header, the newest retained non-turn activity
row by persisted sequence (when present), and one final result line: `✓ killed`,
`✓ already killed`, `✓ already stopped`, or `! not killed · <evidence>`. It omits
timeline gaps, older rows, pending-Tell summaries, tasks, reported changes, and
the separate `kill <evidence>` fact. Typed kill JSON, observation selection,
Tell rendering, persisted facts, and exit status are unchanged.

Identity and relation precede activity. Created Task context and reported
changes follow the timeline; life is last where observed. Exact-answer reads
remain raw. Running life is `● STILL RUNNING`; other public life words remain
unchanged.

A present created Task observation renders:

```text
tasks <N>
  <mark> <complete TaskId> · <title> · <disposition> · P<n>
```

Each Task row retains its complete identity, title, disposition, and priority;
zero and failed observations render their typed empty or failure forms.

Reported changes keep the typed operation count and group visible operations by
exact path in first-visible order:

```text
changes <N>
  +N -N    <complete path>
  ⋮ N earlier changes
```

Paths remain complete, missing stats use `+? -?`, and JSON retains every
repeated operation. Empty summaries print `changes 0`; these blocks do not
consume the timeline budget.

Post-admission physical or settlement failures remain typed lags and do not
change the Contract fact, command kind, or exit status.

Accepted Contract mutation results remain one flat typed value per verb, with
their public fields and lag facts preserved. Reconcile remains an observation;
there is no payload envelope, second schema, or compatibility arm.

The renderer is a pure exhaustive projection over `InvocationResult`; it
invents no fields, rereads no authority, and does not change exit semantics.
JSON serializes that same public value.

Deliver and review project typed `completion` directly: its integration and
optional Verification verdict determine the target line. Movement is one
neutral deviation; unsatisfied Verification and dependent continuation stops
remain visible with their typed summaries. A `target-moved` stop also exposes
`content=identical` when `observedTreeEqualsCandidate` is true; this is a fact,
not a claim, acceptance label, or command directive. No target or state is
reconstructed.

An accepted receipt answers its verb-specific question: identity and
decision-relevant consequences precede the mechanical record. Rendering uses
typed invocation fields only and never rereads authority.

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
✓ continuation complete <complete kei/...>
! verification unsatisfied (ran|reused) · not required by Contract gates
! <direct Verification or placement cause and exact scalar facts>
! <complete dependent ContractId> · <direct placement cause>
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

A direct prerequisite stop is followed by the received public collection in
its existing order:

```text
! prerequisites unsatisfied
  prerequisite <complete kei/...> · <missing|active|abandoned>
```

The renderer prints each typed `unmet` member exactly once. It does not read
the board, inspect a Contract, or derive a lifecycle category; JSON serializes
that same public collection unchanged.

A direct gate stop projects the exact reports supplied by placement, in their
typed order:

```text
! gates unsatisfied
  gate <gate> · unsatisfied · at=<timestamp>
  summary <gate>

<exact bounded summary bytes>

  gate <gate> · stale · prior=<satisfied|unsatisfied>
  gate <gate> · missing
```

Only the applicable gate rows render. An attested-unsatisfied row includes its
typed entry timestamp once. The summary uses the ordinary opaque payload grammar
once; gate tokens and payload bytes remain opaque. Text never reads a Contract,
status, journal, Git, or gate evidence to derive these rows.

A direct `checkout-not-followable` stop renders exactly this typed-refusal
block:

```text
! checkout-not-followable
  checkout: <opaque-checkout-path>
  target: <opaque-target-ref>
  reason: <staged|conflict|untracked>
  paths:
    - "<escaped exact path>"
```

Paths stay in their typed order, each quoted and escaped; an empty collection
renders exactly `  paths: (none)` with no list items. This renderer performs no
Git or filesystem read and JSON preserves the original refusal unchanged.
A stopped continuation precedes that unchanged block with
`! continuation <complete kei/...>` so its dependent identity remains visible;
the context row is not a second cause.

Bind reports its typed workspace coordinate and optional target; a missing
target renders `no target`. Amend places the exact `terms diff` immediately
after its first line because the diff is its product answer, not mechanical
record. Deliver and review are complete exactly when their typed `completion`
exists, which is the final placement answer. Otherwise each projects its typed
Verification or placement stop directly, then says `candidate kept`, without
exposing the internal `placement` channel name or a generic blocked wrapper. A
claimed result with Verification satisfied renders `target -> <integration> · verified (ran|reused)`;
without an applicable declaration it renders `target -> <integration>`; an
unsatisfied non-gating Verification renders the target followed by its typed
unsatisfied row and bounded summary. Movement adds only the neutral deviation
row. Review's first line includes its admitted review verdict and completion
state without a second Contract-status row. A stopped continuation projects the
same direct placement cause after its complete dependent ContractId; an
`already-terminal` continuation projects directly. The journal's `claimed` word
remains in the record only. Arc reports its typed sequence and
title as `chapter <N> · <title>`.
Abandon reports its optional note and the one recovery snapshot coordinate when
cleanup created one. Audit reports candidate, Verification, and
target observations without describing the candidate as accepted or approved.

The primary UI uses caller-facing domain words; internal journal and result-arm
names remain confined to the record. Records show typed decision-relevant facts
in order, without rereading reconciliation or settlement. Mechanically unchanged
`ref` and `contract-file` effects belong to reconciliation observation reports,
not accepted invocation answers. Accepted JSON retains its typed public result;
an unchanged physical condition is visible only when carried by a typed lag,
leak, stop, or recovery coordinate.

An abandonment recovery coordinate renders `✓ recovery snapshot <SnapshotId>`.
It has no ref or durable fact and may already be unavailable after repository
garbage collection.

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
counts are derived checks and every non-tautological counterpart Contract ID
remains visible; tautological `mine ~ mine` pairs are omitted from text.
Nonidentical sets remain beneath their own complete Contract ID. Overlap uses
the neutral Region relation
mark and never changes accepted into refused. An incomplete observation is one
`~ overlap unavailable` block with the verbatim diagnostic. An empty completed
observation renders no overlap block. Bind always carries one Region answer.
An accepted amend carries `overlaps` or `overlapFailure` only when its typed
result carries that answer; when both properties are absent, text emits no
overlap block and JSON preserves their absence. The renderer consumes those
typed result shapes without parsing the amendment document or inferring whether
Region changed.

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
and `recovery continue after resolve · deliver --include-dirty`; both labels read
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

Glyphs distinguish obligations (`!`), neutral deviations (`~`), and ordinary
record rows. Verification, cleanup, and environment stops remain independent
typed evidence and do not change an accepted exit status unless their public
result says so.

Dependency baseline follow uses the existing reconciliation rows. A successful
clean fast-forward renders the `worktree followed` effect; a refusal renders
`worktree-follow-retained` with its target, head, reason, exact worktree path,
and any dirty paths. These rows report mechanical state only and contain no
workflow instruction.
Region reads render as follows:

```text
region <contract> <pattern> [<pattern> ...]
overlap <counterpart-contract> <N> pair|pairs
  <mine> ~ <theirs>
```

Bare `region` emits one `region` row per active declaration and emits
`no active Region declarations` for a present empty declaration set. A
Contract read emits its `region` row first, then one grouped `overlap` block
per counterpart in active declaration order, with pairs in calculator order.
If it has none, it emits `no overlap with active declarations`. A path read
emits only the same grouped overlap blocks, using each supplied query pattern
as `mine`. If the complete query has no matches, it emits
`no active Region declares: <pattern> [<pattern> ...]`. A failed Region
section remains `region failed <diagnostic>`. JSON carries the same typed
`Section<RegionRead>`. Present empty observations exit successfully and always
render their explicit empty fact. A Region read is an observation, so both
present and failed sections exit `0`; the failure remains visible in the
typed/text value rather than being mapped to the mutation retry status. JSON
and text carry no actual touched paths, Git conflicts, ownership, or action
advice.

Text omits tautological `pattern ~ same-pattern` witnesses. The typed Region
answer remains unchanged, including those exact pairs for JSON consumers.

Settings text is a structured multiline projection. It starts with `settings`,
indents the two scope facts, then lists each resolved namespace and entry. An
entry value is emitted as indented pretty JSON on its own lines; its bytes are
not collapsed into a fact line. `settings --json` remains the exact typed
Settings projection.
