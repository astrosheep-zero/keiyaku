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
  [--note <text>] [--actor <actor>]
  [--needs <TaskId>]... [--parent <TaskId>]
  [--supersedes <TaskId>]... [--relates <TaskId>]...
  [--body <text>] [--json]
task add [--namespace <ns>] [--actor <actor>] [--json] -
task show <TaskId> [--json]
task ls [--closed | --all] [--world] [--limit <n>] [--json]
task ready [--world] [--parent <TaskId>] [--limit <n>] [--json]
task blocked [--world] [--parent <TaskId>] [--limit <n>] [--json]
task query [--where <expression>] [--world]
  [--sort priority|created|updated|id] [--limit <n>] [--json]
task tree <TaskId> [--json]
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
task compose [--actor <actor>] [--json] -
```

Literal `-` selects creation-document input for add, body or note input only
after `--body`, `--append`, or `--note` for update, and composition input for
compose. Unselected piped stdin is not consumed. Add requires exactly one
source: a nonblank TITLE or final `-`. Add document input rejects
creation-owned identity, may declare its initial state, and cannot be combined
with structured creation flags other than `--namespace` and `--actor`. Update requires at
least one explicit patch and remains legal when it changes only non-body
fields. Selected update `--body`, `--append`, `--note`, and `--title` values,
and selected add TITLE, `--body`, and `--note`, must be nonblank. Done and
drop `--note` are likewise nonblank when present.

Selected stdin is acquired asynchronously and completely before the Task
operation begins. The CLI does not expose a synchronous read or retain a
background input queue. A selected required stdin source that is empty or
Unicode-whitespace-only is usage after those bytes are acquired and before
World or Task package invocation. Valid acquired bytes pass through unchanged.

Add `--note` sets the initial note. Update `--note` replaces the note and
returns the native document diff. Done and drop `--note` replace the note for
each addressed Task in that Task's independent atomic lifecycle mutation. Batch
lifecycle commands preserve input order, continue after per-Task refusals, and
do not consume stdin for notes.

`--actor` is legal only on `task add` (structured and final `-` forms) and
`task compose`. The invocation edge resolves actor once before reading or
applying the selected creation input: explicit nonblank `--actor`, then
nonblank `KEIYAKU_ACTOR_ID`, then unsigned. A blank explicit value is usage; a
blank environment value is absent. Update, lifecycle, and settlement commands
do not accept `--actor`. Task code never reads `process.env`.

Omitted namespace keeps the current or default namespace. A nonblank
namespace path selects that namespace. Literal `/` as `task namespace` or add
`--namespace` selects the root namespace. Empty and Unicode-whitespace-only
namespace values are usage.

`ls`, `ready`, `blocked`, and `query` use current namespace unless `--world` is present.
Their observations are bounded and carry the complete matching `total`; ready
and blocked may additionally select recursive descendants of a complete parent
TaskId. `ready` selects only open Tasks whose every `needs` target is terminal.
`show`, `tree`, update, and lifecycle use complete IDs and never infer
from namespace. `tree` is parent decomposition traversal.

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
A truncated page renders `<view> <returned> of <total> · limit <returned>`;
JSON returns `{ rows, total, returned, truncated }` with no second result schema.
Invalid syntax, fields, operators, values, or a nonpositive limit are typed
usage refusals. A missing `under`/`parent` target is a Task refusal, not an
empty result. Query reads only Task persisted and Task-derived facts; it never
reads Contract, Akuma, Git, or prose-inferred urgency.

`ls`, `ready`, `blocked`, `query`, and `doctor` are Task-world observations.
Their JSON and native results preserve `{ kind: "present", value }`,
`{ kind: "absent" }`, or `{ kind: "failed", failure: { message } }`; an absent
world is not an empty accepted result. A missing Task world renders exactly
`task world absent` and exit `1`. A failed world renders `task world failed`,
then `diagnostic`, a blank line, exact diagnostic bytes, a trailing blank line,
and exit `3`. Neither is an empty Task board. Only a present empty page may
render `<view> 0`, and only a present doctor report without issues renders
`healthy`. A present result follows its native exit rule.

`task doctor` scans the complete Task world and renders every graph issue. It
does not repair authority. A present healthy report exits `0`; a present report
containing issues exits `1`. An unhealthy report begins `<N> issue` or
`<N> issues`, then one `!` row per typed issue in public order. Map
`missing-target`, `self-relation`, and `cycle` directly to their exact
relation and TaskId scalars; never render explanatory prose or JSON.

Accepted update and compose render native whole-document diffs; the CLI never
computes them. An incomplete compose writes only its reusable draft to stdout,
writes its stopped reason and admitted diffs to stderr, and exits `1`. JSON
writes the unchanged result object to stdout. Task refusal exits `1`, retry
exits `2`, and corruption or infrastructure failure exits `3`.

Compose admits Task documents independently. Each admitted document is its own
commit point, so partial admission is possible; compose has no cross-file
atomicity or rollback.

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
Complete board glyphs are owned only by [kanshi.md](kanshi.md). Ordinary Task
commands have no Kanshi signature, banner, ruler, table border, or
section-card heading.

## Task Text

Every Task entity line uses:

```text
<mark> <complete TaskId> · P<n> <word> — <title>
```

The indivisible scan unit is `<mark> <complete TaskId> · P<n> <word>`. List
and query copy `TaskDisposition`; show, mutation, and tree copy persisted
`TaskState`; a missing referenced Task uses `missing`; unknown priority uses
`P?` only when the public value lacks priority. Pair marks and words as
`● in_progress`, `○ ready` or `○ open`, `! blocked` or `! missing`, `· on_hold`,
`✓ done`, `× drop`, and `?` for retry or unknown evidence. Do not add a new
glyph. If the title does not fit after the scan unit, keep the em dash at the
end of the first line and wrap prose on two-space continuation lines at
display-word boundaries. Never truncate or split TaskId, path, or another
opaque token; an indivisible token may overflow the terminal.

Relationship and evidence rows use two-space indentation, one edge per row,
and singular lowercase labels: `needs`, `blocks`, `child`, `parent`,
`supersedes`, `superseded-by`, and `related`. Exact body, diff, diagnostic,
and other labeled payloads use one lowercase label line, one blank line,
byte-exact payload, and one trailing blank line.

`ls` begins `tasks <returned>`; `ready`, `blocked`, and `query` begin with
their lowercase view word. A truncated page renders
`<view> <returned> of <total> · limit <returned>`. A present empty result
renders `<view> 0`. Preserve public page order. Rows render only mark,
complete TaskId, priority, disposition, and title. Query-only timestamps,
parent, needs, and blocks stay in JSON. Blocked rows alone add one
`needs <TaskId> · <state>` evidence row per unresolved blocker.

Show begins with the Task entity line using persisted state. Render nonempty
detail in this order: `created <iso> · updated <iso>`; persisted `createdBy`
as `created-by <actor>` when present; unresolved needs with
`! needs`; released terminal needs with `✓ needs`; blocks; parent; children;
supersedes; superseded-by; related; nonempty note; then nonempty exact body.
`createdBy` is show and JSON testimony only; list and query text do not
render it.
Use one row per relation. Body is introduced by `body`, a blank line, exact
body bytes, and a trailing blank line.

Tree consumes `TaskDecompositionTree.children`. Render two spaces per parent
depth and the same entity line with persisted state. A terminal repeated
ancestor renders `! <TaskId> · cycle` with no reference marker. Tree does not
display timestamps, note, needs, blockers, or reverse relations.

Single add, update, start, stop, resume, hold, done, and drop outcomes use
`✓ <verb> accepted — <TaskId>`, `! <verb> refused`, or
`? <verb> retry — <TaskId when the public result supplies it>`. Accepted
single mutation follows with the resulting Task entity line. Accepted update
then renders its exact whole-document diff payload. Batch hold, done, and drop
preserve input order and render exactly one row per item:
`✓ <verb> <TaskId>` for accepted,
`! <verb> <TaskId> · <typed refusal kind and exact scalar facts>` for refused,
and `? <verb> <TaskId> · <typed retry reason>` for retry. Never serialize a
refusal or retry as JSON in text. Batch exit precedence remains retry `2`,
otherwise refusal `1`, otherwise `0`.

Accepted compose renders `✓ compose accepted · <N> changed`, then each
`diff <TaskId>` exact whole-document diff in document-change order. Refused
compose renders `! compose refused`, the typed refusal kind, and an exact
diagnostic payload when present. Incomplete compose keeps stdout as only the
exact reusable draft bytes. Stderr begins
`! compose incomplete · <N> admitted`, renders
`! stopped <typed refusal kind ...>` or `? stopped <typed retry reason ...>`,
then each admitted `diff <TaskId>` exact payload in order. Exit remains `1`.

Namespace text renders `namespace root` for `[]` and
`namespace <segments joined by />` otherwise. Project every current
`TaskRefusal` and `TaskRetry` member to its lowercase kind and exact public
scalar coordinates. Renderer output contains no braces, JSON quotes, or
implementation-arm prefixes. Do not change public values, JSON, or exit
status to serve text.

Text wraps at semantic or prose-word boundaries according to display
columns. A scan head containing a mark, complete identity, and state stays
indivisible, as do copyable refs, paths, and gate names; one of these units
may exceed the requested width rather than being split or truncated. The
renderer applies no arbitrary line cap and does not truncate a complete
identity, title, path, gate, or relation. Opaque testimony stays on owning
detail surfaces. Compose incomplete draft is the existing exception: stdout
contains only exact reusable draft bytes with no label or decoration.
