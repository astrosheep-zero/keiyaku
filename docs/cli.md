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
against the process cwd; omission means the process cwd. The edge retains
whether this value was explicit: `-C` is stated Akuma cwd input, while ambient
process cwd is initiator context. The canonical value remains the base for
relative argv paths and Repo and World discovery; the cwd itself is never
product identity.

CLI filesystem inputs resolve once at this edge to an existing, canonical
absolute native path. The CLI passes that native coordinate directly to Repo,
World, and Git; it does not interpret another platform's path spelling. In
particular, Git Bash/MSYS converts ordinary `/c/...` shell arguments before
Node starts. Raw MSYS path syntax that bypasses that conversion is outside the
CLI grammar.

`--repo <path>` is the explicit Contract Git coordinate. It resolves against
the invocation cwd and may name any path inside the intended repository. It
does not replace the invocation Repo used for World resolution or change Task,
Settings, or Akuma execution cwd.

The edge resolves the optional invocation Repo and World once per call. Without
`--repo`, that Repo also serves Contract selectors, verbs, reconciliation,
Dispatch, and composite observation. Explicit `--repo` adds a separate Contract
Repo for Contract operations and complete `kei/...` Akuma selectors. Composite
`status` and every `ls` use only the invocation World, so reports never join two
Worlds. Contracted call and fork inheritance use the selected Contract Repo.
Commands that consume no Contract Repo refuse an unused `--repo`. A call
refused before Akuma birth creates no World marker or runtime storage.

On Windows, every CLI-owned child process is created without a visible
auxiliary console window.

The process edge maps optional `KEIYAKU_GIT_PATH` to the public `Repo.at`
`gitPath` input for both invocation-World discovery and an explicit Contract
Repo. An absent value preserves the literal executable `git`; a present blank
value is usage when coordinate resolution is entered. The edge passes all
other bytes unchanged, including native Windows paths. Commands completed
before coordinate resolution, including help and `install`, do not consume the
variable. No library or Git module reads `KEIYAKU_GIT_PATH`.

The parser owns argv syntax, including arity, duplicates, unknown flags, mutual
exclusion, and stdin selection. It performs no product observation or
judgment. Help completes at this dependency-light edge. After a non-help parse,
the invocation adapter loads only the selected command family's execution and
rendering graph, then calls the corresponding public operation without a second
command-specific behavior layer.

## Command Surface

`keiyaku nuke [--json]` refuses with the required confirmed form for the
invocation World. `keiyaku nuke --confirm <WorldRoot> [--json]` executes the
Keiyaku-owned reset described in [world.md](world.md) when the literal
confirmation equals the resolved WorldRoot byte-for-byte. It accepts no
Contract positional argument, stdin, token, snapshot hash, prompt, or
per-owner confirmation. `--repo` has no consumer for this command.

The command vocabulary is:

| Command                           | Public adaptation                                                                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `bind`                            | Calls `Keiyaku.bind` with the pinned Repo, Markdown/structured options, or the explicit sibling fork form.                          |
| `amend`                           | Calls `keiyaku.amend` with the operation Markdown and structured options.                                                           |
| `deliver`                         | Calls `keiyaku.deliver`.                                                                                                            |
| `review`                          | Calls `keiyaku.review`; in a declared request channel it forwards one hop through the direct parent.                                |
| `abandon`                         | Calls `keiyaku.abandon`.                                                                                                            |
| `arc`                             | Calls `keiyaku.arc` with arc Markdown.                                                                                              |
| `status`                          | Calls Kanshi or one or more exact Contract/Akuma status projections according to its selectors.                                     |
| `show`                            | Calls `keiyaku.guidance()` for one selected Contract.                                                                               |
| `ls`                              | Lists exactly one selected Task, Contract, Akuma configuration, or Akuma identity directory.                                        |
| `audit`                           | Calls `keiyaku.audit`.                                                                                                              |
| `reconcile`                       | Calls the selected public reconciliation method.                                                                                    |
| `settings`                        | Constructs and observes the shared read-only Settings resource.                                                                     |
| `install`                         | Installs the bundled Keiyaku skills through one or more native harness installers.                                                  |
| `task ...`                        | Calls the separate `./task` public surface described below.                                                                         |
| `call`, `fork`                    | Call the package-root Akuma facet so Dispatch and Alias integration is not reimplemented at the edge.                               |
| `wait`, `tell`, `history`, `kill` | Call the corresponding package-root capability; Contract history uses its handle and `tell --interrupt` selects composed interrupt. |

