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

Kanshi consumes the Contract workspace owner's one managed-worktree appointment
fold and supplies it to the Contract status projection. It does not enumerate
Git worktrees, read appointment files, or select a workspace itself. Managed
workspace failures remain the same bounded observations in Kanshi as in
ordinary Contract status and observe.

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
unborn, stillborn, and lost rows. Every bare section uses its owner's native
update coordinate for a stable descending recent-first ten-row aperture:
Contract uses `lastJournalAt`, Task uses `updatedAt`, and Fleet uses the later
non-null value of `lifeAt` and `lastActivityAt`. Equal coordinates preserve
source order; a Fleet row with neither coordinate is older than one with either
coordinate. The same final Fleet ordering selects activity snapshots, which are
bounded to its first three rows.

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
type ContractHolderObservation = { kind: "held"; taskId: TaskId } | { kind: "none" } | { kind: "unavailable" };
```

`none` means the holder authority was read successfully and has no current
`held` fact for that Contract. `unavailable` means the holder read failed; it
is not absence. This decoration does not add Task knowledge to `ContractRow`
or change `ContractBoard`. Each public `ContractKanshiRow` also carries
`namespaceTasks: Section<readonly TaskRow[]>`. Settlement owns the canonical
one-segment TaskId namespace; Kanshi consumes that projection and does not
re-encode it. A Task matches only when its complete TaskId namespace equals
that coordinate. Contract matching never consults directory context. When a World is present, one Task board read supplies both the
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
type CurrentPhysicalIssue = Readonly<{ kind: "target-checkout-retained"; target: string }>;
```

After selection, Kanshi may attach `issue` on that Contract row by independently
judging the pure target-checkout shape. It
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
  | Readonly<{ kind: "declarations" }>
  | Readonly<{ kind: "contract"; contract: ContractId }>
  | Readonly<{ kind: "path"; patterns: readonly [string, ...string[]] }>;

type RegionDeclaration = Readonly<{
  contract: ContractId;
  patterns: readonly string[];
}>;

type RegionOverlap = Readonly<{
  contract: ContractId;
  patterns: readonly Readonly<{ mine: string; theirs: string }>[];
}>;

type RegionRead =
  | Readonly<{
      kind: "declarations";
      declarations: readonly RegionDeclaration[];
    }>
  | Readonly<{
      kind: "contract";
      declaration: RegionDeclaration;
      overlaps: readonly RegionOverlap[];
    }>
  | Readonly<{
      kind: "path";
      patterns: readonly string[];
      overlaps: readonly RegionOverlap[];
    }>;
```

Declarations preserve each active Contract's pattern order. Bare declarations
contain no relation data. A Contract read returns that Contract's declaration
and every intersection with other active declarations, excluding the subject
from its counterpart set. A path read accepts one or more query patterns in
the Contract Region line grammar from [document.md](document.md); a literal
repository path is that grammar's degenerate case. Pattern order and
duplicates are preserved. For every `RegionOverlap`, `contract` is the
counterpart active Contract, `mine` is the query-side pattern, and `theirs` is
that Contract's declared pattern. Path reads may include every active
Contract. This subpath exports the Region types needed to name the union,
including the same `RegionOverlap` shape exported at the package root; it does
not retain `RegionIntersection`, `RegionPathMatch`, or an `overlap` selection
arm. Empty arrays are typed empty results. A malformed or unreadable document
fails only this section, while a missing world is absent. The public input
validates this exact discriminated union, rejects unknown fields, and
validates ContractId and query-pattern values before any repository
observation. This planning read uses the document Region owner and one
pattern-intersection calculator; it never reports actual touched paths, Git
conflicts, ownership, gates, or serialization advice.

## Text board

Human and Flagship share one text projection. The renderer consumes the typed
report only; it does not reread product authorities or infer associations. Bare
world text has a `契 KEIYAKU // WORLD` masthead followed by three sections in
this exact order: `CONTRACTS`, `AKUMA`, `TASKS`. Section headers carry scoped
objective counts: `CONTRACTS // <N> live · <M> candidates`, `AKUMA // <V>
recent · <T> known`, and `TASKS // <N> live`. Candidate existence starts the
candidate/target fact line as `candidate` or `no candidate`; the row has no
candidate glyph. Gate glyphs stay immediately before gate names, and stale gates
append `(stale)`. Contract rows carry only a compact linked-Akuma summary;
complete Akuma identities remain in AKUMA and selected Contract detail. There
is no signature, invocation coordinate, aggregate score, or alternate status
mode.

When a section is absent, its named header is rendered as `CONTRACTS // absent`,
`AKUMA // absent`, or `TASKS // absent`; absence never becomes a numeric zero.

