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

The CLI uses only public `Repo`, `Keiyaku`, and `Delivery` values. No package
operation resolves a path or reads the working directory again.

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
exclusion, and final-stdin selection. It performs no product observation or
judgment. Help completes at this dependency-light edge. After a non-help parse,
the invocation adapter loads only the selected command family's execution and
rendering graph, then calls the corresponding public operation without a second
command-specific behavior layer.

## Command Surface

`keiyaku nuke [--json]` refuses with the required confirmed form for the
invocation World. `keiyaku nuke --confirm <WorldRoot> [--json]` executes the
Keiyaku-owned data reset only
when the literal confirmation equals the resolved WorldRoot byte-for-byte.
Nuke is not repository cleanup or generic World teardown. It never accepts a
Contract positional argument, stdin, a token, snapshot hash, prompt, or
per-owner confirmation. `--repo` has no consumer for this command.

The command vocabulary is:

| Command | Public adaptation |
| --- | --- |
| `bind` | Calls `Keiyaku.bind` with the pinned Repo, Markdown, and structured options. |
| `amend` | Calls `keiyaku.amend` with the operation Markdown and structured options. |
| `deliver` | Calls `keiyaku.deliver`. |
| `review` | Calls `keiyaku.review`; in a declared request channel it forwards one hop through the direct parent. |
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
| `wait`, `tell`, `history`, `kill` | Call the corresponding package-root capability; Contract history uses its handle and `tell --interrupt` selects composed interrupt. |

`bind` accepts no contract positional. Existing Contract commands accept a full
`kei/<contract-segment>` or active `@<contract-segment>` reference. The short
reference resolves over `ContractBoard` rows and is never stored.

An omitted contract selector is valid only when the invocation coordinate matches
the reported `worktreePath` of exactly one active worktree contract. A here
workspace never supplies omitted-selector inference. The adapter issues a
typed usage refusal when this test has no unique match.

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

## Inputs And Flags

A final bare `-` reads stdin. For `bind`, it reads one contract document; for
`amend`, one amendment-operation document when `-` is present; for `arc`, one
arc document; and for `review`, the required summary. Review takes exactly one summary source:
`--summary <text>` or final `-`. Neither or both is a usage refusal. No other
Contract command reads stdin. Akuma and Task stdin entry points are specified
by their command grammars below. The grammar of all document inputs is owned
by [document.md](document.md).

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
`amend` maps optional Markdown, `--actor`, repeated `--after`,
and `--gates` to `keiyaku.amend`. Its omitted `after` leaves the current value
unchanged, while `--clear-after` maps to `after: []`; it is mutually exclusive
with `--after`. Final `-` selects one nonblank H2 operation document. Its
absence requires at least one of `--after`, `--clear-after`, or `--gates` and
does not acquire stdin; otherwise parsing is usage before observation. `bind`
and `arc` still require their final `-` document input. Amend leaf help
enumerates the five operation headings verbatim from
[document.md](document.md) and points there for body semantics; the complete
amendment-operation grammar remains owned by document.md.

Every Contract mutation and `reconcile` passes one CLI-observed `WorktreeHooks`
value to the public operation; the CLI never runs hooks or reads markers.
`--retry-hooks` retries only a frozen failed phase. Verification instead reads
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
materialization precondition. Their up-to-date policy comes only from Settings. `review` requires one
verdict and one summary source, has no dirty authorization, and discloses
ordinary dirty bytes when accepted. `--diff` maps to audit `showDiff`; the value
lives only at `report.candidate.diff`, including `""`. `--show-diff-body` is
usage. Other listed scalar operands must be nonblank. `--json` affects output
only.

When a declared request channel is present, `deliver` and `review` resolve the
selected Repo and Contract before forwarding but do not read child Settings or
construct child hooks. Their direct parent reconstructs the selected Repo and
applies only its scoped Settings to the forced-local executor.

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

`call` and `tell` accept exactly one nonblank positional or final-stdin prompt
and pass its bytes unchanged. The CLI maps `KEIYAKU_HOME` once to the explicit
home used for Settings and Archetype placement; the library never reads that
environment variable. `call <akuma-name>` resolves
`<home>/akuma/<name>.md` and its Settings-backed provider, including the
`claude` and `codex-app-server` fallback executions. Missing-name text names
the input and points to `keiyaku ls aku/`; only the typed error retains the
searched path.

