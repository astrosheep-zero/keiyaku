# CLI Output

This chapter owns help, rendering, and exit status.

## Shared Akuma Rendering

Status, unfinished or non-answered wait, every multi-target wait, unfinished
observed call, tell, interrupt, and kill share one snapshot renderer, and
history uses the same row vocabulary without snapshot budgets. The renderer
consumes typed public values only; it does not mine Heart facts, reconstruct
outcomes or tool lifecycle, or read history. One typed raw-answer decision,
shared with stdout newline custody, writes exact answer bytes for an answered
default call and an ordinary answered single-target wait. `history --last`
remains the explicit exact read independent of waiting. Full answer bytes are
never clipped in JSON.

`show` is a raw Contract read. Text writes the exact guidance Markdown with no
status header or explanatory wrapper. JSON is exactly
`{ "contract": ContractId, "guidance": string }`. Its bytes come from the
workspace renderer owned by [workspace.md](workspace.md); the CLI does not
assemble a second projection. Audit remains unchanged and omits guidance.

`history kei/...` is that same-snapshot two-authority projection. Text begins
with `history <kei/...> · <J> journal · <D> dispatch`, then one recorded-time
timeline. Counts come from event source. Zero Dispatch facts render `0
dispatch` and no placeholder row. A journal event is
`<fact.at> <fact.kind> · <fact.entry>[ · <fact.actor>]` plus the
decision-relevant subordinate facts for that kind; a Dispatch event is
`<dispatchedAt> dispatch · <complete AkuId>`. Opaque coordinates and payloads
are never truncated. Equal timestamps stay visibly equal and claim no
causality. JSON is the exact `ContractHistory` value and exits `0`.
`contract-missing` exits `1`; authority corruption keeps the exception exit.
Akuma history text, `--last`, cursors, JSON, and exits remain unchanged. There
is no Contract cursor, pagination, last-event shortcut, or section split.

The installed executable is `keiyaku`. The package declares no alternate or
versioned command name.

## Help

CLI grammar has one table owner for each command family: Contract and shared
root commands, Task commands, Akuma commands, and install. Root help composes
those owner rows without copying their grammar; only Task remains a namespace. Each
owner row contains its machine syntax, the corresponding usage
line or block, and one help-only purpose line.
Validation, usage refusal, namespace help, and leaf help read that row.
Structural rules that are clearer as command code remain adjacent to their row
rather than creating a grammar language.

`--help` is a reserved parser token, not a command or command flag. After the
optional `-C <path>` prefix is removed, its presence anywhere makes the
invocation a help request for the longest legal command-word prefix. Other
tokens do not need to form a valid invocation: `task unknown --help` describes
the Task namespace. Root help lists the root command vocabulary and points one
hop to `task --help`; Task namespace help lists every action and its usage.
Root Akuma and Contract leaf help give the owning row's purpose and full usage.
Command-specific supplemental guidance or one minimal example may follow the
usage block in leaf help; it does not appear in syntax-refusal usage. There is no
`help` command, `-h` alias, or per-row `--help` flag.

Help is a terminal parser observation. It writes text to stdout, exits `0`,
does not read stdin, does not enter invocation, and never constructs or reads
`Repo`, `Tasks`, or `Akuma`. `-C` is accepted but has no effect and `--json`
does not give help a JSON form. Therefore help works from a directory with no
Keiyaku world.

A syntax refusal carries the deepest grammar coordinate reached and renders
that owner's stored usage, never an ancestor's. It writes stderr and exits `1`.
Source-selection and nonblank refusals are that same usage class: they name
the command or input and the accepted form, and they occur before World,
Repo, or package-root invocation. A bare invocation remains an
incomplete-call refusal whose body is the root projection; requesting root
help produces that projection on stdout with exit `0`.

The adapter chooses actor testimony in this order: explicit nonblank `--actor`,
then `KEIYAKU_ACTOR_ID`, then no actor. Explicit input wins over the
environment. Missing input is a typed usage refusal with one usage line; the
CLI does not prompt.