```text
契 KEIYAKU // WORLD

CONTRACTS // 1 live · 0 candidates

! kei/example · tendered · 3m · Title
  │ no candidate · target main · 7 commits behind main · [✗] tests
  │ ● task/example · in_progress · ● aku/worker/abcd1234 (@lead) · running

AKUMA // 1 recent · 1 known
● aku/worker/abcd1234 (@lead) · running · 4m · -> kei/example

TASKS // 1 live
● task/example · in_progress · P0 · Title · -> kei/example
```

The text aperture shows at most ten rows from each section, selected by the
stable recent-first owner-coordinate rule. No row is duplicated. Terminal
Contract and Task rows are omitted and excluded from their live count; Fleet
retains every readable life state, including asleep, stranded, killed, hung,
untidy, unborn, and stillborn rows. Complete coordinates remain present in
output bytes even when the terminal wraps them. Bare Contract rows render age
from `lastJournalAt`; selected Contract status continues to render phase age
from `phaseAt`. Fleet renders both life and activity ages, and Task retains its
existing update coordinate and display.

After its visible rows, a complete section writes exactly
`  (all <N> live <unit> shown)` for KEIYAKU and TASK, and
`  (all <N> akuma shown)` for AKUMA. A partial CONTRACTS or TASKS section writes
exactly `  + <N> more live <unit> not shown`; a partial AKUMA writes exactly
`  + <N> more akuma not shown`; each is followed by
`    keiyaku ls <selector>/`; the resulting commands are `keiyaku ls kei/`,
`keiyaku ls aku/`, and `keiyaku ls task/`. FLEET's instance continuation is
`keiyaku ls "aku/*/*"` when unscoped and `keiyaku ls aku/<archetype>/` when
scoped; it never points at the archetype directory. The
omitted count is the relevant section count beyond the ten-row aperture and
never includes terminal Contract or Task rows. TASK continuation is always
`keiyaku task ls --world`.
Fleet keeps its ten-row aperture
and snapshot read boundary, but text projects only one physical
`activity "<bounded text>"` line for a visible latest semantic activity or idle
outcome. The value is safe-text-normalized and clipped with the terminal
display-width primitive; it is not the durable ActivitySnapshot. Rows without
a latest activity or outcome omit the activity field. There is one blank line
after each header and before its footer, then one blank line before the next
header. Future-dated text ages render `now`; JSON timestamps remain exact.
`keiyaku ls`
is the complete text inspection path; typed Kanshi and JSON remain complete.

`keiyaku ls kei/` is a pure active-Contract catalog. Its header includes active
count, Contract state, observedAt, and candidate count.
Each natural-flow block retains complete identity, age, title, after/dependent
edges, gate testimony, and target blocker facts. It does not join Task, Alias,
Dispatch, Akuma, holder, or namespace data and does not expose candidate
coordinates, workspace detail, or merge internals. Selected Contract text
retains detailed gate ages and summaries. At 72 columns and below, selected
Contract entities separate state/age, complete identity, and title/facts onto
deliberate lines; they do not rely on natural wrapping of the wide header.
World status and selected Contract attachments render as a natural-flow list. Every entry
contains its contextual glyph, complete identity, and basic current status:

```text
  attachments
    ⧗ task/fix-auth · on_hold
    ● aku/worker-2 (@lead) · running
```

The list preserves every attached entry, including the current TaskHolder.
When a present endpoint cannot be found it ends in `missing`; an absent or
failed endpoint section ends in `unavailable`. An unavailable TaskHolder with
no readable identity renders `! task · unavailable`. These statuses remain
visible rather than looking like live attachments. Task titles, priorities,
blockers, bodies, and other Task detail do not appear below a Contract-linked
line. Akuma snapshots, activity, archetype, and description do not appear
there either. Selected Contract text then renders `namespace tasks` after the
attachment block, as every matching row:

```text
  namespace tasks
    <mark> <complete TaskId> · P<n> <disposition> — <title>
```

Zero matches render `none`. Absent and failed observations render `absent` or
`failed <diagnostic>` beneath the `namespace tasks` block. Bare world
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

World-board Contract rows are natural-flow decision summaries with complete
identity, age, title, after/dependent edges, gate testimony, and target facts.
They start the candidate/target fact line with `candidate` or `no candidate`;
stale gate facts append `(stale)`. They do not expose workspace or merge internals. Attached Task and Akuma rows
retain complete identity, aliases, and basic current status only. Fleet remains
the sole Akuma activity surface. Selected status uses lowercase semantic blocks
for `after`, `dependents`, `gates`, `candidate/integration`, `target`,
`workspace/merge`, `attachments`, and `namespace tasks`; it exposes the complete
selected evidence without fixed field labels.
