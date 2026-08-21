# Kanshi

Kanshi is the package's composite world observation. It owns the public report
shape, section availability, read-time association joins, and Contract
selection. It is a reader, never authority: it writes, caches, repairs, and
reconciles nothing.

Its text projection is owned by [cli-output.md](cli-output.md). The renderer
derives each section's visible count only from the assembled `contracts`,
`akuma`, and `tasks` sections. Contract and Task count non-terminal `live`
rows; Fleet counts readable Akuma identities. It performs no additional read. An absent or
failed section is
named as such and is never counted as zero; a present empty section is zero.
The text projection adds no persisted counters or another report field.

## Report

`kanshi({ world, repo? })` consumes one already resolved world coordinate and
optional Git Repo and independently reads the
Contract board, complete Task world, and Akuma fleet. Every product remains a
public source value. A section is `present`, `absent`, or `failed`; absence is a
lawful missing product world, while corruption and IO are failures with a
bounded diagnostic. One section's failure does not suppress another section.
The WorldRoot is shared by every worktree in one Git repository; Kanshi never
re-resolves it from cwd or a worktree marker.

Kanshi consumes the Contract workspace owner's one here-appointment fold and
supplies it to the Contract status projection. It does not enumerate Git
worktrees, read appointment files, or select a here workspace itself. Thus a
duplicate here appointment remains the same bounded failed workspace
observation in Kanshi as in ordinary Contract status and observe.

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

Contract phase, final frozen journal, current gate testimony, born Akuma life,
and latest semantic activity retain their owners' source timestamps in the
assembled rows. Contract `lastJournalAt` is the final entry in the frozen
journal observation. Born Akuma `lastActivityAt` is its Heart owner's bounded
latest timeline-row observation and may be `null`. Kanshi does not persist or
precompute an age. Text derives every displayed age against this report's one
`observedAt`; JSON retains only the source timestamps. Fleet text retains every
readable Akuma row, including running, asleep, stranded, killed, hung, untidy,
unborn, stillborn, and lost rows. It uses a ten-row hot-first aperture: the
existing Akuma hot rule selects running, lost, stillborn, and missing or
unavailable Dispatch endpoints before cold rows in source order. The same final
visible ordering selects activity snapshots, which are bounded to its first
three rows.

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
The Akuma owner silently omits an individual physical identity whose compact
row cannot be read; one bad Heart or Leash therefore does not fail the Fleet
section or suppress other readable rows.

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

Exact Contract text is not a world board. It renders the one selected Contract
row and its subordinate holder, Fleet attachment, namespace, workspace, and
gate facts without world-board sections, top-level Task or
Fleet rows, or aggregate counts. The JSON projection keeps the assembled
selected report; text does not repeat those joined relations as world sections.
Kanshi owns that assembled observation. Selected Contract status constructs the
complete Contract board from one Git observation, including reverse active
dependents, then selects the addressed row and its joined relations. It does
not assume reverse dependents exist in a single-journal read. Selectors that
require world lookup may
read the world to resolve the identity before requesting the same observation.

`CurrentPhysicalIssue` is selected-only:

```ts
type CurrentPhysicalIssue =
  | Readonly<{ kind: "hook-failure"; diagnostic: string }>
  | Readonly<{ kind: "target-checkout-retained"; target: string }>
```

After selection, Kanshi may attach `issue` on that Contract row by reading a
durable hook marker or independently judging the pure target-checkout shape. It
must not call effectful reconcile, acquire that lock, mutate refs or worktrees,
or execute hooks. World status and `keiyaku ls kei/` omit the property and do
not run the projection. Observation failure is a section diagnostic, not an
issue arm. `unsealed-bytes`, `worktree-retained`, `reconcile-failed`, and
contract-file failures without a durable source remain receipt-only.

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
report only; it does not reread product authorities or infer associations. Bare
world text has three sections in this exact order: KEIYAKU, FLEET, TASK.
KEIYAKU and TASK headers are `[ <SECTION> ]  <N> live`, where N is that
section's non-terminal live count. Fleet is `[ FLEET ]  <N> akuma`, where N is
every readable Fleet row. There is no signature, invocation coordinate, state
coordinate, aggregate score, or alternate status mode.

