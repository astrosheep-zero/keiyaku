# Kanshi

Kanshi is the package's composite world observation. It owns the public report
shape, section availability, read-time association joins, and Contract
selection. It is a reader, never authority: it writes, caches, repairs, and
reconciles nothing.

Its text identity is the Split Horizon signature owned by
[cli-output.md](cli-output.md). The renderer derives its three aggregate facts
only from the assembled `contracts`, `akuma`, and `tasks` sections and derives
the world label only from `root`, `branch`, and the present Contract-board state
coordinate. It performs no additional read. An absent or failed section is
named as such and is never counted as zero; a present empty section is zero.
The signature does not add persisted counters or another report field.

## Report

`kanshi({ world, repo? })` consumes one already resolved world coordinate and
optional Git Repo and independently reads the
Contract board, complete Task world, and Akuma fleet. Every product remains a
public source value. A section is `present`, `absent`, or `failed`; absence is a
lawful missing product world, while corruption and IO are failures with a
bounded diagnostic. One section's failure does not suppress another section.
The WorldRoot is shared by every worktree in one Git repository; Kanshi never
re-resolves it from cwd or a worktree marker.

The report is:

```ts
type KanshiReport = {
  root: WorldRoot | null;
  observedAt: string;
  branch: string | null;
  contracts: Section<ContractKanshiBoard>;
  tasks: Section<TaskKanshiWorld>;
  akuma: Section<AkumaKanshiWorld>;
};
```

`observedAt` is one canonical ISO timestamp sampled before any section read.
One report observes exactly one World. `branch` is the attached branch of the
Repo whose primary worktree is `root`, or `null` without a Repo,
for detached HEAD, or when that observation fails. The immutable
`refs/heads/keiyaku-state` commit remains represented once as
`ContractBoard.state`, not copied into another report field. It is not the
invocation worktree HEAD.

Contract phase, current gate testimony, and born Akuma life retain their
owners' source timestamps in the assembled rows. Kanshi does not persist or
precompute an age. Text derives every displayed age against this report's one
`observedAt`; JSON retains only the source timestamps.

When a Repo is present, Kanshi creates one call-scoped Git read observation and
passes it to the complete Contract, TaskHolder, and
Dispatch readers. Kanshi only composes their returned values into sections and
joins; it does not inspect the frozen Git snapshot, select product paths or
object IDs, decode product bytes, or create Git processes. The owners may read
concurrently, but all requested objects use the observation's one shared batch
and repeated Contract target refs resolve once per distinct refname.

Failure follows the information the user could not observe. Failure to freeze
or validate the shared Git state makes every Git-backed section failed. A
missing owner object, malformed owner bytes, or owner codec failure fails only
the section that depends on that owner: Contract failure fails the Contract
section, TaskHolder failure fails the Task section and makes Contract holder
decorations unavailable, and Dispatch failure fails the Akuma section. If the
shared batch process itself dies, every remaining section that requires it
fails from that one transport failure; Kanshi does not retry through another
reader. Task files, Alias files, branch metadata, and the compact Akuma fleet
retain their existing independent failure boundaries.

The observation exists only for this report call. Kanshi keeps no cross-report
cache and has no prepare/finish exchange with the product owners. It never
combines a WorldRoot with a Repo from another repository.

## Contract endpoints

Task endpoints come only from current `held` TaskHolder facts read through the
package-root composition boundary; Task Markdown has no association field.
Kanshi outer-joins each endpoint id
against the already-read Contract board and exposes `{ id, observed }` in its
own row type. `observed` is the Contract's
public disposition when found, `missing` when a present board lacks the id, and
`unavailable` when the Contract section is absent or failed. Corruption and IO
are never collapsed into `missing`.

The same holder read is reverse-projected onto Kanshi-owned Contract rows as:

```ts
type ContractHolderObservation =
  | { kind: "held"; taskId: TaskId }
  | { kind: "none" }
  | { kind: "unavailable" };
```

`none` means the holder authority was read successfully and has no current
`held` fact for that Contract. `unavailable` means the holder read failed; it
is not absence. This decoration does not add Task knowledge to `ContractRow`
or change `ContractBoard`. Each public `ContractKanshiRow` also carries
`namespaceTasks: Section<readonly TaskRow[]>`. Settlement owns the canonical
one-segment namespace; Kanshi consumes that projection and does not re-encode
it. A Task matches only when its complete TaskId namespace equals that
namespace. When a World is present, one Task board read supplies both the
top-level Task section and every Contract row's namespace selection. A
successful read with no matches is `present` with an empty array. Without a
World it is `absent`. Task authority corruption or infrastructure failure is
`failed` and retains the existing bounded diagnostic. TaskHolder failure keeps
its current effect on the top-level Task section and holder decoration, but
does not suppress a successfully read namespace selection. Task board failure
does not suppress the base Contract or Akuma sections. A namespace match
creates no holder, endpoint, lifecycle consequence, or association.

