# CLI Output

This chapter owns help, rendering, and exit status.

## Shared Akuma Rendering

Status, wait, call, tell, interrupt, and kill share one snapshot renderer, and
history uses the same row vocabulary without snapshot budgets. The renderer
consumes typed public values only; it does not mine Heart facts or reconstruct
outcomes or tool lifecycle. Full answer bytes remain available through `history --last` and are
never clipped in JSON.

`show` is a raw Contract read. Text writes the exact guidance Markdown with no
status header or explanatory wrapper. JSON is exactly
`{ "contract": ContractId, "guidance": string }`. Its bytes come from the
workspace renderer owned by [workspace.md](workspace.md); the CLI does not
assemble a second projection. Audit remains unchanged and omits guidance.

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
Root Akuma and Contract leaf help give the owning row's purpose and full usage. There is no
`help` command, `-h` alias, or per-row `--help` flag.

Help is a terminal parser observation. It writes text to stdout, exits `0`,
does not read stdin, does not enter invocation, and never constructs or reads
`Repo`, `Tasks`, or `Akuma`. `-C` is accepted but has no effect and `--json`
does not give help a JSON form. Therefore help works from a directory with no
Keiyaku world.

A syntax refusal carries the deepest grammar coordinate reached and renders
that owner's stored usage, never an ancestor's. It writes stderr and exits `1`.
A bare invocation remains an incomplete-call refusal whose body is the root
projection; requesting root help produces that projection on stdout with exit
`0`.

The adapter chooses actor testimony in this order: explicit nonblank `--actor`,
then `KEIYAKU_PROJECTION_ID`, then no actor. Explicit input wins over the
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

Every invocation renders exactly one plain result object:

| Kind | Product content | Exit |
| --- | --- | --- |
| `accepted` | `verb`, `contract`, public `head` and `facts`, observed `effects`, flat physical `lag`, `settlement`, optional independent obligation stops, presentation diff, and audit `report` when applicable | 0 |
| `refused` | typed refusal and observed grounds | 1 |
| `retry` | exhausted, collision, or publication-failed detail; caller-addressed verbs use the caller's contract coordinate, while bind has no contract segment | 2 |
| `observation` | view data, including observed effects when present | 0 |

Text and `--json` render this same object. Both write to stdout; JSON serializes
it without another output schema. A corrupted authority or other exception
writes its verbatim diagnostic to stderr and exits `3`.

Akuma text has one shared snapshot presentation across status, wait, unfinished
observed call, tell, interrupt, and kill; history remains the unbounded browsing
surface. An answered default call writes the exact answer bytes with no snapshot
or fact prefix. A successful detached call writes its born AkuId and a final
`$ keiyaku wait <AkuId> --timeout 5m` command without inventing life. Dispatch
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
`× killed`, `? stranded`, `? hung`, and `? untidy`. JSON values, timeline row
semantics, and history model remain unchanged.

Post-admission physical or settlement failures remain inside the accepted
object as typed lags. Text and JSON expose them without changing the Contract
fact, command kind, or exit status. The adapter never hides the existing
Contract or automatically abandons it.

Bind, amend, deliver, review, and abandon share one Contract mutation receipt.
The renderer remains a pure projection over `InvocationResult`: it invents no
fields, rereads no authorities, and does not change exit semantics. JSON is
byte-for-byte the serialization of that same public value.

The receipt answers four things in a fixed order: the invocation verdict, the
Contract identity, unresolved obligations, then deviations and the exact record.
The public result taxonomy is not a visual section taxonomy. There are no
`facts`, `effects`, `stops`, or `settlement` section headings, and no nested
`stop` -> `refusal`/`retry` tree. A lowercase label names one row only.

```text
✓ <verb> accepted — <complete kei/...>
! gate <phase> · <unresolved public reason>
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
placement stops, lags, cleanup failures, and leaks. Deviation rows contain
Region warnings, accepted review workspace bytes, and typed audit drift. The
record tail contains admitted journal facts, head, bind `target`, deliver
`verificationReuse`, normal Git effects, normal settlement actions, reports,
and the document diff. Changed effects precede unchanged confirmations;
unchanged effects remain visible.

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
decision. Audit omits diff unless `--show-diff-body` is present. That flag
keeps the public value only on `report.preview.diff`; text consumes that
report-owned value exactly once and never adds a second top-level `diff`. A
`null` preview diff renders the typed `git-unavailable` facts. Default audit
text makes ready versus blocked, candidate identity, Verification verdict or
stop, target readiness or exact conflict, drift, and history scannable inside
the report. Deliver text makes `verificationReuse` visible when present. Audit
also renders its public report, head, and facts; it does not inspect journal
entries or raw process output.

The flat `lag` array remains the public `ReconcileResult` shape defined in
[git-reconciliation.md](git-reconciliation.md). JSON exposes that same array.
An `unsealed-bytes` or `target-checkout-retained` lag does not turn an accepted
result into a refusal or alter its exit status.

A dirty-workspace refusal uses the refused header, then the refusal kind,
classified path collections, complete-tree short statistic, and authorization
option. The option is unavailable exactly when dirty submodule internals are
present. JSON carries the same refusal facts plus the CLI-owned option
projection. The renderer does not run Git or infer another path classification.

An accepted review that observed ordinary dirty workspace bytes hangs a
structured `workspace` disclosure under the Contract coordinate. It has no
authorization option because review observes a projection. Dirty submodule
internals still refuse before review admission.

Each stop is independent: Verification never suppresses the placement attempt,
and one accepted invocation may render both `! gate` rows. An environment
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
