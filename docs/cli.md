# CLI

`keiyaku` turns argv and acquired input into public package calls, then
renders their public results. It owns neither
document decoding, lifecycle decisions, Git discovery, delivery preparation,
Verification execution, or reconciliation semantics.

## Invocation And Scope

The canonical spelling is:

```text
keiyaku [-C <path>] <command> [<contract>|@<contract>] [--flag ...] [-]
```

`-C <path>` and `--cwd <path>` are two spellings of the one global invocation
cwd and are never persisted. The canonical examples use `-C`. Either spelling
may appear before or after the command, but the two spellings may not be
combined or repeated in one invocation. An omitted value uses the process cwd.
Contract commands supply the invocation cwd to the one `Repo.at` construction
point. Task commands use it as their task world; Akuma and Settings commands
currently resolve it once as their absolute exact world without Git-root
climbing. A Contract invocation constructs exactly one
`Repo`. It derives selector reads, contract handles and verbs, and reconciliation
from that value: `Keiyaku.list({ repo })`, `repo.root`, `Keiyaku.of({ repo, id })`,
`Keiyaku.bind({ repo, ... })`, and the selected public reconcile method. It
uses only public `Repo`, `Keiyaku`, and `Delivery` values. Neither Keiyaku
construction call resolves a path or reads the working directory again.

The parser performs argv lexing and syntax only. It extracts the one global cwd,
then recognizes command words, an optional contract positional, flags, and a final `-`; it
checks arity, missing values, duplicates, unknown flags, and mutual exclusion.
It emits pure parsed data without reading Git, folding state, resolving actors,
or judging a command.

After syntax parsing, the invocation adapter directly calls the corresponding
public `Repo` or `Keiyaku` operation. Deliver, review, arc, abandon, and audit
have no command-specific forwarding wrapper: a wrapper that only renames or
casts public input owns no behavior and is not an architectural boundary.

## Command Surface

The command vocabulary is:

| Command | Public adaptation |
| --- | --- |
| `bind` | Calls `Keiyaku.bind` with the pinned Repo, Markdown, and structured options. |
| `amend` | Calls `keiyaku.amend` with the operation Markdown and structured options. |
| `deliver` | Calls `keiyaku.deliver`. |
| `review` | Calls `keiyaku.review` directly. |
| `abandon` | Calls `keiyaku.abandon`. |
| `arc` | Calls `keiyaku.arc` with arc Markdown. |
| `status` | Calls Kanshi or one exact Akuma status according to its selector. |
| `audit` | Calls `keiyaku.audit`. |
| `reconcile` | Calls the selected public reconciliation method. |
| `settings` | Constructs and observes the shared read-only Settings resource. |
| `install` | Installs the bundled Keiyaku skills through one or more native harness installers. |
| `task ...` | Calls the separate `./task` public surface described below. |
| `call`, `fork` | Call the package-root Akuma facet so Dispatch and Alias integration is not reimplemented at the edge. |
| `wait`, `tell`, `interrupt`, `history`, `kill` | Call the corresponding separate `./akuma` capability as root verbs. |

`bind` accepts no contract positional. Commands addressing an existing contract
accept a full `kei/<contract-segment>` identity or an active short
`@<contract-segment>` reference. The short reference is the deterministic
managed-worktree name when that worktree exists. It resolves as a pure function
over `ContractBoard` rows and is never stored.

An omitted contract selector is valid only when the invocation coordinate matches
the reported `worktreePath` of exactly one active worktree contract. A here
workspace never supplies omitted-selector inference. The adapter issues a
typed usage refusal when this test has no unique match.

The command-specific syntax is:

```text
bind [--task <task/...>] [--target <ref>] [--here] [--after <kei/...> ...] [--gates <name>] [--actor <actor>] [--json] -
amend [<contract>|@<contract>] [--after <kei/...> ... | --clear-after] [--gates <name>] [--actor <actor>] [--json] -
deliver [<contract>|@<contract>] [--message <text>] [--actor <actor>] [--json]
review [<contract>|@<contract>] (--satisfied | --unsatisfied) [--summary <text>] [--actor <actor>] [--json] [-]
abandon [<contract>|@<contract>] [--note <text>] [--actor <actor>] [--json]
arc [<contract>|@<contract>] [--actor <actor>] [--json] -
status [<contract>|@<contract>|<aku/...>] [--json]
audit [<contract>|@<contract>] [--show-diff-body] [--actor <actor>] [--json]
reconcile [<contract>|@<contract>] [--retry-hooks] [--json]
settings [--json]
install <codex|claude|opencode|pi> [--json]
       install --all [--json]
call <akuma> [--contract <kei/...>] [--alias @name] [--workdir <path>] [--wait [--timeout <duration>] | -d | --detach] [--json] -
wait <aku/...> [--timeout <duration>] [--json]
tell <aku/...> [--json] -
interrupt <aku/...> [--json] -
history <aku/...> [--before <index> | --since <index> | --last] [--json]
fork <aku/...> --at <historyId> [--json]
kill <aku/...> [--json]
```

## Inputs And Flags

A final bare `-` reads stdin. For `bind`, it reads one contract document; for
`amend`, one amendment-operation document; for `arc`, one arc document; and for
`review`, an optional summary. Review stdin and `--summary <text>` are mutually
exclusive. No other Contract command reads stdin. Akuma and Task stdin entry
points are specified by their command grammars below. The grammar of all
document inputs is owned by [document.md](document.md).

The parser decides only whether stdin is syntactically required or allowed.
Failure while acquiring bytes from stdin is an internal invocation failure and
uses exit `3`; it is not converted into a usage error. A genuine
`CliUsageError` raised by syntax or edge validation remains a usage refusal.

`bind` maps `--target`, `--here`, repeated `--after`, `--gates`, and `--actor`
to `Keiyaku.bind`. An explicit `--target` remains literal input for the public
target boundary. When it is omitted, the adapter supplies
`repo.currentBranch()`; an attached branch therefore becomes the canonical
target, while detached HEAD remains explicitly targetless. The parser itself
does not inspect Git. An accepted bind result exposes the persisted canonical
target, or `null`, so this default is never hidden. `--here`
maps to `workspace: "here"`; the omitted form maps to its public default.
`amend` maps Markdown, `--actor`, repeated `--after`,
and `--gates` to `keiyaku.amend`. Its omitted `after` leaves the current value
unchanged, while `--clear-after` maps to `after: []`; it is mutually exclusive
with `--after`. `bind`, `amend`, and `arc` require their final `-` document
input.

Every Contract mutation and `reconcile` reads one Settings observation at the
CLI edge and derives one `WorktreeHooks` value through the package-root
consumer. It passes that pure value into the public operation; the CLI never
runs hook commands or reads marker files. `reconcile --retry-hooks` maps to
`retryHooks: true`. It retries only a failed marker phase with its frozen
commands and does not recapture edited settings for an existing worktree.

Repository `.keiyaku/settings.json` may supply named gate snapshots for the
`--gates <name>` edge flag:

```json
{
  "gates": {
    "default": ["reviewed"],
    "strict": ["reviewed", "verified"]
  }
}
```

A gate-set name and each gate word match `^[a-z][a-z0-9-]{0,63}$`. Each
snapshot is an ordered, duplicate-free array; an empty array is valid. The
adapter resolves the selected name to its array and passes that array to the
public operation. Bind uses the configured `default` snapshot when its flag is
omitted and uses `[]` when that entry is absent; amend retains its current
public value when its flag is omitted. A malformed Settings scope, malformed
selected entry, or explicitly selected unknown name is a typed usage refusal.

`deliver` accepts an optional materialized-commit `--message`, `--actor`, and
`--json`. `review` requires exactly one of
`--satisfied` or `--unsatisfied`, with optional `--summary`, `--actor`, and
`--json`. `abandon` accepts optional `--note`, `--actor`, and `--json`; it has
no reason flag or hidden reason classification. `arc` and `audit` accept
`--actor` and `--json`; audit also accepts
`--show-diff-body`. `status` and `reconcile` accept `--json`.
`--json` is output-only.