`bind --fork-of kei/<complete-id>` reads no stdin and creates a sibling from the
source's current folded terms and original start snapshot. It accepts only
`--target`, `--actor`, and `--json`; `-`, `--task`, `--gates`, and
`--after` are syntax refusals. `bind` accepts no contract positional. Existing Contract commands accept a full
`kei/<contract-segment>` or active `@<contract-segment>` reference. The short
reference resolves over `ContractBoard` rows and is never stored.

An omitted contract selector is valid only when the invocation coordinate matches
the reported `worktreePath` of exactly one active worktree contract. The adapter
issues a typed usage refusal when this test has no unique match.

Inside an Akuma request channel, `deliver` still resolves its Contract
selector to one complete ContractId before publishing the claim and preserves
the selected Contract Repo as its normalized primary-worktree coordinate. The
claim also contains only that id, optional message, `includeDirty`, and
`materializeConflict`; the
direct parent reconstructs the selected Repo, reads Settings and hooks scoped
to it at execution time, and uses the same local Contract executor. It never
substitutes the parent World for an explicit `--repo`. The CLI does not create
a second delivery path or carry its own actor or Git policy across the channel.
The live command receives the ordinary Contract result, including a
materialized conflict value; later request
settlement neither replays delivery nor fabricates that live result.

Command syntax is owned by each command family's help rows; `--help` renders
the authoritative usage for every command.

Bare `status` has no `--all`, limit, or alternate text mode. Its bounded text
board and complete inspection paths are owned by [cli-output.md](cli-output.md)
and [kanshi.md](kanshi.md); `--json` is the complete typed Kanshi projection.
`keiyaku ls task`, `keiyaku ls task/`, and trailing-slash
`keiyaku ls task/<segment>/.../` select the complete Task catalog with exact
namespace filtering. `keiyaku ls kei/` is the pure Contract catalog: active rows only, no World,
Task, Alias, Dispatch, Akuma, holder, or namespace joins. Selected
`keiyaku status kei/<id>` constructs the complete Contract board and then
selects. World `keiyaku status` keeps its outer joins and does not reinterpret
Contract lifecycle.

## Inputs And Flags

Standalone `-` is the stdin marker: once, at any argument position.
Scanning continues, and `-C`/`--cwd`/`--repo` may follow.
For ordinary `bind`, it reads one contract document; the `--fork-of` form reads
no stdin. For `amend`, one amendment-operation document when `-` is present; for
`arc`, one arc document; and for `review`, the required summary. Review takes
exactly one summary source: `--summary <text>` or `-`. Neither or both is a
usage refusal. No other Contract command reads stdin. Akuma and Task stdin
entry points follow their command grammars. Document input grammar is owned by
[document.md](document.md).

Argv decides whether stdin is required or allowed before bytes are acquired.
Acquisition failure exits `3`; syntax and edge validation remain usage
refusals. Required blank input is usage before any product invocation. Valid
bytes pass through unchanged, including line endings and surrounding
whitespace.

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

Ordinary `bind` maps `--target`, repeated `--after`, `--gates`, and `--actor`
into bind. An explicit `--target` remains literal input for the public
target boundary. Omitting `--target` selects current-branch intent, resolved
in the same bind coordinate observation used for admission. An attached
existing branch becomes the canonical target; detached committed HEAD remains
targetless; unborn HEAD returns `unborn-head`, never `target-missing`. The
parser does not inspect Git or pre-read a branch name as an explicit target.
An accepted bind result exposes the persisted canonical target, or `null`, so
this default is never hidden.
Fork bind copies the source target when `--target` is omitted and copies its
start exactly. It always uses a fresh managed worktree.
It stores no source or comparison relation.
`amend` maps optional Markdown, `--actor`, repeated `--after`,
and `--gates` to `keiyaku.amend`. Its omitted `after` leaves the current value
unchanged, while `--clear-after` maps to `after: []`; it is mutually exclusive
with `--after`. `-` selects one nonblank H2 operation document. Its
absence requires at least one of `--after`, `--clear-after`, or `--gates` and
does not acquire stdin; otherwise parsing is usage before observation. `bind`
and `arc` still require `-`. Amend leaf help
enumerates the operation headings and keeps the target forms distinct for
criteria and extensions. Body semantics remain owned by the document chapter.

Every Contract mutation and `reconcile` passes one CLI-observed `WorktreeHooks`
value to the public operation; the CLI never runs hooks or reads markers.
`--retry-hooks` retries the complete current hook phase; hook authors own
idempotence. Verification instead reads
tracked Settings from the integration snapshot. The CLI has no global
Verification timeout or cancellation flag.

Repository `.keiyaku/settings.json` may supply named gate bundles and the Git
delivery policy for the edge:

```json
{
  "gates": {
    "default": { "kind": "bundle", "gates": ["reviewed"] },
    "strict": { "kind": "bundle", "gates": ["reviewed", "verified"] }
  },
  "git": {
    "requireBranchesToBeUpToDate": false
  }
}
```

A catalog name and each bundle leaf match `^[a-z][a-z0-9-]{0,63}$`.
`--gates a,b,c` selects entries in CLI order; empty or invalid comma segments
are usage. Argv parsing only separates nonempty segments; the Contract Settings
consumer is the sole judge of catalog-name grammar. The adapter expands
selected bundles, removes duplicate leaves at their first occurrence, and
passes only that concrete array to the public operation. Bundle leaves are the
current producer tokens `reviewed` and `verified`, not references to other
entries. Bind selects `default` when its
flag is omitted and uses `["reviewed"]` when that entry is absent; amend
retains its current public value when its flag is omitted. A present empty
default bundle selects no gates. A malformed Settings scope, malformed
selected entry, or explicitly selected unknown name is a typed usage refusal;
unselected future-kind records are not validated.

`deliver` and `audit` require a clean workspace unless `--include-dirty`
authorizes the complete non-ignored final tree; dirty submodule internals still
refuse. `--materialize-conflict` is deliver-only and is consulted only after
the one integration judge returns `reason: "conflict"`. On conflict, omission
returns the typed failure with recovery values; the flag projects that judged
conflict into the appointed workspace. It does not override the clean-workspace
materialization precondition. After materialization, resolve the conflicted
files and continue with `deliver --include-dirty` while the merge stays
uncommitted; a committed merge continues with plain `deliver`. No recovery step
requires `git add`. Their up-to-date policy comes only from Settings. `review` requires one
verdict and one summary source, has no dirty authorization, and discloses
ordinary dirty bytes when accepted. `--diff` maps to audit `showDiff`; the value
lives only at `report.candidate.diff`, including `""`. `--show-diff-body` is
usage. Other listed scalar operands must be nonblank. `--json` affects output
only.

`install` is the one edge command that does not read a repository or Git. It
uses native harness installers; `--all` runs the supported harnesses in fixed
order and continues after failures. Pi installs the published
`npm:@astrosheep/keiyaku` package, so its extension and skills are managed by
Pi rather than by a path into the invoking CLI installation. Text and JSON
expose one typed result per harness; any failure exits `1`.

`call` and `tell` accept exactly one nonblank positional or stdin prompt
and pass its bytes unchanged. The CLI maps `KEIYAKU_HOME` once for the
explicit Akuma home; provider selection remains a library concern. Missing-name
text names the input and points to `keiyaku ls aku/`.

`--contract` accepts one complete `kei/...` and requests Dispatch after birth;
`--alias` accepts `@name` and moves that world-local Alias only after Dispatch
succeeds. Repeated `--allowed` values add actions to the Archetype defaults;
an empty repeated set carries no clearing meaning. The vocabulary is owned by
[akuma-allowed.md](akuma-allowed.md). Explicit invocation cwd wins for a
contracted call, otherwise its
appointed managed worktree is used. A direct Contract-free call uses ambient
process cwd; a nested omitted call inherits its hosting caller Soul cwd.
Call waits five minutes by default. `--wait` replaces that duration, while
`-d`/`--detach` returns after birth and composition and excludes `--wait`.
Before Body spawn, the edge resolves the caller's path-independent
`squareAssignedParticipantName` through Square, lazily opens `<WorldRoot>/.square/KEIYAKU.square`,
explicitly joins and binds that name, and establishes a listener for the allocated
Aku. The call edge and Body use the same `<WorldRoot>/.square/KEIYAKU.square`
target for call activity and the initial outcome. Missing or ambiguous caller
assignment is a no-op at this edge and still launches. Idempotent join, binding,
and listen create no rollback obligation; launch failure rolls back only facts
created by this call. Rollback attempts unbind, ignore, done, and close
independently; a rollback failure is retained as bounded diagnostic evidence
without replacing the original launch failure. A legacy Square dependency that rejects the allocated Aku
target as an invalid name is treated as the same optional edge no-op, so Square
grammar drift never refuses Akuma birth. Detach returns `{ kind: "detached" }`. Outcome payload and
Body delivery belong to [akuma-execution.md](akuma-execution.md).
Successful detach
prints the canonical-world wait command using the successful Alias or complete
AkuId; failure adds no command and fabricates no life.

