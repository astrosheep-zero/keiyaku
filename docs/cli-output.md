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

Kanshi is the one aggregate surface with a brand signature. Its first line is
one responsive Split Horizon geometry:

```text
kanshi ─── <keiyaku-count> keiyaku · <akuma-count> akuma · <task-count> task ─── <world>
```

The left word identifies the observer, the middle is the aggregate fact, and the
right side is the observed world coordinate. The two horizontal segments use
`U+2500` and flex to the available display width, with at least one character
on each side; they never hide or shorten the facts. When the complete coordinate
makes the minimum signature wider than the viewport, the signature remains one
scan line and exceeds the viewport rather than folding or truncating. A present
empty board keeps
all three zero counts. An absent world has no signature because there is no
observed world to frame. Other commands start directly with their operation
identity and do not receive a global banner.

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

Akuma text has one shared snapshot presentation across status, wait, call, tell,
interrupt, and kill; history remains the unbounded browsing surface. Snapshot
budgets are fixed by semantic kind: `say` at most three lines, `tell` one, and
every other activity row two. Text clipping and receipt presentation never alter
the public value serialized by `--json`.

Snapshot omission is reported by the typed snapshot count; history retains its
own cursor, gap, and loss metadata. Text is clipped by terminal display width without splitting grapheme clusters; quoted
voice keeps balanced delimiters. A `run` command remains one row and preserves
recognizable head and tail when clipped; its outcome is shown only when space
allows. History uses the same presentation vocabulary without snapshot budgets.
Each displayed activity minute starts one `── HH:MM ──` divider, and every
event whose rendered clock is that same minute follows without indentation.
Adjacent minute groups are separated by one blank line. The divider uses line
glyphs rather than equals signs and adds no event column. Wrapped continuation
text aligns beneath the first content byte. There is no derived silence or date
line.

```text
── 18:08 ──
✓ say: previous conclusion

── 18:09 ──
· say: checking again; the projection still carries
       activity from the previous Turn
· think: projection may own the bug
⧖ run: $ npm test
```

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
lag unsealed-bytes <path> [head=<snapshot>] [paths=<path>,...]
lag target-checkout-retained <target> <path> <diagnostic>
lag worktree-hook-failed <create|destroy> <path> command=<index> <failure-json>
```

JSON exposes that same `lag` array. An `unsealed-bytes` or
`target-checkout-retained` lag does not turn an accepted result into a refusal
or alter its exit status.

A dirty-workspace refusal uses one line per classified path, followed by the
complete-tree short statistic and the authorization option:

```text
refused deliver <contract> dirty-workspace
dirty staged <path>
dirty unstaged <path>
dirty untracked <path>
dirty submodule <path>
shortstat files=<count> insertions=<count> deletions=<count>
option --include-dirty <available|unavailable>
```

The option is unavailable exactly when dirty submodule internals are present;
otherwise the line exposes the flag that can authorize the listed ordinary
workspace bytes. JSON carries the same refusal facts plus the CLI-owned option
projection. The renderer does not run Git or infer another path classification.

An accepted review that observed ordinary dirty workspace bytes prints one
structured disclosure line:

```text
workspace {"staged":[...],"unstaged":[...],"untracked":[...],"shortStat":{...}}
```

The line has no authorization option because review observes a projection; it
does not authorize delivery. JSON carries the same `workspace` object. Dirty
submodule internals still refuse before review admission.

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
An environment failure renders in that same `stop verification` value with its
command index and typed command failure. A declaration timeout is an
unsatisfied attestation fact, not a stop.

A failed scratch destroy command renders without claiming that the worktree
remains:

```text
cleanup destroy command=<index> <failure-json>
```

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
