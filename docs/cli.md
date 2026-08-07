# CLI

`keiyaku-v4` turns argv and acquired input into public package calls, then
renders their public results. It owns neither
document decoding, lifecycle decisions, carrier discovery, delivery preparation,
Verification execution, or reconciliation semantics.

## Invocation And Scope

The canonical invocation is:

```text
keiyaku-v4 [-C <path>] <command> [<contract>|@<contract>] [--flag ...] [-]
```

`-C <path>` is a global invocation prefix. It supplies the repository coordinate
to the one `Repo.at` construction point used by this invocation and is never
persisted. An omitted `-C` lets `Repo.at` apply its working-directory default.
The adapter constructs exactly one `Repo` per invocation. It derives selector
reads, the settings coordinate, contract handles and verbs, and reconciliation
from that value: `repo.status()`, `repo.root`, `Keiyaku.of({ repo, id })`,
`Keiyaku.bind({ repo, ... })`, and the selected public reconcile method. It
uses only public `Repo`, `Keiyaku`, and `Delivery` values. Neither Keiyaku
construction call resolves a path or reads the working directory again.

The parser performs argv lexing and syntax only. It recognizes command words,
the global prefix, an optional contract positional, flags, and a final `-`; it
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
| `status` | Calls `repo.status()` and optionally filters its returned board. |
| `audit` | Calls `keiyaku.audit`. |
| `reconcile` | Calls the selected public reconciliation method. |
| `task ...` | Calls the separate `./task` public surface described below. |

`bind` accepts no contract positional. Commands addressing an existing contract
accept a full `kei/<contract-segment>` identity or an active short
`@<contract-segment>` reference. The short reference is the deterministic
managed-worktree name when that worktree exists. It resolves as a pure function
over `StatusReport` rows and is never stored.

An omitted contract selector is valid only when `StatusReport.scope` matches
the reported `worktreePath` of exactly one active worktree contract. A here
workspace never supplies omitted-selector inference. The adapter issues a
typed usage refusal when this test has no unique match.

The command-specific syntax is:

```text
bind [--target <ref>] [--here] [--after <kei/...> ...] [--gates <name>] [--actor <actor>] [--json] -
amend [<contract>|@<contract>] [--after <kei/...> ... | --clear-after] [--gates <name>] [--actor <actor>] [--json] -
deliver [<contract>|@<contract>] [--message <text>] [--actor <actor>] [--json]
review [<contract>|@<contract>] (--satisfied | --unsatisfied) [--summary <text>] [--actor <actor>] [--json] [-]
abandon [<contract>|@<contract>] [--note <text>] [--actor <actor>] [--json]
arc [<contract>|@<contract>] [--actor <actor>] [--json] -
status [<contract>|@<contract>] [--json]
audit [<contract>|@<contract>] [--show-diff-body] [--actor <actor>] [--json]
reconcile [<contract>|@<contract>] [--json]
```

## Inputs And Flags

A final bare `-` reads stdin. For `bind`, it reads one contract document; for
`amend`, one amendment-operation document; for `arc`, one arc document; and for
`review`, an optional summary. Review stdin and `--summary <text>` are mutually
exclusive. No other command reads stdin. The grammar of all document inputs is
owned by [document.md](document.md).

The parser decides only whether stdin is syntactically required or allowed.
Failure while acquiring bytes from stdin is an internal invocation failure and
uses exit `3`; it is not converted into a usage error. A genuine
`CliUsageError` raised by syntax or edge validation remains a usage refusal.

`bind` maps `--target`, `--here`, repeated `--after`, `--gates`, and `--actor`
to `Keiyaku.bind`. `--target` remains literal input for the public target boundary;
the parser does not DWIM-resolve it or inspect the current branch. `--here`
maps to `workspace: "here"`; the omitted form maps to its public default.
`amend` maps Markdown, `--actor`, repeated `--after`,
and `--gates` to `keiyaku.amend`. Its omitted `after` leaves the current value
unchanged, while `--clear-after` maps to `after: []`; it is mutually exclusive
with `--after`. `bind`, `amend`, and `arc` require their final `-` document
input.

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

A gate-set name is a lowercase machine segment. Each snapshot is an ordered,
duplicate-free array of public Gate values; an empty array is valid. The adapter
resolves the selected name to its array and passes that array to the public
operation. Bind uses the configured `default` snapshot when its flag is
omitted, falling back to `[reviewed]`; amend retains its current public value
when its flag is omitted. A malformed settings file or unknown name is a typed
usage refusal.

`deliver` accepts an optional materialized-commit `--message`, `--actor`, and
`--json`. `review` requires exactly one of
`--satisfied` or `--unsatisfied`, with optional `--summary`, `--actor`, and
`--json`. `abandon` accepts optional `--note`, `--actor`, and `--json`; it has
no reason flag or hidden reason classification. `arc` and `audit` accept
`--actor` and `--json`; audit also accepts
`--show-diff-body`. `status` and `reconcile` accept `--json`.
`--json` is output-only.