## Rendering And Exit Status

Plain text is the primary CLI interface for both the flagship agent and the
human directing it. Text is their default usage choice and the designer's
default design surface, not merely the parser behavior when `--json` is
omitted. They share one presentation: what a human reads is what the flagship
reads. Every command is designed text-first, and its text receipt or board must
carry the decision-relevant product facts. `--json` is an explicit secondary
projection for debugging or non-interactive bulk scripting; its availability
never excuses missing, opaque, or degraded text output.

Before opaque work that may run external commands or substantial Git work, a
text invocation writes exactly one start line to stderr after selected stdin is
fully acquired and before the operation begins. The closed vocabulary is
`⧖ preparing keiyaku` for bind, `⧖ delivering` for deliver, `⧖ auditing` for
audit, `⧖ reconciling` for reconcile, and `⧖ installing skills` for install.
This line states only that the named work has begun; it is not a result object,
progress percentage, internal-phase report, or durable fact. Explicit waiting
and Akuma observation commands do not repeat their already-visible intent.
`--json` writes no start line, so automation receives only the final JSON value
and diagnostics.

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
`<phase> · <age>` before target facts, each gate token is
`<mark> <gate> <age>`, and born Akuma life is `<life> · <age>`. JSON retains
the source timestamps and never contains the derived age.

Kanshi is the one aggregate surface with a brand signature. Its first line is
one responsive Split Horizon geometry:

```text
kanshi ─── <keiyaku-count> keiyaku · <akuma-count> akuma · <task-count> task ─── <world>
```

The left word identifies the observer, the middle is the aggregate fact, and the
right side is the observed world coordinate. The two horizontal segments use
`U+2500` and flex to the available display width, with at least three characters
on each side; they never hide or shorten the facts. When the complete coordinate
makes the minimum signature wider than the viewport, the signature remains one
scan line and exceeds the viewport rather than folding or truncating. A present
empty board keeps all three zero counts. An absent world has no signature
because there is no observed world to frame. After the signature, Kanshi uses
the KEIYAKU, TASK, and FLEET apertures and plumb-line hierarchy owned by
[kanshi.md](kanshi.md). FLEET is never an akuma count unit. Other commands
start with their operation identity and do not receive a banner.

Every invocation renders exactly one final plain result object on stdout:

| Kind | Product content | Exit |
| --- | --- | --- |
| `accepted` | closed Contract-mutation union discriminated by literal `bind` \| `amend` \| `deliver` \| `review` \| `arc` \| `abandon` \| `audit`; common envelope plus that verb's flat fields | 0 |
| `refused` | typed refusal and observed grounds | 1 |
| `retry` | exhausted, collision, or publication-failed detail; caller-addressed verbs use the caller's contract coordinate, while bind has no contract segment | 2 |
| `observation` | view data, including observed effects when present | 0 |

Text and `--json` render this same object. Both write to stdout; JSON serializes
it without another output schema. A corrupted authority or other exception
writes its verbatim diagnostic to stderr and exits `3`.

Akuma text has one shared snapshot presentation across status, unfinished or
non-answered single wait, every multi-target wait, unfinished observed call,
tell, interrupt, and kill; history remains the unbounded browsing surface. An
answered default call and an ordinary single-target wait that observes
`life: asleep` with an idle answered outcome write the exact persisted answer
bytes, including the empty string, with no identity, timeline row, life footer,
clipping, sanitization, or extra newline. A running timeout, failed outcome,
open Turn, killed, stranded, hung, untidy, readonly-none, or no-outcome
observation remains that snapshot, even when an older answered idle outcome is
still retained. Multi-target wait remains identity-bearing snapshots for every
selected member and never concatenates naked answers. A successful detached call writes its born AkuId and a final
`$ keiyaku -C <world> wait <@alias|AkuId> --timeout 5m` command without inventing
life. The wait selector is the successful Alias when one was requested,
otherwise the complete AkuId; `<world>` is the canonical Akuma World used by
the call. Dispatch
failure, alias failure, readonly-none refusal, or observation failure keeps its
diagnostic and does not add that wait command. Snapshot
`said` and `thought` rows occupy at most two terminal lines, including a visible
truncation marker when clipped. Other semantic-kind budgets remain unchanged.
Text clipping and receipt presentation never alter the public value serialized
by `--json`.