`install` is the one edge command that does not read a repository or Git. It
installs the bundled `keiyaku`, `keiyaku-task`, `keiyaku-workflow`, and
`keiyaku-akuma` skills into `codex`, `claude`, `opencode`, or `pi` using each
harness's native installer and its default user scope. A successful install is
convergent: rerunning one bundle version leaves an equivalent usable
installation, while installing a newer bundle makes that bundle installed or
directly visible to the harness. It does not promise that native cache,
metadata, or timestamps remain byte-for-byte unchanged. One bundle version
identifies one content release, all harness manifests carry that same version,
and a changed release increments it. The CLI does not preflight or duplicate a
harness's native installation judgment.

`--all` runs the fixed order `codex`, `claude`, `opencode`, `pi`; a
failure is recorded, remaining harnesses still run, and no cross-harness
rollback occurs. Text prints one result per harness. JSON returns
`{ kind: "install", results: [...] }`, with each result typed as `installed` or
`failed` and a diagnostic on failure. Any failed harness makes the command exit
`1`; successful installation exits `0`.

`call`, `tell`, and `interrupt` require the final `-` and pass those bytes
as the public body input. The `call` positional is the Archetype name and names
`~/.keiyaku/akuma/<name>.md`; its provider must resolve through the Cut 1
Settings-backed provider interpretation. When no same-name Settings entry
exists, the built-in fallback execution names are `claude` and
`codex-app-server`. Missing or malformed configuration prints the exact path
searched. `--contract` accepts one complete `kei/...` identity, constructs its
handle from the invocation Repo, and asks the package-root call to publish
Dispatch after birth. It is not a lifecycle gate and does not accept an
omitted or `@` Contract selector. `--alias` accepts the sole `@name` grammar and
asks that same call to move the world-local Alias after any Dispatch succeeds.
Both flags are optional. `--workdir` selects the immutable summon seat and is
resolved to an absolute path against the invocation cwd at the CLI boundary;
an absolute value remains unchanged, while omission uses the
invocation cwd. Call waits on the born Akuma by default and returns the public
status carrier when it stops running or after five minutes. `--wait` explicitly
selects that default mode, while `--timeout` replaces the five-minute duration.
`-d` and `--detach` are identical and return after birth plus Dispatch and Alias
integration. Detach is mutually exclusive with `--wait` and `--timeout`.
`wait`, `tell`, `interrupt`, `history`,
`fork`, and `kill` require a complete
`aku/<archetype>/<hex8>`. `status <aku/...>` addresses the same exact handle.
Bare `status` already exposes the Akuma fleet through Kanshi; there is no
second raw-roster flag. Library `world.of()`
constructs the addressed handle and has no CLI command of its own.
CLI `wait` uses the public default predicate (`life !== "running"`). Its
optional duration matches exactly `^(0|[1-9][0-9]*)(ms|s|m|h)$`: integers and
units are required, leading zeroes are refused except for zero itself, and the
units convert to milliseconds before the public call. A converted value beyond
the safe integer range is refused. `--timeout` passes that value as
`timeoutMs`, while predicate functions remain library-only input. `history`
with no mode renders the newest page of at most 50 semantic rows. `--before`
reads the page preceding an already visible activity index; `--since` reads
activity following an already visible index. Both are exclusive, accept only
positive safe integers, and are mutually exclusive with each other and
`--last`. `--last` writes the complete answer from the last answered turn,
skipping later failed turns; it does not read activity or append framing.
`fork` requires one nonblank `--at` history id and has no stdin body.
The adapter supplies the invocation Repo to package-root fork when `-C` is
inside a Git world and supplies no Repo outside Git. The facade alone reads and
propagates a parent Dispatch; CLI never reads Dispatch or Alias files.

## Akuma Text Surface

Akuma text is one pure projection over public values. Provider adapters retain
facts, the Akuma activity read model folds and selects rows, and the CLI only
lays those rows onto one ruler and spine. No CLI branch repairs, reselects, or
reinterprets activity. JSON exposes the same public value with complete ISO
`at` values and no text-only time suppression.

