# CLI Output

This chapter owns help, rendering, and exit status.

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
  { kind: "target-checkout", path, target, action },
  { kind: "ref", name, before, after }
]
```

The flat `lag` array is the public `ReconcileResult` shape defined in
[git-reconciliation.md](git-reconciliation.md); the CLI does not wrap or translate it. Its text
form is one direct line per member:

```text
lag worktree-retained <path>
lag target-checkout-retained <target> <path> <diagnostic>
lag worktree-hook-failed <create|destroy> <path> command=<index> <failure-json>
```

JSON exposes that same `lag` array. A `worktree-retained` or
`target-checkout-retained` lag does not turn an accepted result into a refusal
or alter its exit status.

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
{ reason: "git-unavailable", integrationSnapshot, changeId }
```

This is an observation with exit `0`, contains no raw Git error, and is not
added to the audit report. Audit renders its public report, head, and facts; it does
not inspect journal entries, delivery coordinates, raw process output, or
timestamps.