`tell`, `fork`, and exact `status` accept one AkuId or Alias. `status` also accepts
multiple `kei/...`, `aku/...`, or Alias selectors and returns one status entry per
input selector in input order. All entries come from the same Kanshi observation
when Contract or Alias resolution is needed; direct Akuma selectors use the
Akuma status authority without constructing a Contract report. `history` accepts
one complete ContractId; `wait` and `kill` additionally accept the documented
set selectors. Bare `status` uses Kanshi; named status resolves one selector
from that observation and refuses cross-kind ambiguity.
When `AKUMA_REQUESTS` identifies a provider drive, call, wait, tell,
and kill use the same package-root operations but are served one hop by that
provider's direct parent; CLI parsing and rendering do not change.
Bare `ls` renders the command's own help and exits successfully. It does not
locate or create a World, construct a Repo or Settings value, or read Git,
Task, Akuma configuration, or Akuma state. The accepted path grammar is closed
and uses the canonical directory spellings above; the final slash is optional
for those directory selectors. Exact identities, Alias selectors, and other
paths are usage errors.

Each `ls` path reads only its selected Task, Contract, Akuma configuration, or
Akuma identity catalog. JSON is that catalog, not an aggregate envelope.
`status @name` refuses cross-kind selector ambiguity.
CLI `wait` uses the Akuma public default completion judgment: life is not
`running` and the observed snapshot contains no pending Tell row. Its
optional `--timeout` value and `call --wait` value match exactly
`^(0|[1-9][0-9]*)(ms|s|m|h)$`: integers and units are required, leading zeroes
are refused except for zero itself, and the units convert to milliseconds
before the public call. A converted value beyond the safe integer range is
refused. Contract history requires a Repo, accepts no cursor, limit, or
`--last`, and calls the selected Contract handle without constructing an Akuma
World. Akuma history with no mode renders the newest page of at most 50 semantic
rows. `--limit`
selects a positive page size no greater than 5000 and otherwise keeps that
default. `--before`
reads the page preceding an already visible activity index; `--since` reads
activity following an already visible index. Both are exclusive, accept only
positive safe integers, and are mutually exclusive with each other. `--last`
is mutually exclusive with `--before`, `--since`, and `--limit`; it writes the
complete answer from the last answered turn,
skipping later failed turns; it does not read activity or append framing. With
no answered turn, text writes `no answer retained` and JSON exposes the typed
`{ "kind": "no-answer", "id": "...", "contract": ... }` arm. An answered empty string remains
an answer and writes zero bytes in text mode. Both last-answer arms exit zero
because each is a successful read result.
`history <aku/...|@alias> --id <historyId>` reads one exact retained answered
or failed outcome and writes its complete answer or diagnostic. `--id` is
mutually exclusive with `--last`, `--before`, `--since`, and `--limit`; blank
or unknown IDs are typed results with nonzero exit. `fork` accepts one complete
`aku/...` or world-local `@alias`, requires one nonblank `--at` history id, and
has no stdin body; failed IDs are non-forkable.
Fork passes the selected Contract Repo, otherwise the invocation Repo when
available. The facade alone reads and propagates parent Dispatch; CLI never
reads Dispatch or Alias files.

`call --readonly` adds the one-way read-only restriction to that newly born
Akuma. Its omission leaves the call RW unless the selected Archetype already
declares `readonly: true`; the CLI has no `--write` counterpart and no live
access toggle.

## Akuma Text Surface

Akuma text is a pure projection over public values; JSON exposes the same value
with complete timestamps. Shared snapshot framing, timeline, task/change blocks,
clipping, and life vocabulary are owned by [cli-output.md](cli-output.md).
The CLI supplies selectors, stdin, cwd, Dispatch, Alias, and wait grammar; it
never exposes provider or Heart internals or creates fallback coordinates.

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

The Region command grammar is exactly:

```text
region [--json]
region <contract> [--json]
region --path <pattern> [--path <pattern> ...] [--json]
```

Bare `region` returns every active declaration. `region <contract>` returns
that active Contract's declaration and every intersection with the other
active declarations. `region --path` accepts one or more repeated flags and
returns every intersection between the ordered query patterns and active
declarations. Query patterns use the Contract Region line grammar owned by
[document.md](document.md); a literal repository path is its degenerate case.
Pattern order and duplicates are preserved. `--path` cannot combine with a
selector. The `--overlap` flag, world-wide pairwise overlap, stdin or
multi-line query input, multiple Contract selectors, and a second
query-pattern dialect are usage refusals or absent grammar. The CLI adapts
Kanshi's typed Region section and never decodes documents or implements
matching. Missing or terminal selectors use the existing typed selector
refusal; invalid query patterns are usage refusals before the read.

The surface has no interactive mode, input envelope, command alias, or `scope`
alias. `report.root` remains the invocation world coordinate.