The ruler carries only facts fixed for the invocation: the life mark and complete
Akuma id. The id already contains the Archetype, so the
Archetype is never repeated. The closed marks are `●` running, `○` nonterminal
idle, `×` dead, `!` stillborn or warning, `│` spine, `⋮` omitted history, `⧗`
tell, `✂` interrupted, and `✓` answered. Text never prints the storage words
`retained`, `latest`, `body`, `heart`, or `turn`, and never emits a standalone
`running` line. An unfinished tool row, which has no duration or result suffix,
expresses the running work.

```text
── ● aku/worker/1234abcd ──────────────────────────────────
      ⋮ +12
09:31 │ say      narrowing the failing suite
      │ run      $ npm test — 41s · exit 1
09:32 │ edit     src/akuma.ts — +12 -3
      │ thought  the collar probe races the pid check
      │ run      $ npm test
      │ ⧗ tell   "also check the leash timeout"
```

The spine prints the first visible row's `HH:MM`. It then suppresses a row's
gutter while that row is less than 60 seconds after the last timestamp actually
printed, and prints again at 60 seconds or more. A row without `at`, such as an
unconsumed tell, always has an empty gutter and does not move the anchor. There
is no date line, cross-day exception, seconds display, or derived silence row.
The same pure gutter function serves exact status, running wait results, tell,
interrupt, kill, and history.

Tool presentation is one pure function. A completed run prints immutable
duration and then `ok`, `exit <code>`, or `error`; an unfinished run omits the
suffix. One file change prints its operation and path. Multiple changes print
`edit <n> files · <representative-path> ...`; an aggregate `+<n> -<n>` appears
only when every change has a diffstat. Missing optional provider facts shorten
the row and never produce placeholders.

History is the only text surface with an index column. The index is a visible
activity cursor and exists only to be copied into the next command. The three
navigation laws are: every cursor was already visible, direction words match
caller intent, and every recoverable omission line contains a complete command.

```text
── aku/worker/1234abcd ── history ─────────────────────────
   ⋮ 32 earlier · keiyaku history aku/worker/1234abcd --before 37
  37 09:31 │ say      narrowing the failing suite
  38       │ run      $ npm test — 41s · exit 1

── aku/worker/1234abcd ── history ── since 43 ─────────────
  44 09:41 │ say      checking the leash timeout
```

A page that reaches a pruned lower boundary prints exactly `⋮ earlier history
no longer kept`. A `--since` page with no rows prints exactly `⋮ no activity
since <index>`. Exact status prints `⋮ +<count>` at the spine column when its
snapshot omits semantic rows; it does not invent a history cursor. No text asks
the caller to calculate a cursor.
`history --last` bypasses this frame and writes only exact answer bytes.

## Help

CLI grammar has three owners. `src/cli/parse.ts` owns Contract rows and the
shared root `status`, `src/cli/commands/task.ts` owns Task action rows, and
`src/cli/commands/akuma.ts` owns root Akuma verb rows. Root help composes those
owner rows without copying their grammar; only Task remains a namespace. Each
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

Post-admission physical or settlement failures remain inside the accepted
object as typed lags. Text and JSON expose them without changing the Contract
fact, command kind, or exit status. The adapter never hides the existing
Contract or automatically abandons it.

Accepted facts name at least their contract, entry, and kind. Effects render as
Git data:

```text
effects: [
  { kind: "worktree", path, action },
  { kind: "ref", name, before, after }
]
```

The flat `lag` array is the public `ReconcileResult` shape defined in
[git.md](git.md); the CLI does not wrap or translate it. Its text
form is one direct line per member:

```text
lag worktree-retained <path>
lag worktree-hook-failed <create|destroy> <path> command=<index> <failure-json>
```

JSON exposes that same `lag` array. A `worktree-retained` lag does not turn an
accepted result into a refusal or alter its exit status.

Text presents all accepted `facts`, then independent obligation stops, Region
observation, effects, and flat lag. It does not replace observed data with a
repair command. Each completed bind/amend overlap witness renders:

```text
overlap <contract> <mine> ~ <theirs>
```

An incomplete Region observation renders exactly one line and leaves the
accepted exit status unchanged:

```text
overlap unavailable <verbatim-diagnostic>
```

An empty completed observation renders no overlap line. JSON exposes the same
public `overlaps` or `overlapFailure` property without a second output schema.
The exact obligation and residue lines are:

```text
stop verification <json>
stop placement <json>
leak worktree <path> <verbatim-diagnostic>
```

Each stop is independent: Verification never suppresses the placement attempt,
and one accepted invocation may render both lines. The `stop` prefix
distinguishes an accepted verb's obligation result from a top-level
`refused <verb>` result. JSON serializes the public value unchanged. The
renderer never mines facts from value fields or duplicates an accepted fact.

The leak line reports a disposable Verification worktree that could not be
removed after admission. It does not change the accepted exit status and is
not a repair command, lifecycle fact, or reconcile result.

For an accepted amendment, the CLI renders the returned nonoptional
`AmendResult.documentDiff` as the presentation diff, including an empty string.
Text and JSON use that same public value. The CLI never dereferences a
structured body from a public outcome, computes another document diff, persists
diff bytes, or makes diff availability a lifecycle decision.

Audit omits diff content unless `--show-diff-body` is present. It obtains the
Delivery from the public handle and renders diff text when available. A `null`
public diff renders:

```text
{ reason: "git-unavailable", snapshotId, changeId }
```

This is an observation with exit `0`, contains no raw Git error, and is not
added to the audit report. Audit renders its public report, head, and facts; it does
not inspect journal entries, delivery coordinates, raw process output, or
timestamps.

## Task Commands

`keiyaku task` constructs one `Tasks.at` value from the global `-C`
coordinate. Its parser owns argv shape, stdin selection, mutual exclusion, and
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
`Keiyaku.list({ repo })` and exposes lifecycle, candidate, and every declared
gate's current report. Kanshi and the renderer copy those discriminants and do
not evaluate gate currency, infer claimability, or derive terminality.
Its Akuma section is supplied by `Akuma.list()` as specified by
[kanshi.md](kanshi.md); the board copies life, identity, pending count,
confinement, and searched coordinates
without probing, reading history, or reclassifying them.

JSON serializes that complete report without a text-specific projection or
shortened value. Text chooses density without hiding a product identity that
has no other text discovery surface. Its first line is `kanshi <root>`; it has
no ruler, separate root line, or mark legend. The fixed `keiyaku`, `task`, and
`akuma` sections follow in that order.

Bare status renders every Contract row. Waiting and pending-delivery rows come
before other Contracts, with source order stable inside each class. A row starts
with its mark, complete ContractId, and adjacent phase word. Incremental facts
continue beneath it: workspace, an eight-character textual candidate, and a
target expressed as `-> <ref>`. Every rendered Contract copies all of its
declared gates in declaration order as one compact icon-and-name chain. The
gate marks are `✓` for a current satisfied attestation, `!` for a current
unsatisfied attestation, and `?` when there is no current verdict, including
stale and missing reports. Bare status omits opaque gate summaries so testimony
prose cannot drown the world board; exact Contract status renders each
available current summary beneath the chain and names its gate.

The Task heading counts only nonterminal Tasks and carries the exact `ready`
and `on_hold` counts; there is no separate inventory summary line. Text expands
`in_progress` and `blocked` rows, with blocked rows first and source order stable inside each
class.
Terminal `done` and `drop` Tasks contribute neither rows nor counts; their
complete inventory belongs to `task ls --closed` and `task ls --all`. A visible
row starts with its mark, complete TaskId, and adjacent disposition word, then
prints the current title, priority, and optional Contract endpoint as
incremental facts. Identity and description stay distinct: a title update does
not move the immutable TaskId, so the coordinate cannot stand in for the
current title.