`--contract` accepts one complete `kei/...` and requests Dispatch after birth;
`--alias` accepts `@name` and moves that world-local Alias only after Dispatch
succeeds. Repeated `--allowed` values replace the Archetype list for that
birth; `--allowed none` selects the empty list and cannot be combined with
another value. The vocabulary is owned by
[akuma-allowed.md](akuma-allowed.md). Explicit invocation cwd wins for a
contracted call, otherwise its
appointed managed worktree is used. A direct Contract-free call uses ambient
process cwd; a nested omitted call inherits its hosting caller Soul cwd.
Call waits five minutes by default. `--wait` replaces that duration, while
`-d`/`--detach` returns after birth and composition and excludes `--wait`.
Answered terminal observations write exact answer bytes. Successful detach
prints the canonical-world wait command using the successful Alias or complete
AkuId; failure adds no command and fabricates no life.

`tell`, `fork`, and exact `status` accept one AkuId or Alias. `history` also
accepts one complete ContractId. `wait` and `kill` additionally accept Akuma
globs and complete Contract worker selectors; their set expands once,
deduplicates, and byte-sorts. A Contract selector reads Dispatch from the
selected Repo and operates only in the invocation World. A foreign member
refuses the whole set as `akuma-not-in-world`; an unreadable Heart remains in
the frozen selection rather than becoming that refusal. Plural wait discards
failed status reads in intermediate rounds and retries them. Its completing or
timed-out round partitions every frozen member exactly once between
`observations` and `unobserved: [{ id, diagnostic }]`; one-member wait and the
other verbs retain their ordinary diagnostics, while a missing direct AkuId
remains not-born. Multi-wait requires exactly one of `--any` or `--all`; kill covers the
frozen set. Bare `status`
uses Kanshi. Named `status @name` resolves active Contract short names and the
retained Alias register from one Kanshi observation, refuses cross-kind
ambiguity, and performs no preliminary board or Alias reread.
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
`status @name` refuses ambiguity between an active Contract short selector and
an Akuma Alias.
CLI `wait` uses the public default predicate (`life !== "running"`). Its
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
`fork` requires one nonblank `--at` history id and has no stdin body.
Fork passes the selected Contract Repo, otherwise the invocation Repo when
available. The facade alone reads and propagates parent Dispatch; CLI never
reads Dispatch or Alias files.

`call --readonly` adds the one-way read-only restriction to that newly born
Akuma. Its omission leaves the call RW unless the selected Archetype already
declares `readonly: true`; the CLI has no `--write` counterpart and no live
access toggle.

## Akuma Text Surface

Akuma text is a pure projection over public values; JSON exposes the same value
with complete timestamps. Shared row layout, budgets, clipping, time gutter,
glyphs, omission placement, tool presentation, and snapshot framing are owned
by [cli-output.md](cli-output.md).

Readonly `none` renders its diagnostic; native or absent restraint renders
nothing. Snapshots name the complete AkuId, optional frozen Alias, and Dispatch
relation. Dispatch read failures render their diagnostic. Status, non-answer waits, multi-waits, unfinished call, and
kill include public life; tell and history do not. Answered default call,
answered single wait, and `history --last` write exact answer bytes. Detached
call prints the copyable canonical-world wait command. Text never exposes
provider receipt/fence stages or Heart storage vocabulary.

Created Task context and provider-reported changes follow the timeline and
precede life:

```text
tasks <N>
  <mark> <complete TaskId> · <title> · <disposition> · P<n>
changes <total>
  +N -N    <complete path>
  ⋮ <N> earlier changes
```

`<total>` is shown plus omitted; emit the omitted line only when nonzero.
Visible operations group by exact path in first-visible order. Complete
grouped diffstats sum to `+N -N`; any missing diffstat in the group renders
`+? -?`. Empty summaries print `changes 0`. Zero Task matches render
`tasks 0`; failure renders `! tasks failed <diagnostic>`. Complete TaskIds,
titles, and paths are never truncated. Neither block consumes the timeline
budget. Exact-answer call/wait and `history --last` remain raw and have no
snapshot block; JSON retains the complete observation.

Tell appears once as pending (`⧗ tell`) or terminally evidenced (`told`), and
pending tells survive the snapshot budget. Post-primary observation failures
render `! <id> unobserved: <diagnostic>` and JSON preserves the typed stage.
JSON for tell/interrupt/kill preserves the corresponding primary result beside
`observation`. `tell --interrupt` selects the Library's fenced
composition and reports hung or untidy outcomes without external signaling.
A stranded unresumable Akuma prints `resume unsupported`; the CLI never creates
a fresh fallback or deletes its coordinate.

History retains public row order without current-life observation. Native
provider history ids never become CLI selectors; `history --last` bypasses the
page and writes exact answer bytes. Wherever an `AkumaObservation` is rendered,
created Task context and reported changes follow the timeline without consuming
its budget, and life remains last when the command shows it; exact-answer
call/wait, Akuma history, and compact FLEET remain raw as defined in
[cli-output.md](cli-output.md).

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
