# CLI

`keiyaku` turns argv and acquired input into public package calls, then
renders their public results. It owns neither
document decoding, lifecycle decisions, Git discovery, delivery preparation,
Verification execution, or reconciliation semantics.

## Invocation And Scope

The canonical spelling is:

```text
keiyaku [-C <path>] [--repo <path>] <command> [<contract>|@<contract>] [--flag ...] [-]
```

`-C <path>` and `--cwd <path>` are two spellings of the global invocation cwd;
canonical examples use `-C`. Either spelling may appear before or after the
command, but they may not be combined or repeated. The value is resolved
against the process cwd; omission means the process cwd. This canonical cwd is
the base for relative argv paths, invocation Repo discovery, and Akuma
execution. Together with the discovered Repo's primary worktree, it feeds
World resolution; the cwd itself is never product identity.

`--repo <path>` is the explicit Contract Git coordinate. It resolves against
the invocation cwd and may name any path inside the intended repository. It
does not replace the invocation Repo used for World resolution or change Task,
Settings, or Akuma execution cwd.

The edge discovers the optional invocation Repo once, calls `World.resolve`
once, and reuses that resolution across every reader and creating operation.
Read commands use its current root, Akuma call uses its non-writing candidate,
and operations that require marker custody use its establishing operation. A
call refusal before Akuma birth therefore creates no World marker or runtime
storage.
Without `--repo`, the invocation Repo also serves Contract selectors, verbs,
reconciliation, Dispatch, and composite observation. Explicit `--repo` adds a
separate Contract Repo consumed by Contract verbs, `reconcile`, `call
--contract`, fork inheritance, and `wait` or `kill` with a complete `kei/...`
selector. Composite `status` and every `ls` projection use only the invocation
Repo so a report cannot join two Worlds. Fleet reads use it only for public
Dispatch association. Task, Settings, install, Contract-free call, and
non-Contract catalogs do not consume Repo. Any unused explicit `--repo` is a
typed usage refusal.

The CLI uses only public `Repo`, `Keiyaku`, and `Delivery` values. No package
operation resolves a path or reads the working directory again.

The parser performs argv lexing and syntax only. It extracts the two global path inputs,
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
| `show` | Calls `keiyaku.guidance()` for one selected Contract. |
| `ls` | Lists exactly one selected Task, Contract, Akuma configuration, or Akuma identity directory. |
| `audit` | Calls `keiyaku.audit`. |
| `reconcile` | Calls the selected public reconciliation method. |
| `settings` | Constructs and observes the shared read-only Settings resource. |
| `install` | Installs the bundled Keiyaku skills through one or more native harness installers. |
| `task ...` | Calls the separate `./task` public surface described below. |
| `call`, `fork` | Call the package-root Akuma facet so Dispatch and Alias integration is not reimplemented at the edge. |
| `wait`, `tell`, `history`, `kill` | Call the corresponding package-root Akuma facade capability as root verbs; `tell --interrupt` selects the composed interrupt capability. |

`bind` accepts no contract positional. Existing Contract commands accept a full
`kei/<contract-segment>` or active `@<contract-segment>` reference. The short
reference resolves over `ContractBoard` rows and is never stored.

An omitted contract selector is valid only when the invocation coordinate matches
the reported `worktreePath` of exactly one active worktree contract. A here
workspace never supplies omitted-selector inference. The adapter issues a
typed usage refusal when this test has no unique match.

Command syntax:

```text
bind [--task <task/...>] [--target <ref>] [--here] [--after <kei/...> ...] [--gates <name>] [--actor <actor>] [--json] -
amend [<contract>|@<contract>] [--after <kei/...> ... | --clear-after] [--gates <name>] [--actor <actor>] [--json] -
deliver [<contract>|@<contract>] [--message <text>] [--actor <actor>] [--json]
review [<contract>|@<contract>] (--satisfied | --unsatisfied) [--summary <text>] [--actor <actor>] [--json] [-]
abandon [<contract>|@<contract>] [--note <text>] [--actor <actor>] [--json]
arc [<contract>|@<contract>] [--actor <actor>] [--json] -
status [<contract>|@name|<aku/...>] [--json]
show [<contract>|@<contract>] [--json]
ls task/ [--json]
ls kei/ [--json]
ls aku/ [--json]
ls aku/<akuma>/ [--json]
ls aku/*/* [--json]
audit [<contract>|@<contract>] [--include-dirty] [--show-diff-body] [--actor <actor>] [--json]
reconcile [<contract>|@<contract>] [--retry-hooks] [--json]
settings [--json]
install <codex|claude|opencode|pi> [--json]
       install --all [--json]
call <akuma-name> [--contract <kei/...>] [--alias @name] [--wait <duration> | -d | --detach] [--json] (<prompt> | -)
wait <akuma-selector>... [--any | --all] [--timeout <duration>] [--json]
tell <aku/...|@alias> [--interrupt] [--json] (<prompt> | -)
history <aku/...|@alias> [--before <index> | --since <index> | --last] [--json]
fork <aku/...|@alias> --at <historyId> [--json]
kill <akuma-selector>... [--json]
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
Stdin acquisition is awaited and completes before command adaptation begins;
no synchronous read, lazy stream wrapper, or background input queue exists.

After complete bind stdin has been acquired, a bind refusal or invalid Contract
document preserves those exact bytes as a CLI receipt at
`.keiyaku/draft/bind-<hex64>.md`, where `hex64` is the complete hexadecimal
SHA-256 content hash. The path is immutable for those bytes, so
concurrent distinct failures have distinct receipts and repeated equal failures
are idempotent. Creation or repair uses an atomic same-directory replacement;
an equal existing receipt keeps its bytes and renews its retention age. The CLI
prints the path only after exact bytes are present. Each successful preservation
also removes bind drafts older than seven days; successful binds never touch the
draft directory. Draft write or sweep failure adds one warning without changing
the bind result or exit status. The receipt is CLI-owned transient input custody,
not Contract or Library state; recovery submits it through the ordinary `bind -`
entry point.

`bind` maps `--target`, `--here`, repeated `--after`, `--gates`, and `--actor`
to `Keiyaku.bind`. An explicit `--target` remains literal input for the public
target boundary. When it is omitted, the adapter supplies
`repo.currentBranch()`; an attached branch therefore becomes the canonical
target, while detached HEAD remains explicitly targetless. The parser itself
does not inspect Git. An accepted bind result exposes the persisted canonical
target, or `null`, so this default is never hidden. `--here`
maps to `workspace: "here"`; on an attached branch the same default target
makes it a commit-in-place contract. An explicit foreign target with `--here`
is a typed bind refusal. The omitted form maps to the public managed-worktree
default.
`amend` maps Markdown, `--actor`, repeated `--after`,
and `--gates` to `keiyaku.amend`. Its omitted `after` leaves the current value
unchanged, while `--clear-after` maps to `after: []`; it is mutually exclusive
with `--after`. `bind`, `amend`, and `arc` require their final `-` document
input. Amend leaf help includes this one minimal legal stdin operation. The
complete amendment-operation grammar remains in [document.md](document.md).

```text
minimal stdin:
  ## Replace: Design
  <complete replacement>
