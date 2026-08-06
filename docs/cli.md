# CLI

`keiyaku-v4` is the contract command-line adapter. It turns argv and acquired
input into package-root calls, then renders their public results. It owns neither
document decoding, lifecycle decisions, carrier discovery, delivery preparation,
Verification execution, or reconciliation semantics.

## Invocation And Scope

The canonical invocation is:

```text
keiyaku-v4 [-C <path>] <command> [<contract>|@<contract>] [--flag ...] [-]
```

`-C <path>` is a global invocation prefix. It supplies the repository coordinate
to the public construction point used by this invocation and is never persisted.
An omitted `-C` lets that construction point apply its working-directory default.
The adapter acquires one public handle before command adaptation: a `Keiyaku`
handle for a contract command or a `Repo` handle for a world command. It then
uses only public `Repo`, `Keiyaku`, and `Delivery` values.

The parser performs argv lexing and syntax only. It recognizes command words,
the global prefix, an optional contract positional, flags, and a final `-`; it
checks arity, missing values, duplicates, unknown flags, and mutual exclusion.
It emits pure parsed data without reading Git, folding state, resolving actors,
or judging a command.

## Command Surface

The command vocabulary is:

| Command | Public adaptation |
| --- | --- |
| `bind` | Calls `Keiyaku.bind` with Markdown and structured options. |
| `amend` | Calls `keiyaku.amend` with the operation Markdown and structured options. |
| `deliver` | Calls `keiyaku.deliver`. |
| `review` | Recovers `keiyaku.delivery()` and calls `Delivery.review`. |
| `abandon` | Calls `keiyaku.abandon`. |
| `arc` | Calls `keiyaku.arc` with arc Markdown. |
| `status` | Calls `repo.status()` and optionally filters its returned board. |
| `audit` | Calls `keiyaku.audit`. |
| `reconcile` | Calls the selected public reconciliation method. |

`bind` accepts no contract positional. Commands addressing an existing contract
accept a full `kei/<machine-contract>` identity or an active short
`@<machine-contract>` reference. The short reference is the deterministic
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
deliver [<contract>|@<contract>] [--actor <actor>] [--json]
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

`bind` maps `--target`, `--here`, repeated `--after`, `--gates`, and `--actor`
to `Keiyaku.bind`. `--here` maps to `workspace: "here"`; the omitted form maps
to its public default. `amend` maps Markdown, `--actor`, repeated `--after`,
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

`deliver` accepts `--actor` and `--json`. `review` requires exactly one of
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
| `accepted` | `verb`, `contract`, `head`, accepted `facts`, observed `effects`, optional flat `lag`, optional presentation diff, and an audit `report` | 0 |
| `refused` | typed refusal and observed grounds | 1 |
| `retry` | exhausted or unknown retry detail | 2 |
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

Text presents accepted facts, then effects, then flat lag. It does not replace
observed data with a repair command.

A successful amendment compares canonical rendering of `receipt.prior.body`
with `receipt.snapshot.body`. The formatter produces a three-context-line
unified diff using the pure-JavaScript `diff` package. An unchanged comparison
omits the presentation diff. The pre-write read used to acquire amendment input
never supplies the presentation predecessor.

Audit omits diff content unless `--show-diff-body` is present. It obtains the
Delivery from the public handle and renders diff text when available. A `null`
public diff renders:

```text
{ reason: "transport-unavailable", snapshotId, changeId }
```

This is an observation with exit `0`, contains no raw Git error, and is not
added to the audit report. Audit renders its public report and receipt; it does
not inspect journal entries, delivery coordinates, raw process output, or
timestamps.

The status board renders the `StatusReport` returned from one public world read.
A one-contract status view filters that same board. The board exposes the
public row fields and remains a rendering surface rather than another
observation path.

## Product Boundary

The CLI package entry is a shebang-only executable with no exports. Parser,
usage errors, renderers, and `main` are not package API. The CLI imports the
package root and its own modules only; it does not define package-root library
behavior.

Contract commands accept no task coordinate and produce no task mutation or
settlement effect. Task coordination and its associations are owned by the
external task product.

The surface has no interactive mode, input envelope, independent JSON schema,
per-command JSON payload, configurable attempt count, command alias, or
additional top-level command.