The join is one hop. Kanshi does not validate associations, infer them from cwd
or origin, follow Task associations to derive an Akuma association, or persist
the joined view. A malformed or unreadable holder fails only the Task section;
the base Contract section remains present with `unavailable` holder
observations, and the Akuma section remains independently observable. Task and
Akuma products do not import Contract lifecycle or Git behavior.

Kanshi obtains the complete Task board projection from one Task-owner
observation operation. A row present in the Task owner's
blocked projection copies its ordered unresolved `TaskRef[]` as `blockers`;
this includes open `blocked` and `in_progress` rows with unresolved needs. A
row outside that projection has no `blockers` field. Missing need targets
remain structured refs with `title: null` and `state: "missing"`. Kanshi does
not import Task persistence, reread the Task board, or derive blockers from
text.

Kanshi reads Dispatch and the complete Alias register through their concrete
owners. Each Akuma row carries only its current world-local Alias list and, when
a Dispatch exists, one `{ id, observed }` Contract endpoint using the same
disposition join as Task endpoints. The call-scoped observation retains the
complete Alias register for named status selection without adding it to the
public report. A malformed Alias or Dispatch fails only the Akuma section.
Kanshi does not infer association through Task, cwd, origin, or Contract
lifecycle, and never changes or repairs either authority.

## Selection

Contract selection projects an assembled report without new reads. It keeps
the addressed Contract row, Task rows whose joined endpoint id
exactly matches the selector, and Akuma rows whose Dispatch endpoint names that
Contract. The selected Contract row already carries `namespaceTasks`; do not
copy namespace matches into the TASK section. Section presence, absence, and
failure remain unchanged. The text renderer consumes only this public report
and renders each present endpoint as `keiyaku <id> (<observed>)`.

For named status, the same call-scoped observation supplies the complete Alias
register and report to Address. Address resolves active managed Contract short
selectors from the report and Alias selectors from that retained register,
refuses an explicit cross-kind ambiguity, and never rereads either authority.
An unavailable required Contract section or Alias observation remains typed
unavailability rather than an empty match set.

Kanshi joins each present Contract row with the already-read Task holder and
Akuma Dispatch facts as typed attachments. It does not invent a second
association or persist those joins. A held Task is `task <id>`; each Dispatch
is `akuma <id>` with that Akuma's current Alias list. Missing or failed
sections stay typed and remain distinct from an observed empty section.

## Read-Time Region

`KanshiInput.region` is optional. Omitted input leaves `KanshiReport` without a
`region` property; present input adds an isolated `Section<RegionRead>`:

```ts
type KanshiRegionSelection =
  | { kind: "declarations" }
  | { kind: "contract"; contract: ContractId }
  | { kind: "overlap"; contract?: ContractId }
  | { kind: "path"; path: string }

type RegionDeclaration = {
  contract: ContractId;
  patterns: readonly string[];
}
type RegionIntersection = {
  left: ContractId;
  right: ContractId;
  patterns: readonly { left: string; right: string }[];
}
type RegionPathMatch = { contract: ContractId; pattern: string }
type RegionRead =
  | { kind: "declarations"; declarations: readonly RegionDeclaration[] }
  | { kind: "contract"; declaration: RegionDeclaration }
  | { kind: "overlap"; subject?: ContractId; intersections: readonly RegionIntersection[] }
  | { kind: "path"; path: string; matches: readonly RegionPathMatch[] }
```

Declarations preserve each active Contract's pattern order. Bare declarations
contain no relation data; overlap is the only relation view and reports both
decisive patterns. Path reads match active declarations against one canonical
repository-relative path. Empty arrays are typed empty results. A malformed or
unreadable document fails only this section, while a missing world is absent.
The public input validates this exact discriminated union, rejects unknown
fields, and validates ContractId/path values before any repository observation.
This planning read uses the document Region owner and never reports actual
touched paths, Git conflicts, ownership, gates, or serialization advice.

## Text board

Human and Flagship share one text projection. The renderer consumes the typed
report only; it does not reread product authorities or infer associations. The
signature owned by [cli-output.md](cli-output.md) always says keiyaku, akuma,
and task as count units. FLEET is only the section name.

