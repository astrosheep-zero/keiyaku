# Task CLI

This chapter owns Task subcommands, grammar, and rendering.

## Task Commands

`keiyaku task` resolves the global `-C` coordinate once and constructs one
`Tasks.of` value when a world is present or created. Its parser owns argv shape, stdin selection, mutual exclusion, and
output selection only. Task Markdown, graph, lifecycle, diff, and compose
decisions remain in the native Task surface.

```text
task add <TITLE> [--namespace <ns>] [--priority 0..3]
  [--state open|in_progress|on_hold|done|drop]
  [--note <text>]
  [--needs <TaskId>]... [--parent <TaskId>]
  [--supersedes <TaskId>]... [--relates <TaskId>]...
  [--body <text>] [--json]
task add [--namespace <ns>] [--json] -
task show <TaskId> [--json]
task ls [--closed | --all] [--world] [--json]
task ready [--world] [--json]
task blocked [--world] [--json]
task tree <TaskId> [--full] [--json]
task doctor [--json]
task update <TaskId> [--title <text>] [--body <text>|- | --append <text>|-]
  [--note <text>|-]
  [--priority 0..3] [--needs <TaskId>]... [--drop-needs <TaskId>]...
  [--parent <TaskId> | --no-parent]
  [--supersedes <TaskId>]... [--drop-supersedes <TaskId>]...
  [--relates <TaskId>]... [--drop-relates <TaskId>]... [--json]
task start <TaskId> [--json]
task stop <TaskId> [--json]
task hold <TaskId>... [--json]
task resume <TaskId> [--json]
task done <TaskId>... [--json]
task drop <TaskId>... [--note <text>] [--json]
task namespace [<namespace>] [--json]
task compose [--json] -
```

Literal `-` selects creation-document input for add, body or note input only
after `--body`, `--append`, or `--note` for update, and composition input for
compose. Unselected piped stdin is not consumed. Add document input rejects
creation-owned identity, may declare its initial state, and cannot be combined
with structured creation flags other than `--namespace`. Update requires at
least one explicit patch.

Add `--note` sets the initial note. Update `--note` replaces the note and
returns the native document diff. Drop `--note` replaces the note for each
addressed Task in that Task's independent atomic drop mutation.

`ls`, `ready`, and `blocked` use current namespace unless `--world` is present.
`show`, `tree`, update, and lifecycle use complete IDs and never infer
from namespace. Text rows are `TaskId - P<n> - <disposition> - title`.

`task doctor` scans the complete Task world and renders every graph issue. It
does not repair authority. A healthy report renders `healthy` and exits `0`; a
report containing issues exits `1`.

Accepted update and compose render native whole-document diffs; the CLI never
computes them. An incomplete compose writes only its reusable draft to stdout,
writes its diagnostic and admitted diffs to stderr, and exits `1`. JSON writes
the unchanged result object to stdout. Task refusal exits `1`, retry exits `2`,
and corruption or infrastructure failure exits `3`.

The status board renders one public `KanshiReport`. Default and selected status
have the same report shape. An explicit Contract selector projects the already
assembled report to that Contract and its associated source rows; it does not
switch to another observation result. The Contract section is supplied by
`Keiyaku.list({ repo })` and exposes lifecycle, integration delivery identity,
fresh target observation, and every declared gate's current report. Kanshi and
the renderer copy those discriminants and do not evaluate gate currency, infer
claimability, or derive terminality.
Its Akuma section is supplied by `Akuma.list()` as specified by
[kanshi.md](kanshi.md); the board copies life, identity, pending count,
confinement, and searched coordinates
without probing, reading history, or reclassifying them.

JSON serializes that complete report without a text-specific projection or
shortened value. Text chooses density without hiding a product identity that
has no other text discovery surface. Its first line is `kanshi <root>`, followed
by `state <short-state> · <branch> · observed <observedAt>`. The state is read
from the present Contract board; absent Contract state or branch renders as
`none`, while JSON keeps the full Contract-board value. It has no ruler,
separate root line, or mark legend. The fixed `keiyaku`, `task`, and `akuma`
sections follow in that order.

Bare status renders every Contract row. Waiting and pending-delivery rows come
before other Contracts, with source order stable inside each class. A row starts
with its mark, complete ContractId, and adjacent phase word. Incremental facts
continue beneath it: workspace, an eight-character textual integration
snapshot, and a
target expressed as `-> <ref>`. Every rendered Contract copies all of its
declared gates in declaration order as one compact icon-and-name chain. The
gate marks are `✓` for a current satisfied attestation, `!` for a current
unsatisfied attestation, and `?` when there is no current verdict, including
stale and missing reports. Bare status omits opaque gate summaries so testimony
prose cannot drown the world board; exact Contract status renders each
available current summary beneath the chain and names its gate.
After these facts, a current reverse holder renders as `held by <TaskId>`.
An unavailable holder observation renders `holder unavailable`; a confirmed
absence adds no line. Contracts needing attention are ordered before other
Contracts: unavailable holder evidence first, then waiting or
pending-delivery, with source order stable inside each class.

The Task heading block counts only nonterminal Tasks and carries the exact
`ready` and `on_hold` counts; at narrow widths those counts continue on an
indented heading line rather than becoming a separate inventory summary. Text
expands `in_progress` and `blocked` rows, with blocked rows first and source
order stable inside each class.
Terminal `done` and `drop` Tasks contribute neither rows nor counts; their
complete inventory belongs to `task ls --closed` and `task ls --all`. A visible
row starts with its mark, complete TaskId, and adjacent disposition word, then
prints the current title, priority, and optional Contract endpoint as
incremental facts. Identity and description stay distinct: a title update does
not move the immutable TaskId, so the coordinate cannot stand in for the
current title.
Each blocked row then renders every structured blocker in Task-owner order as
`blocked by <TaskId> (<state>)`; missing targets retain the literal `missing`
state. Nonblocked rows render no blocker evidence.

The Akuma section renders every public fleet row because bare status is its text
discovery surface in this cut. Lost and failed rows come first, running rows
next, and idle or terminal rows last, with source order stable inside each
class. Each row starts with its mark, complete AkuId, and adjacent life word:
`running` is active, `asleep` and `killed` are idle, `stranded` and `headless` are
lost, `unborn` is unknown, and `stillborn` is failed. Running and lost rows may
continue with pending count and confinement. `asleep` and `killed` rows are
always single-line. A stillborn row may continue with its
public seal evidence after
control-character neutralization, first-line extraction, and display-width
truncation. Future Akuma facts may extend this presentation only after the
Akuma public row owns them; Kanshi and CLI never infer activity age, answer
availability, or attention from the current fields. Empty fleet search
coordinates remain in the report and JSON but do not turn normal text absence
into a diagnostic.

Status keeps one stable visual grammar, with adjacent words remaining the
authoritative state: `●` active, `○` idle or ready, `⧗` waiting or blocked,
`‖` held, `✓` satisfied, `!` failed or unsatisfied, `?` without a current
verdict, lost, or unknown, and `×` ended. Marks accelerate scanning; they never
replace the copied lifecycle, gate, Task, or Akuma discriminant. Text wraps at
semantic or prose-word boundaries according to display columns at both narrow
and wide terminal widths. A scan head containing a mark, complete identity,
and state stays indivisible, as do copyable refs, paths, and gate names; one of
these units may exceed the requested width rather than being split or
truncated. Divisible headings, prose, and fact chains do not use that exception.
The renderer applies no arbitrary line cap, does not truncate a
Contract-and-gates block, and does not truncate a complete identity or current
Task title. Historical Task inventory and opaque testimony stay on their
owning detail surfaces.