```text
[ KEIYAKU ]  1 live

! kei/example
  TITLE   Title
  STATE   pending-delivery · 3m
  GIT     target main · 7 commits behind main · target moved · worktree dirty · staged 1 · unstaged 3 · untracked 2
  DIR     /absolute/managed/path
  GATES   [✓] build   [✗] tests
  LINKED  task/example
          aku/worker/abcd1234 (@lead)

  (all 1 live keiyaku shown)


[ FLEET ]  1 akuma

● aku/worker/abcd1234 (@lead)
  LIFE    running · 4m
  LINKED  -> kei/example

  (all 1 akuma shown)


[ TASK ]  1 live

● task/example
  TITLE   Title
  STATE   in_progress · P0
  LINKED  -> kei/example

  (all 1 live task shown)
```

The text aperture shows at most ten rows from each section. Contract and Task
select hot live rows first, then cold-live rows in their existing source order: a
Contract is hot when it is pending-delivery, has failed or
stale gate testimony, is behind its target, has a dirty or unavailable
worktree, has an unavailable or held TaskHolder, has an attached Akuma, or has
no readable title; a Task is hot when blocked or in progress. Fleet selects its
existing hot rows first: running, lost, stillborn, or a missing or unavailable
Dispatch endpoint, then all cold rows in source order. No row is duplicated.
Terminal Contract and Task rows are omitted and excluded from their live count;
Fleet retains every readable life state, including asleep, stranded, killed,
hung, untidy, unborn, and stillborn rows. Complete coordinates remain present
in output bytes even when the terminal wraps them.

After its visible rows, a complete section writes exactly
`  (all <N> live <unit> shown)` for KEIYAKU and TASK, and
`  (all <N> akuma shown)` for FLEET. A partial KEIYAKU or TASK section writes
exactly `  + <N> more live <unit> not shown`; a partial FLEET writes exactly
`  + <N> more akuma not shown`; each is followed by
`    keiyaku ls <selector>/`; the resulting commands are `keiyaku ls kei/`,
`keiyaku ls aku/`, and `keiyaku ls task/`. The
omitted count is the relevant section count beyond the ten-row aperture and
never includes terminal Contract or Task rows. Fleet snapshots belong only to
the first three final visible rows. There is one blank line after each header and
before its footer, then two blank lines before the next header. `keiyaku ls`
is the complete text inspection path; typed Kanshi and JSON remain complete.

Contract rows retain complete `kei/...` identity, read-time title, phase, target,
numeric behind when known, `commits behind <target> unknown` beside a known
target name when lag is unknown, explicit no-target when none, independent
target movement, gate testimony, and exact attached Task/Akuma coordinates.
Visible hot Contract rows retain every such fact; cold rows retain their
complete identity, title, phase, and target facts. World-board gates are
age-less slots: `[✓]` satisfied, `[✗]` unsatisfied, `[ ]` never reported, and
`[~]` stale. Selected Contract text retains detailed gate ages and summaries.
World attachments render as a `LINKED` list with the first identity on the
label line and later identities on aligned following lines. Selected Contract
text renders `namespaceTasks` after holder and Fleet attachment rows, as one
summary then every matching row:

```text
  │ namespace tasks <N>
  │ <mark> <complete TaskId> · P<n> <disposition> — <title>
```

Zero matches render `namespace tasks 0`. Absent and failed observations render
`namespace tasks absent` or `namespace tasks failed <diagnostic>`. Bare world
Kanshi omits those nested rows because TASK already renders every Task.
Task and Akuma rows retain complete identities, state or key facts, and exact `-> kei/...`
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

Hot world-board Contract rows use this aligned field order:

```text
  TITLE   <title>
  STATE   <phase> · <age>
  GIT     <target facts> · <worktree state>
  DIR     /absolute/managed/path
  GATES   [✓] build   [✗] tests
  LINKED  task/<complete-id>
          aku/<complete-id> (@alias)
```

`GIT` carries the worktree state. `DIR` appears for a hot managed Contract
when its observation supplies a managed worktree location, including an
unavailable location; unappointed and failed observations never invent one,
and here rows never name a managed path.
Cold live rows keep the complete identity, title, phase, and target facts in
one compact row, without repeating clean worktree state or a path. IDs and
paths are never shortened; they may overflow the terminal. `LINKED` is an
entity attachment list, not a worktree relation.