Akuma life words are rendered verbatim from the public union. `hung` means the
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
bytes or timeline layout. The time gutter is five columns. The first visible event and the first
event whose displayed minute differs from the preceding visible event print
`HH:MM`; additional events in the same minute leave those five columns blank.
One space follows the gutter, then the semantic glyph, one space, then a fixed
verb field sufficient for `say`, `think`, `note`, `tell`, and tool labels; body
text begins at one stable column. Say, think, tell, and answered-outcome bodies
are wrapped in `U+201C`/`U+201D`; tool, note, call, and error bodies are not.
A wrapped body line places a vertical bar in the glyph column and aligns its
body with the first line's body. Event glyphs
remain: ordinary voice, note, and told rows use `·`, completed success uses
`✓`, completed failure uses `!`, active tool uses `⧖`, pending tell uses `⧗`,
and unsettled tool uses `?`. There is no aggregate omission token on the first
row, standalone minute divider, second rule between relation and activity, or
changed snapshot selection.

```text
─────
aku/expert-akuma/5659b10d (@expert)
└─ kei/make-non-git-runtime-observation-honestly-async
      ⋮ 171 omitted
14:36 · say    “I’m editing the architecture allowlist to mirror the completed-”
      │        “migration: synchronous filesystem authority remains only in the two documented…”
      ⋮ 17 omitted
14:46 · think  “The migrated Heart and Body slices now pass except one real-”
      │        “async race exposed by the new boundary…”
14:47 ✓ run    $ npm run test:focused — ok
      ! run    $ npm test — failed
      ⋮ 11 omitted
14:49 ✓ run    $ npm test — ok
      ⧗ tell   “Please also inspect the termination path.”
14:50 ⧖ run    $ npm run test:focused
  ● running
```

The first output line is the five-column `U+2500` opening stroke, exactly as
wide as `HH:MM`. It marks the boundary of the complete snapshot and carries no
state icon, label, or header. AkuId and optional alias occupy the next line.
When a Contract is associated, its complete `kei/...` coordinate follows on the
separate hanging relation line beginning with `U+2514` and `U+2500`; an
unassociated Akuma omits that line. Identity rows never contain current life.
Activity follows the identity and optional relation directly. Status, wait,
unfinished observed call, and kill place life on one two-space-indented
trailing line immediately after activity. Ordinary and interrupt tell output
and history omit life. The life vocabulary remains `● running`, `○ asleep`,
`× killed`, `? stranded`, `? hung`, and `? untidy`. The shared snapshot then
appends created Task context from the typed `AkumaObservation` after that
existing body, including after the life footer on commands that show one:

```text
  tasks <N>
  <mark> <complete TaskId> · P<n> <disposition> — <title>
```

Zero matches render `tasks 0`; failure renders `! tasks failed <diagnostic>`.
Use the existing Task disposition glyphs and wrapping rules. Complete TaskIds
and titles are never truncated, and the block does not consume or alter
timeline row budgets. Raw answered wait, call, history, compact FLEET,
timeline selection, and activity budgets remain unchanged. Renderers perform
no Task, Heart, or Dispatch lookup. JSON values, timeline row
semantics, and history model remain unchanged.

Post-admission physical or settlement failures remain inside the accepted
object as typed lags. Text and JSON expose them without changing the Contract
fact, command kind, or exit status. The adapter never hides the existing
Contract or automatically abandons it.

