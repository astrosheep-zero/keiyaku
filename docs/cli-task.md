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
task ls [--closed | --all] [--world] [--limit <n>] [--json]
task ready [--world] [--parent <TaskId>] [--limit <n>] [--json]
task blocked [--world] [--parent <TaskId>] [--limit <n>] [--json]
task query [--where <expression>] [--world]
  [--sort priority|created|updated|id] [--limit <n>] [--json]
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
task done <TaskId>... [--note <text>] [--json]
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

Selected stdin is acquired asynchronously and completely before the Task
operation begins. The CLI does not expose a synchronous read or retain a
background input queue.

Add `--note` sets the initial note. Update `--note` replaces the note and
returns the native document diff. Done and drop `--note` replace the note for
each addressed Task in that Task's independent atomic lifecycle mutation. Batch
lifecycle commands preserve input order, continue after per-Task refusals, and
do not consume stdin for notes.

`ls`, `ready`, `blocked`, and `query` use current namespace unless `--world` is present.
Their observations are bounded and carry the complete matching `total`; ready
and blocked may additionally select recursive descendants of a complete parent
TaskId. `show`, `tree`, update, and lifecycle use complete IDs and never infer
from namespace. `tree` is parent decomposition traversal. Text rows are
`TaskId - P<n> - <disposition> - title`.

```text
task query [--where <expression>] [--world]
  [--sort priority|created|updated|id] [--limit <n>] [--json]
```

`query` is a read-only Task-owned predicate surface. Its expression is parsed
at the CLI boundary into a typed AST; the Task evaluator never receives an
unparsed shell string. Terms support `and`, `or`, `not`, and parentheses, with
these predicates: `state`, `priority`, `title`, `id`, `parent`, `under`,
`needs`, `blocks`, `ready`, `blocked`, `created`, and `updated`. String values
use double quotes; TaskIds are complete coordinates. `under` selects recursive
descendants and excludes the addressed parent. `ready` and `blocked` remain
named high-frequency views backed by the same evaluator. With no `--where`,
query matches active Tasks and excludes `done` and `drop`.

The default limit is 100; explicit limits are integers from 1 through 1000.
The default sort is priority ascending then TaskId bytes. `created` and
`updated` sort by their persisted timestamps (ascending and descending
respectively, with TaskId bytes as the tie-breaker); `id` sorts by TaskId bytes.
Filtering happens against one observed board snapshot before `limit` is applied.
Text reports `<returned> of <total>` and the active limit when truncated; JSON
returns `{ rows, total, returned, truncated }` with no second result schema.
Invalid syntax, fields, operators, values, or a nonpositive limit are typed
usage refusals. A missing `under`/`parent` target is a Task refusal, not an
empty result. Query reads only Task persisted and Task-derived facts; it never
reads Contract, Akuma, Git, or prose-inferred urgency.

`task doctor` scans the complete Task world and renders every graph issue. It
does not repair authority. A healthy report renders `healthy` and exits `0`; a
report containing issues exits `1`. An absent world is not a healthy empty
world: Task observations distinguish `present`, `absent`, and `failed` in
native values, JSON, text, and exit status. Only `present` may render an empty
board.

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
has no other text discovery surface. For a present world its first line is the
one-line Split Horizon signature defined by [cli-output.md](cli-output.md).
The KEIYAKU, TASK, and FLEET apertures, plumb-line grammar, complete-entity
retention, and Human/Flagship projection are owned by [kanshi.md](kanshi.md).
This chapter does not keep a second status board grammar. Aggregate counts
come from the assembled public sections; they are not persisted counters.
Absent and failed sections remain explicit and are never rendered as zero.
The signature is Kanshi-owned; ordinary commands have no global ruler.
Complete board glyphs are owned only by [kanshi.md](kanshi.md).

Text wraps at semantic or prose-word boundaries according to display
columns. A scan head containing a mark, complete identity, and state stays
indivisible, as do copyable refs, paths, and gate names; one of these units
may exceed the requested width rather than being split or truncated. The
renderer applies no arbitrary line cap and does not truncate a complete
identity, title, path, gate, or relation. Opaque testimony stays on owning
detail surfaces.