The adapter chooses actor testimony in this order: explicit nonblank `--actor`,
then `KEIYAKU_PROJECTION_ID`, then no actor. Explicit input wins over the
environment. Missing input is a typed usage refusal with one usage line; the
CLI does not prompt.

## Rendering And Exit Status

Every invocation renders exactly one plain result object:

| Kind | Product content | Exit |
| --- | --- | --- |
| `accepted` | `verb`, `contract`, public `head` and `facts`, observed `effects`, flat `lag`, optional independent obligation stops, presentation diff, and audit `report` when applicable | 0 |
| `refused` | typed refusal and observed grounds | 1 |
| `retry` | exhausted, collision, or publication-failed detail; caller-addressed verbs use the caller's contract coordinate, while bind has no contract segment | 2 |
| `observation` | view data, including observed effects when present | 0 |

Text and `--json` render this same object. Both write to stdout; JSON serializes
it without another output schema. A corrupted authority or other exception
writes its verbatim diagnostic to stderr and exits `3`.

Accepted facts name at least their contract, entry, and kind. Effects render as
transport data:

```text
effects: [
  { kind: "worktree", path, action },
  { kind: "ref", name, before, after }
]
```

The flat `lag` array is the public `ReconcileResult` shape defined in
[transport.md](transport.md); the CLI does not wrap or translate it. Its text
form is one direct line per member:

```text
lag worktree-retained <path>
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
{ reason: "transport-unavailable", snapshotId, changeId }
```

This is an observation with exit `0`, contains no raw Git error, and is not
added to the audit report. Audit renders its public report, head, and facts; it does
not inspect journal entries, delivery coordinates, raw process output, or
timestamps.

## Task Commands

`keiyaku-v4 task` constructs one `Tasks.at` value from the global `-C`
coordinate. Its parser owns argv shape, stdin selection, mutual exclusion, and
output selection only. Task Markdown, graph, lifecycle, diff, and compose
decisions remain in the native Task surface.

```text
task add <TITLE> [--namespace <ns>] [--priority 0..3]
  [--needs <TaskId>]... [--parent <TaskId>]
  [--supersedes <TaskId>]... [--relates <TaskId>]...
  [--contract <ContractId>] [--body <text>] [--json]
task add [--namespace <ns>] [--json] -
task show <TaskId> [--json]
task ls [--closed | --all] [--world] [--json]
task ready [--world] [--json]
task blocked [--world] [--json]
task tree <TaskId> [--full] [--json]
task cycles [--json]
task update <TaskId> [--title <text>] [--body <text>|- | --append <text>|-]
  [--priority 0..3] [--needs <TaskId>]... [--drop-needs <TaskId>]...
  [--parent <TaskId> | --no-parent]
  [--supersedes <TaskId>]... [--drop-supersedes <TaskId>]...
  [--relates <TaskId>]... [--drop-relates <TaskId>]...
  [--contract <ContractId> | --no-contract] [--json]
task start|stop|hold|resume <TaskId> [--json]
task done|drop|hold <TaskId>... [--json]
task namespace [<namespace>] [--json]
task compose [--json] -
```

Literal `-` selects creation-document input for add, body input only after
`--body` or `--append` for update, and composition input for compose. Unselected
piped stdin is not consumed. Add document input rejects creation-owned identity
and state. Update requires at least one explicit patch.

`ls`, `ready`, and `blocked` use current namespace unless `--world` is present.
`show`, `tree`, update, lifecycle, and cycles use complete IDs and never infer
from namespace. Text rows are `TaskId - P<n> - <disposition> - title`, with an
associated ContractId appended when present.

Accepted update and compose render native whole-document diffs; the CLI never
computes them. An incomplete compose writes only its reusable draft to stdout,
writes its diagnostic and admitted diffs to stderr, and exits `1`. JSON writes
the unchanged result object to stdout. Task refusal exits `1`, retry exits `2`,
and corruption or infrastructure failure exits `3`.

The status board renders one public `StatusReport`. An explicit contract ID is
passed to `repo.status({ contract })` and reads only that journal. An
`@<worktree>` selector still needs the world report to resolve the worktree
coordinate, then filters that same report. The board exposes the public row
fields, including current Verification verdict and bounded summary, and remains
a rendering surface rather than another observation path.

## Product Boundary

The CLI package entry is a shebang-only executable with no exports. Parser,
usage errors, renderers, and `main` are not package API. The CLI imports the
package root and its own modules only; it does not define package-root library
behavior or obtain a raw scope, token, registry, or orchestrator.

Contract commands accept no task coordinate and produce no task mutation or
settlement effect. Task coordination and its associations are owned by the
external task product.

The surface has no interactive mode, input envelope, independent JSON schema,
per-command JSON payload, configurable attempt count, command alias, or
additional top-level command.

`scope` remains the repository-coordinate field on `StatusReport`. There is no
`scope` or `region` command; cross-contract fact relationships and a world
Region report are outside the day-one surface.