Accepted Contract mutation results are one closed union discriminated by the
literal verbs `bind`, `amend`, `deliver`, `review`, `arc`, `abandon`, and
`audit`. Reconcile remains an observation and is outside this union. The
common envelope is `kind: "accepted"`, that literal `verb`, `contract`, the
non-null mutation `head`, `facts`, `effects`, `settlement`, and optional
nonempty reconciliation `lag`. Verb payloads stay flat on that object: bind
requires `target` and exactly one Region answer (`overlaps` or
`overlapFailure`); amend requires `diff`, including the empty string, and
that same Region answer; deliver alone may carry `verification`,
`verificationReuse`, `placement`, `cleanup`, and `leak`; review alone may
carry `placement` and `workspace`; arc and abandon carry no verb-specific
field; audit requires `report` and alone may carry its top-level `cleanup`
and `leak`. An arm cannot carry another arm's fields. JSON remains that same
flat value; there is no payload envelope, second schema, or compatibility
arm.

Bind, amend, deliver, review, arc, and abandon share one Contract mutation
receipt. The renderer remains a pure projection over `InvocationResult`: it
invents no fields, rereads no authorities, and does not change exit
semantics. JSON is byte-for-byte the serialization of that same public value.
Accepted renderer dispatch is exhaustive on `verb`; audit text is selected
only by `verb: "audit"`.

The receipt answers four things in a fixed order: the invocation verdict, the
Contract identity, unresolved obligations, then deviations and the exact record.
The public result taxonomy is not a visual section taxonomy. There are no
`facts`, `effects`, `stops`, or `settlement` section headings, and no nested
`stop` -> `refusal`/`retry` tree. A lowercase label names one row only.

```text
✓ <verb> accepted — <complete kei/...>
! verification <typed stop kind and exact scalar facts>
! claim <typed stop kind and exact scalar facts>
~ workspace <N files changed, N insertions(+), N deletions(-)>
  staged <complete path>
~ overlap <warning or witness>
journal <entry> · <kind>
✓ ref <action> · <exact ref> · <before> -> <after>
· worktree <action> · <exact path>
· settle <action> · <exact task or namespace path>
diff

<exact diff bytes>


! <verb> refused
! <refusal kind and exact scalar facts>
! <one exact collection member per row>

? <verb> retry — <complete kei/... when present>
? <retry kind and exact diagnostic facts>
```

Bind retry has no Contract relation because no identity was admitted. The
addressed Contract coordinate appears once on the verdict line. Accepted
trailing obligations never change the accepted verdict or exit status. The
outcome glyphs and lowercase vocabulary remain the shared scanner vocabulary.

Obligation rows come first and contain only unresolved verification or
placement stops, lags, cleanup failures, and leaks. The public `placement`
channel keeps that lifecycle and JSON name; text projects it to the lowercase
label `claim`. Every obligation row uses its product subject as the label:
`verification`, `claim`, `cleanup`, `leak`, `lag`, or `settlement`. Audit
Verification answers use the existing glyph vocabulary and the `verification`
label. Never render `gate` as the label for verification or claim, and never render
the stop-union prefixes `refusal=`, `retry=`, or `failure=` inside an accepted
receipt. The typed reason word is followed only by existing public scalar
evidence. A foreign refusal coordinate appears only when it differs from the
addressed Contract. `target-moved` uses `<expected> -> <observed>`. Deviation
rows contain Region warnings and accepted review workspace bytes. The record
tail contains admitted journal facts, head, bind `target`, deliver
`verificationReuse`, normal Git effects, normal settlement actions, and the
document diff. Changed effects precede unchanged confirmations; unchanged
effects remain visible. Accepted audit text does not fall through to those
generic unchanged effects or settlement actions.

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
top-level `diff`. `src/cli/render/audit.ts` owns the complete accepted audit
receipt. After the invocation line the required order is candidate,
verification, target. Workspace is subordinate evidence under candidate, not
a row before it. Ready identity uses `tender=`, `integration=`, and `change=`.
Recorded delivery evidence is `delivery change=<id>` with its relation.
Verification `summary` is a subordinate bounded payload, not inline. Each
answer uses the existing glyph vocabulary. `--json` retains the complete typed
mutation result. Deliver text makes `verificationReuse` visible when present.
Audit text does not inspect journal entries or raw process output.

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