The normative layout is three apertures after the signature:

```text
kanshi ─── 1 keiyaku · 1 akuma · 1 task ─── /repo main <state>

──[ KEIYAKU ]────────────────────────────────────────────────────
! kei/example
  │ Title · waiting · target main · behind 7 · drift
  │ worktree dirty · staged 1 · unstaged 3 · untracked 2
  │ ↳ /absolute/managed/path
  │ gates: ✓ build · ! tests
  │ task task/example
  │ akuma aku/worker/abcd1234 (@lead)
──[ 1 keiyaku · 1 attention ]───────────────────────────────────

──[ TASK ]───────────────────────────────────────────────────────
● task/example
  │ Title · in_progress · P0
  │ -> kei/example
──[ 1 task · 1 attention ]──────────────────────────────────────

──[ FLEET ]──────────────────────────────────────────────────────
● aku/worker/abcd1234 (@lead)
  │ running
  │ -> kei/example
──[ 1 akuma · 1 attention ]─────────────────────────────────────
```

Every observed entity repeats its row grammar between the section boundaries.
No entity may be replaced by an omission line, aggregate, dormant bucket,
placeholder, or shortened coordinate. Complete coordinates remain present in
output bytes even when the terminal wraps them. Hot or anomalous entities use
additional plumb-line rows for decision facts; cold entities retain at least
one plumb-line row with title, state, and key fact. Section summaries report
totals and attention counts only after every entity has appeared.

A Contract is hot when it is pending-delivery, has failed or stale gate
testimony, is behind its target, has a dirty or unavailable worktree, has an
unavailable holder, has an attached Task or Akuma, or its current opaque
document cannot yield a title. Waiting, drift, unknown target, and no-target
stay on the compact row and are not themselves attention. A Task is hot when
blocked or in progress. An Akuma is hot when running, lost, stillborn, or its
Dispatch endpoint is missing or unavailable. Attention counts those hot rows.

Contract rows retain complete `kei/...` identity, read-time title, phase, target,
numeric behind when known, `behind unknown` beside a known target name when
lag is unknown, explicit no-target when none, independent drift, gate
testimony, and exact attached Task/Akuma coordinates. Selected Contract text
renders `namespaceTasks` only under KEIYAKU, after holder and Fleet attachment
rows, as one summary then every matching row:

```text
  │ namespace tasks <N>
  │ <mark> <complete TaskId> · P<n> <disposition> — <title>
```

Zero matches render `namespace tasks 0`. Absent and failed observations render
`namespace tasks absent` or `namespace tasks failed <diagnostic>`. Bare world
Kanshi omits those nested rows because TASK already renders every Task.
Namespace tasks do not affect Contract heat or attention. Task and Akuma rows
retain complete identities, state or key facts, and exact `-> kei/...`
associations where present. A missing endpoint is `-> kei/... (missing)`; an
unavailable board is `-> kei/... (unavailable)`. An unbound Task or Akuma
renders `unbound` instead of a relation. Title is `null` when the current opaque
Contract document cannot be decoded; this does not remove the Contract row or
fail another section, and text renders `title unavailable`.

This chapter is the sole complete board glyph owner. Marks accelerate
scanning and never replace a copied discriminant. Reachable Task
dispositions use `●` in_progress, `○` ready or open, `⧗` on_hold, `‖`
blocked, `✓` done, and `×` drop. Contract and Akuma marks reuse that
vocabulary: `●` live, `○` waiting or idle, `✓` claimed or satisfied, `×`
abandoned, killed, or dropped, `!` unsatisfied or stillborn, and `?`
unknown, stale, or lost. There is no invented `=` mark.

Worktree facts use this exact Contract plumb-line order after the title/state
line:

```text
  │ worktree dirty · staged 1 · unstaged 3 · untracked 2
  │ ↳ /absolute/managed/path
  │ gates: ✓ build · ! tests
```

The worktree state line is always visible. The complete path line expands for
an active/hot Contract or any dirty or unavailable observation; a cold clean
Contract may omit the path while retaining `worktree clean`. An unappointed
managed Contract renders `worktree unappointed` and never names a worktree
path. A here Contract renders `workspace here · clean|dirty|unavailable` and
never fabricates a managed path. A path is always one complete coordinate; renderer truncation
or an ellipsis is forbidden. The path line is subordinate fact syntax, not a
cross-product relation, and does not use the entity attachment relation.