```

Every Contract mutation and `reconcile` reads one Settings observation at the
CLI edge and derives one `WorktreeHooks` value through the package-root
consumer. It passes that pure value into the public operation; the CLI never
runs hook commands or reads marker files. `reconcile --retry-hooks` maps to
`retryHooks: true`. It retries only a failed marker phase with its frozen
commands and does not recapture edited settings for an existing worktree.

`deliver` and `audit` do not pass that caller-derived value into Verification
scratch. Their package-root operation reads only the tracked project Settings
in the materialized integration snapshot before Verification starts. The CLI
has no Verification timeout or caller-cancellation flag; an optional timeout
belongs to each declaration fence in Contract Markdown.

Repository `.keiyaku/settings.json` may supply named gate snapshots and the Git
delivery policy for the edge:

```json
{
  "gates": {
    "default": ["reviewed"],
    "strict": ["reviewed", "verified"]
  },
  "git": {
    "requireBranchesToBeUpToDate": false
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

`deliver` accepts an optional materialized-commit `--message`, `--actor`,
`--include-dirty`, and `--json`. It requires a clean workspace by default.
`--include-dirty` authorizes one complete capture of all non-ignored staged,
unstaged, and untracked final bytes; it is not a staged-only mode or path
selector. Dirty submodule internals still refuse. Its up-to-date policy comes
from the settings consumer at `git.requireBranchesToBeUpToDate`; there is no
per-deliver policy flag.
`review` requires exactly one of
`--satisfied` or `--unsatisfied`, with optional `--summary`, `--actor`, and
`--json`. It has no dirty authorization flag; if the observed projection is
dirty, the accepted result discloses the ordinary dirty paths and short stat.
Dirty submodule internals still refuse because no review projection can seal
them. `abandon` accepts optional `--note`, `--actor`, and `--json`; it has no
reason flag or hidden reason classification. `arc` accepts `--actor` and `--json`. `audit` accepts `--actor`, `--json`,
the same `--include-dirty` authorization as deliver, and `--show-diff-body`.
`--show-diff-body` selects the public `showDiff` input. The prospective
predecessor-to-candidate value lives only on `report.preview.diff`; text
renders that report-owned body once, and JSON does not add a second `diff`
field. This is not a Delivery read performed before audit. Audit does not accept a custom commit
message. Its up-to-date policy is the same Settings consumer used by deliver.
`status`, `show`, and `reconcile` accept `--json`.
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

`call` and `tell` each accept exactly one prompt source: one positional
`<prompt>` argument, or a final `-` that reads stdin. Supplying both or neither
is a usage refusal. The selected argument text or stdin bytes become the public
body input. The `call` positional `<akuma-name>` names
`~/.keiyaku/akuma/<name>.md`; its provider must resolve through the
Settings-backed provider interpretation. When no same-name Settings entry
exists, the built-in fallback execution names are `claude` and
`codex-app-server`. A missing name prints exactly `` `<name>` was not found ``
and `` use `keiyaku ls aku/` to list available Akuma ``. Its typed error retains
the searched coordinate, but text does not print that path. `--contract`
accepts one complete `kei/...` identity, constructs its
handle from the selected Contract Repo, and asks the package-root call to publish
Dispatch after birth. It is not a lifecycle gate and does not accept an
omitted or `@` Contract selector. `--alias` accepts the sole `@name` grammar and
assigns that world-local selector to the born Akuma after any Dispatch succeeds;
when the Alias already exists, it moves to the born Akuma. Both flags are
optional. For `call --contract`, explicit `-C` or `--cwd` supplies the
canonical invocation cwd; omission lets Library use the appointed managed
worktree. Contract-free calls always use the invocation cwd. The CLI has no
other execution-cwd input and never derives a Place path.
Call waits on the born Akuma for five minutes by default and consumes the same
public status carrier as `wait` when it stops running or that window ends. An
answered terminal observation writes the exact answer bytes and nothing else.
An open observation uses the shared snapshot text. A terminal failed outcome,
typed Dispatch or Alias failure, or readonly-none refusal remains a visible
diagnostic rather than an answer. `--wait <duration>` keeps wait mode and
replaces the five-minute observation window. `-d` and `--detach` are identical
and return after birth plus Dispatch and Alias integration. A successful detach
prints `$ keiyaku wait <AkuId> --timeout 5m` with the complete born identity.
Dispatch failure, Alias failure, or a readonly-none refusal keeps its existing
factual lines and does not add that command. Detach does not fabricate a current
life. It is mutually exclusive with `--wait`.
`tell`, `history`, `fork`, and exact `status` accept a complete
`aku/<akuma>/<hex8>` or world-local `@alias`. `wait` and `kill` additionally
accept Akuma globs and complete `kei/...` worker selectors. Their positional
set is expanded once, deduplicated, and byte-sorted before the operation.
Multiple wait members require exactly one of `--any` or `--all`; a single
member needs neither. Kill always applies to the complete frozen set.
Bare `status` already exposes the Akuma fleet through Kanshi; there is no
second raw-roster flag. Library `world.of()`
constructs the addressed handle and has no CLI command of its own.
Bare `ls` renders the command's own help and exits successfully. It does not
locate or create a World, construct a Repo or Settings value, or read Git,
Task, Akuma configuration, or Akuma state. The accepted path grammar is closed and uses
the canonical directory spellings above; missing trailing slashes, exact
identities, Alias selectors, and other paths are usage errors.

`ls task/` lists Task rows from one complete Task-owned catalog snapshot. `ls kei/` lists Contract rows whose persisted
identities remain `kei/...`, and `ls aku/` lists Akuma configurations with
name, optional model, and complete description. `ls aku/<akuma>/` lists
compact instances of that named Akuma, while `ls aku/*/*` explicitly lists all
compact instances. Each invocation reads only the selected owner and performs
no Kanshi join or activity/history read. JSON is the selected Catalog result,
not an aggregate envelope. `status @name` remains an Address-facet decision
and refuses explicitly when the spelling is both an active Contract short
selector and an Akuma Alias.
CLI `wait` uses the public default predicate (`life !== "running"`). Its
optional `--timeout` value and `call --wait` value match exactly
`^(0|[1-9][0-9]*)(ms|s|m|h)$`: integers and units are required, leading zeroes
are refused except for zero itself, and the units convert to milliseconds
before the public call. A converted value beyond the safe integer range is
refused. Each duration passes that value as `timeoutMs`, while predicate
functions remain library-only input. `history`
with no mode renders the newest page of at most 50 semantic rows. `--before`
reads the page preceding an already visible activity index; `--since` reads
activity following an already visible index. Both are exclusive, accept only
positive safe integers, and are mutually exclusive with each other and
`--last`. `--last` writes the complete answer from the last answered turn,
skipping later failed turns; it does not read activity or append framing. With
no answered turn, text writes `no answer retained` and JSON exposes the typed
`{ "kind": "no-answer", "id": "..." }` arm. An answered empty string remains
an answer and writes zero bytes in text mode. Both last-answer arms exit zero
because each is a successful read result.
`fork` requires one nonblank `--at` history id and has no stdin body.
The adapter supplies an explicit Contract Repo when selected, otherwise the
invocation Repo when `-C` is inside Git, and no Repo outside Git. The facade
alone reads and propagates a parent Dispatch; CLI never reads Dispatch or Alias
files.

## Akuma Text Surface

Akuma text is one pure projection over public values. Provider adapters retain
facts, the Akuma timeline projection folds and selects rows, and the CLI chooses
which public result a command presents without repairing, reselecting, or
reinterpreting activity. JSON exposes that same value with complete ISO `at`
values and no text-only time suppression.

Readonly `none` renders its diagnostic as an existing `!` line; native or
absent renders nothing. This presents the public fact and adds no CLI judgment.
Every rendered snapshot begins with the five-column `U+2500` opening stroke,
then the complete AkuId and optional frozen Alias. When a Contract is
associated, its complete `kei/...` identity is one hanging relation line
beginning with `U+2514` and `U+2500`; an unassociated Akuma omits that line.
Identity rows never contain current life, and no divider or blank line splits
the relation from the following activity. Status, unfinished or non-answered
single-target wait, every multi-target wait, unfinished observed call, and kill
end with the public life on a subdued trailing line. Ordinary and interrupt
tell compose the refreshed snapshot without a current-life claim; history does
the same for its page, while `history --last` writes exact answer bytes. An
ordinary answered single-target wait and an answered default call likewise
write only those answer bytes; a successful detached call prints its born
identity and `$ keiyaku wait <AkuId> --timeout 5m`. The id already contains the
Akuma name
and the CLI never reverse-selects an Alias. Text never prints the storage
words `retained`, `latest`, `body`, `heart`, or `turn`.

Shared activity-row layout, snapshot budgets, clipping, time gutter, glyphs,
and omission placement are owned by [cli-output.md](cli-output.md). This command
chapter delegates that presentation: it adds no TIMELINE or STATUS header,
full-width decorative rule, equal-sign divider, semantic icon on the opening
stroke, or second rule between relation and activity.

Tell remains one input action. Text presents the refreshed shared snapshot;
only a wake or interrupt failure adds an error line. The current tell appears
once at its observed two-state face; mutation authority remains separately
available in the typed Library result and JSON value.
`⧗ tell` means it can still take effect, and `told` means the provider's
strongest available evidence proves it took effect. Pending tells are never
removed by the snapshot budget.
Provider-specific receipt kinds, handoff stages, fences, and `bodySequence` never enter text. JSON preserves the
mutation/observation separation as `{ akuma, tell, observation }` without adding
a CLI-only diagnostic projection. No output asks the caller to query a TellId.

`tell --interrupt` selects the Library's fenced interrupt composition. It is
one CLI input action, not a standalone lifecycle verb: the current Body is
asked to yield through its owned capability, the leash proves clean settlement,
and only then is the selected prompt durably recorded before its successor is
woken. A hung or untidy result is reported without external process
signaling. Text uses the same refreshed snapshot as the other Akuma mutations.
JSON returns the Library result unchanged; the CLI does not infer a second
receipt or observation.

A stranded Akuma whose durable coordinate cannot be resumed prints
`resume unsupported` as its typed reason. The CLI does not offer an automatic
fresh fallback or delete the coordinate.

Tool presentation is one pure function. A completed run prints immutable
duration and then `ok`, `exit <code>`, or `error`; an unfinished run omits the
suffix. At narrow width the outcome is omitted before the command subject is
lost. Conservative bash/zsh and PowerShell transport unwrapping is
display-only and leaves an ambiguous command unchanged. A read prints its path
and, when present, `L<start>-<end>`, `from L<start>`, or a positive line count.
Search scope chooses the label: `search` for content or an absent scope,
`find` for files, and `web` for web. The body is the query plus supplied path
and glob only; the internal scope token is never printed.
One file change prints its operation and path. Multiple changes print
`edit <n> files · <representative-path> ...`; an aggregate `+<n> -<n>` appears
only when every change has a diffstat. Missing optional provider facts shorten
the row and never produce placeholders. The renderer does not reconstruct
provider payloads, classify shell commands, or look up cwd or repository paths.

History pages retain the same public row order and unbounded row text, rendered
through the shared timeline presentation without a current-life observation.
Answer boundaries name the complete AkuId in `keiyaku history <AkuId> --last`;
native provider history ids never become CLI selectors. `history --last`
bypasses the page and writes only exact answer bytes.

## Product Boundary

The CLI package entry is a shebang-only executable with no exports. Every
build recreates it with POSIX execute permission before packaging or linking. Parser,
usage errors, renderers, and `main` are not package API. The CLI adapts the
package-root facade and the separate `./task` and `./akuma` product surfaces;
it does not define their library behavior or obtain a raw scope, token,
registry, or orchestrator. Package-root call and fork are not reimplemented
through direct Akuma product calls at this edge.

Contract commands accept no task coordinate and never interpret or perform a
Task mutation; the CLI merely renders package-root results. Bind, amend,
deliver, review, and abandon share the mutation receipt grammar owned by
[cli-output.md](cli-output.md).

`region [<contract>] [--overlap] [--json]` reads active declared Regions;
`region --path <repo-relative-path> [--json]` reverse-queries one canonical
path. A positional selector without `--overlap` is the Contract's own
declaration. Bare `region` declares the world view, while `--overlap` is the
only relation trigger. `--path` cannot combine with a selector or overlap.
The CLI adapts Kanshi's typed Region section and never decodes documents or
recomputes patterns. Missing or terminal selectors use the existing typed
selector refusal; invalid paths are usage refusals before the read.

The surface has no interactive mode, input envelope, independent JSON schema,
configurable attempt count, command alias, or `scope` alias. The
report `root` remains the invocation world coordinate.