The Akuma section renders every public fleet row because bare status is its text
discovery surface in this cut. Lost and failed rows come first, running rows
next, and idle or terminal rows last, with source order stable inside each
class. Each row starts with its mark, complete AkuId, and adjacent life word:
`running` is active, `asleep` and `dead` are idle, `stranded` and `headless` are
lost, `unborn` is unknown, and `stillborn` is failed. Running and lost rows may
continue with pending count and confinement. Asleep and dead rows are always
single-line. A stillborn row may continue with its public seal evidence after
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
replace the copied lifecycle, gate, Task, or Akuma discriminant. Text wraps by
display columns at both narrow and wide terminal widths. It applies no
arbitrary line cap, does not truncate a Contract-and-gates block, and does not
truncate a complete identity or current Task title. Historical Task inventory
and opaque testimony stay on their owning detail surfaces.

Akuma call, exact status, wait, history, an `interrupted` interrupt, successful
wake, a `forked` fork, and settled kill exit `0`. Interrupt `dead` or
`unstoppable`, and an
interrupted tell refused by concurrent death, exit `1`; an interrupted tell
whose detached wake failed exits `2`. Exact status renders current state, the
latest complete answer or failure, and the public activity snapshot. Wait uses
the same status carrier: when its predicate is satisfied it renders the complete
answer or failure; when its timeout arrives while still running it renders the
snapshot. JSON returns that public value without reshaping it. History text
renders the requested persistent activity page and its completed-turn
boundaries; `--last` emits only the final selected answer bytes. Tell text
renders the subsequent exact status, whose untimestamped `⧗ tell` row is the
write receipt's useful projection. A failed detached wake appends its diagnostic
to that status. Interrupt text distinguishes `dead`, every `unstoppable`
evidence, a successful interrupted tell, `refused-dead`, and a failed wake;
materially different receipt arms never share success text. JSON carries the
complete public receipt and status values.
`unavailable` and
`alive-after-sigkill` exit `1`; a recorded tell whose detached wake failed exits
`2`. Fork text renders the child id for
`forked`; provider plus unavailable capability for `provider-cannot-fork`; the
requested coordinate plus no matching retained answered turn for
`unknown-history`; and the diagnostic for `fork-failed`. These three clean
refusals exit `1`. `upstream-forked` renders both
`childSession.sessionId` and its diagnostic and exits `2`. Fork JSON serializes
the public receipt verbatim. Syntax uses exit `1`; corruption and infrastructure
exceptions use exit `3`.

A detached called result renders the complete AkuId first. A waited result
renders that identity once together with the same answer, failure, or running
snapshot projection used by `wait`. A completed Dispatch adds
`dispatch <ContractId>` and a completed Alias adds `alias <@name>`; absent stages
add no line. A failed Dispatch, Alias, or post-birth observation stage renders
its typed diagnostic and exits `2`, because the Akuma already exists. A skipped
Alias adds no second failure line. JSON serializes the complete call result,
including its closed observation stage. Fork keeps its existing receipt text; a forked child with a
completed Dispatch adds the same dispatch line, while a forked child whose
Dispatch failed renders that failure and exits `2`. JSON serializes the same
package-root stage values and never exposes a private Repo, Git snapshot, Alias
file, or Akuma handle.

## Product Boundary

The CLI package entry is a shebang-only executable with no exports. Every
build recreates it with POSIX execute permission before packaging or linking. Parser,
usage errors, renderers, and `main` are not package API. The CLI adapts the
package-root facade and the separate `./task` and `./akuma` product surfaces;
it does not define their library behavior or obtain a raw scope, token,
registry, or orchestrator. Package-root call and fork are not reimplemented
through direct `Akuma.at` calls at this edge.

Contract commands accept no task coordinate and never interpret or perform a
Task mutation. Their package-root operations may return the post-admission
coordination defined only by [settlement.md](settlement.md); the CLI merely
renders that public result.

The surface has no interactive mode, input envelope, independent JSON schema,
per-command JSON payload, configurable attempt count, command alias, or other
top-level command.

The report `root` remains the invocation world coordinate. There is no
`scope` or `region` command; cross-contract fact relationships and a world
Region report are outside the day-one surface.
