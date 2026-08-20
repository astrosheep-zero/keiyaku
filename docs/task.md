# Task Product

Task is a directory-context planning product shipped from the same npm package
under `./task`. It answers what work exists, what can begin, and what blocks it.
It is not part of contract core, protocol, Git, or contract lifecycle.
Contract modules never import Task modules. Task does not import `Repo`, read
Contract authority, or interpret a retained contract association.

## World, Context, And Identity

A Task world is one product World. The public `Tasks.of` board handle is
constructed from that WorldRoot only; it never stores invocation paths, reads
Git state, or inspects process cwd. In a Git repository every worktree uses the
primary worktree WorldRoot while the caller edge supplies the invocation
directory and current worktree root to Task's context resolver. A worktree
marker cannot split Task authority. Outside Git, context lookup and writes
remain at WorldRoot, and a nearer nested marker deliberately starts another
Task world.

A `TaskId` is `task/<local-id>` at the root or
`task/<namespace...>/<local-id>` in a nested namespace. Every segment uses the
registered human-segment grammar. Creation derives the immutable local ID from
the title with the shared identity normalizer and a 48-byte fitted stem. A
closed task still occupies its coordinate. Collision allocation uses the first
free numeric suffix beginning at `-2`, fitted inside the same byte limit.
Callers never provide an arbitrary ID, and title updates never move authority.

The world-local current namespace is context, not Task or contract
authority. Its sole byte representation is:

```text
.keiyaku/namespace/.gitignore  # exactly "*\n"
.keiyaku/namespace/current     # canonical slash-separated human segments
```

A caller-context read inspects from `directory` upward through the current
worktree `boundary`, nearest first. An absent marker means the root namespace;
a nearest malformed marker refuses context-consuming CLI/composition operations
as `invalid-namespace-context` at that marker path and never falls through.
`add`, `addDocument`, and `compose` receive their already-resolved namespace as
an explicit input; `list`, `ready`, and `blocked` receive it when selecting a
namespace scope. Explicit full-TaskId operations (`show`, `tree`, `update`,
and lifecycle) carry no context. `doctor` is always world-scoped. The caller
edge writes `task namespace X` at the invocation directory for Git and at
WorldRoot for non-Git.

The byte law and read/write primitive belong to Task. Installation in a
managed Contract worktree is driven only by [settlement](settlement.md), which
derives the default from Contract state and calls the Task-owned primitive.
Namespace reads, installation, and repair are awaited filesystem operations;
their Promises fulfill only after the complete marker observation or durable
replacement.

## Authority And Document

The sole Task authority is canonical Markdown at:

```text
.keiyaku/tasks/<namespace...>/<local-id>.md
```

Recursive board enumeration descends real directories under `.keiyaku/tasks/**`
and selects only regular files whose names end in `.md`. Every other filesystem
entry is ignored; it is not Task authority. Selected `.md` authority retains
its path witness, regular-file observation, document parsing, and corruption
behavior.

Task authority is ordinary repository-visible content. A repository-level
ignore policy must leave `.keiyaku/tasks/**` visible to Git so Task state can
be reviewed and shared; runtime siblings such as locks, Akuma runs, responses,
and dispatch state remain ignored. Task itself still never stages, commits, or
changes Git refs.

The path owns identity. Closed front matter repeats the full `id` as an
integrity witness and contains `title`, `state`, `priority`, `needs`, `parent`,
`supersedes`, `relates`, `note`, optional `createdBy` when present, `createdAt`,
and `updatedAt` in that stored order. Optional prose is the body. The ID must
equal the path-derived coordinate. Unknown keys and malformed documents are
authority corruption. Manual editing is authoritative; a manual move that
breaks the witness is corruption.

Public Task reads and writes are asynchronous and observe complete files. One
compare-and-replace commit may synchronously fsync a unique temporary file,
rename it, and fsync the parent where supported; Windows uses file fsync plus
atomic rename. All surrounding observation and cleanup remains asynchronous,
with no second sync API or parallel writer.

`priority` is `0 | 1 | 2 | 3` and defaults to `2`. Relation arrays are ordered,
duplicate-free full TaskIds. `note` is a string and defaults to empty.
`createdAt` and `updatedAt` are canonical UTC ISO
timestamps. Product creation sets both to one captured time. A product mutation
that changes Task authority preserves `createdAt` and advances `updatedAt` once:
it uses its captured candidate when later than the predecessor, otherwise the
predecessor plus one millisecond. Ordinary mutations capture their own
candidate; one compose invocation captures one candidate and reuses it for all
of its changed documents. A no-op update preserves both. Manual writers own the
truth of both timestamps when they edit authority. `createdBy` is an optional opaque nonblank actor
string: no registry, AkuId grammar, normalization, or Contract association.
Product creation writes it only from caller `actor`; later product mutations
and settlement preserve the existing field and never invent one. A creation
document supplied to `addDocument` may not declare `createdBy`. Documents
without it remain valid. Manual writers may edit it because Markdown remains
authority. `parent` is nullable. V1 has no
cached readiness, counters, task log, NDJSON trace, private history ref,
`history <TaskId>`, or latest-actor field. Because manual, uncommitted
Markdown edits remain authoritative, Task does not promise complete
change-since-observation, history, or event-log reads; a partial journal
would be dishonest.

Task may be reached through one direct-parent Akuma Body Request, but that is
an integration edge, not Task authority. The Task owner decodes the same public
mutation inputs and runs the same forced-local operation for the caller-selected
World. The authenticated requester supplies creation actor on that edge; Task
does not inspect Akuma, Heart, Contract, or transport state, and retains no
request lifecycle fact.

## Lifecycle And Graph

Persisted states are `open`, `in_progress`, `on_hold`, `done`, and `drop`.
Only these transitions are legal:

```text
start   open                         -> in_progress
stop    in_progress                  -> open
hold    open | in_progress           -> on_hold
resume  on_hold                      -> open
done    open | in_progress | on_hold -> done
drop    open | in_progress | on_hold -> drop
```

Both terminal states release dependents. A task is ready when it is `open` and
all `needs` targets are terminal. `blocked` contains open or in-progress tasks
with unresolved needs; on-hold tasks appear in neither view.

All relationship authority is outgoing from the addressed document. `blocks`,
`children`, and `supersededBy` are reverse projections. The symmetric related
view is the union of the addressed task's `relates` plus tasks that declare it.
Declarations on both sides are idempotent, not corruption. Removing `relates`
removes only the addressed task's declaration; removing an edge declared only
by the other side refuses and names that task.

Product graph mutation rejects a missing target or self edge that the mutation
itself declares. It does not validate unrelated documents and never detects or
rejects a cycle. Manual and product-written graph disease remains authoritative
until another mutation or manual edit changes it. `doctor` is the sole active
graph-diagnosis surface; it reports missing targets, self edges, and cycle
components in `needs`, `parent`, and `supersedes`. `needs` is ordering and
blocking; `parent` is grouping/decomposition. Parent supports recursive
descendant observation and scoped selection, but never cascades lifecycle or
propagates needs. `supersedes` is navigation, and `relates` is nonblocking;
neither changes readiness or lifecycle.

Each complete board observation constructs one Task-owned ephemeral relation
projection. Task detail, blocker and status views, recursive tree, and query
consume that same projection; none reconstructs reverse relations by rescanning
the board. Outgoing declarations remain canonical Task-document authority. The
projection is derived read state only: it is neither persisted nor cached across
board observations.

## Native TypeScript Surface

`@astrosheep/keiyaku/task` is the sole public import. Inputs are readonly
objects validated at the JavaScript boundary.

World discovery for Task reads is a three-arm observation: `present` carries a
read from one observed Task world, `absent` means no discoverable `.keiyaku`
world exists at the coordinate, and `failed` means a discovered world could not
be read. `Tasks.of` is constructed only in the `present` arm. Absence is never
converted to an accepted empty list or a healthy doctor report.

```ts
Tasks.of(world: WorldRoot): Tasks
tasks.root: string
tasks.task(input: { id: string }): Task
tasks.add(input: AddTaskInput): Promise<TaskMutationResult>
tasks.addDocument(input: AddTaskDocumentInput): Promise<TaskMutationResult>
tasks.list(input?: { selection?: "active" | "closed" | "all"; scope?: "namespace" | "world"; namespace?: readonly string[]; limit?: number }): Promise<TaskList>
tasks.ready(input?: { scope?: "namespace" | "world"; namespace?: readonly string[]; parent?: string; limit?: number }): Promise<TaskList>
tasks.blocked(input?: { scope?: "namespace" | "world"; namespace?: readonly string[]; parent?: string; limit?: number }): Promise<BlockedTaskList>
tasks.query(input?: { where?: TaskQueryExpression; scope?: "namespace" | "world"; namespace?: readonly string[]; sort?: "priority" | "created" | "updated" | "id"; limit?: number }): Promise<TaskQueryResult>
tasks.doctor(): Promise<TaskDoctorReport>
tasks.batch(input: { verb: "done" | "drop" | "hold"; ids: readonly string[]; note?: string; signal?: AbortSignal }): Promise<TaskBatchResult>
tasks.compose(input: { markdown: string; namespace?: readonly string[]; actor?: string; signal?: AbortSignal }): Promise<TaskCompositionResult>

task.read(): Promise<TaskDetail | null>
task.tree(): Promise<TaskDecompositionTree>
task.update(input: UpdateTaskInput): Promise<TaskUpdateResult>
task.start(input?: { signal?: AbortSignal }): Promise<TaskMutationResult>
task.stop(input?: { signal?: AbortSignal }): Promise<TaskMutationResult>
task.hold(input?: { signal?: AbortSignal }): Promise<TaskMutationResult>
task.resume(input?: { signal?: AbortSignal }): Promise<TaskMutationResult>
task.done(input?: { note?: string; signal?: AbortSignal }): Promise<TaskMutationResult>
task.drop(input?: { note?: string; signal?: AbortSignal }): Promise<TaskMutationResult>
```

`Task.tree()` accepts no options. Root lookup is exact and returns the
existing `task-missing` refusal when absent. The accepted value is a
recursive parent-decomposition node:

```ts
type TaskTreeNode = Readonly<{
  task: TaskRef & Readonly<{ priority: TaskPriority | null }>;
  cycle?: true;
  children: readonly TaskTreeNode[];
}>;
type TaskDecompositionTree = TaskOutcome<TaskTreeNode>;
```

`TaskList`, `BlockedTaskList`, and `TaskQueryResult` accepted values carry
`rows`, the complete matching `total`, `returned`, and whether the requested
limit truncated the rows. The default limit is 100 and a caller may select an
integer from 1 through 1000. The fixed priority-then-TaskId order is stable for
one observed board snapshot; Task owns no continuation cursor or observer
session.

`add` accepts structured title, namespace, body, note, priority, relations,
optional initial state, optional actor, and signal. `addDocument` accepts
creation-document Markdown plus an optional namespace, actor, and signal. The
creation document cannot set identity, timestamps, or `createdBy` but may set
note and any persisted state; omitted note is empty and omitted state defaults
to `open`. `Tasks.compose` accepts the same optional actor and applies it only
to newly allocated nodes. `add`, `addDocument`, and `compose` validate actor as
optional nonblank bytes and persist it as `createdBy` when present. `update`,
start, stop, hold, resume, done, drop, batch, and settlement preserve existing
`createdBy` and do not accept actor. After creation, product state changes use
lifecycle methods. `done` and `drop` may replace the note in the same atomic
lifecycle mutation. `update` is a field-preserving patch: title, mutually
exclusive body or append-body, priority, relation replace/add/drop, nullable
parent, and note replacement. `TaskView` and full Task detail expose optional
`createdBy`; compact list and query rows do not.

Shape errors throw `TypeError` before world observation. Malformed persisted
authority throws `TaskAuthorityCorruptionError`. Infrastructure failures stay
exceptions. Domain results are:

```ts
type TaskOutcome<A> =
  | { kind: "accepted"; value: A }
  | { kind: "refused"; refusal: TaskRefusal }
  | { kind: "retry"; reason: "busy" | "concurrent-modification" }
```

`TaskNamespaceResult` is `TaskOutcome<readonly string[]>` and preserves a
malformed marker as `invalid-namespace-context`, not a programmer `TypeError`.
`TaskDoctorReport` contains ordered `issues`; each issue is a missing target,
self relation, or strongly connected cycle component. An empty issue array is
healthy. Doctor observes authority and never repairs it.

Add and lifecycle acceptance return `TaskView`. Only accepted `update`, including
a note-only replacement, returns the exact predecessor-to-successor
whole-document diff. Batch applies IDs in input order, continues after failures,
preserves accepted items, and returns every item. Cancellation stops before the
next item and never interrupts an atomic replacement.

## Views

`show <TaskId>` is world-scoped and returns exact fields, body, direct needs
with released status, unresolved blockers, derived blocks/children/
supersededBy/related, parent, and outgoing supersedes
bytes when present.
`tree <TaskId>` follows parent decomposition from one observed board.
Starting at the addressed root, it recursively selects Tasks whose `parent`
equals the current TaskId, in canonical TaskId byte order. A node seen again
in its current ancestry is a terminal `cycle: true` node with empty children;
tree never recurses past it. Missing parent targets remain doctor issues and
do not invent child nodes. `needs` stays the ordering/blocking projection in
`show` and readiness; it is not the decomposition tree. `doctor` diagnoses the
complete world independently of current namespace.

`list` defaults to active tasks in the current namespace. Closed and all are
explicit selections; `scope: "world"` escapes the current namespace. `ready`
and `blocked` have the same scope rule and accept an optional parent TaskId;
parent-scoped results contain only recursive descendants of that Task. Rows
sort by priority then TaskId bytes and contain TaskId, priority, disposition,
and title. Every list result is bounded by its optional `limit` and carries an
honest `total` for the complete matching set; no result requires title/body
prose inference. Blocked rows add unresolved blocker references only. File
mtime is never read.

`query` is the general read surface over one Task board snapshot. Its public
input is a typed expression tree, never a shell string. Task owns the exported
relation-predicate vocabulary for `under`, `needs`, and `blocks`. The predicate
fields are `state`, `priority`, `title`, `id`, `parent`, recursive `under`,
`needs`, reverse `blocks`, `ready`, `blocked`, `created`, and `updated`;
boolean nodes are `and`, `or`, and `not`. For a candidate row `R`, `blocks=X` is true if and
only if `X` is in `R.blocks`, equivalently if and only if `R.id` is in
`X.needs`; `blocks!=X` is only the negation of this condition. The evaluator
rejects unknown fields, incompatible
operators, malformed TaskIds, and invalid timestamps before reading authority.
It returns the same bounded page shape as the named views: `rows`, complete
`total`, `returned`, and `truncated`. Filtering precedes limiting, and sorting
is deterministic with a TaskId byte tie-breaker. Query has no cursor, session,
claim, assignment, scheduler, Contract, Akuma, Git, or prose-inferred field.
`under` and the named-view `parent` selector require an existing parent and
select recursive descendants only; a missing parent is a typed Task refusal.
An omitted query expression selects active Tasks, excluding `done` and `drop`.
The Task operations owner can project the complete world rows and these blocker
references from one board snapshot for a composite reader. That same internal
composite observation also exposes enough data to select ordinary `TaskRow`
values by exact namespace or current `createdBy`. Public contextual rows
contain only the existing `TaskRow` fields; they do not expose `createdBy`,
timestamps, note, body, or Task persistence. Both selections include every
Task state and preserve priority-then-TaskId byte order. They are complete,
not paged: there is no row cap, latest-only rule, continuation, omitted
counter, cache, reverse index, or persisted projection. This observation
does not expose Task persistence or read TaskHolder or Contract authority.

## Compose

Compose accepts a tree-shaped document. An optional first `ns=<segment/...>`
or `ns=` pins allocation namespace; otherwise current context is captured once.
`+ Title` allocates a task, `@task/id` modifies one, and two-space indentation
assigns parent. Exact assignment prefixes are `parent`, `needs`, `supersedes`,
`relates`, `pri`, and bare `body=`. `=` replaces or clears and `+=` appends;
scalar parent and priority reject `+=`. Prose replaces body. Body lines that
begin with `\`, `+ `, or `@task/` use one leading backslash, which parsing strips
and failure-draft serialization restores.

Planning first allocates every `+` node in document order, then resolves every
full TaskId reference against the board and all allocations. One document may
address a TaskId at most once. Planning validates missing targets and self edges
introduced by planned documents but performs no cycle diagnosis. An empty
change set is accepted.

Documents admit in TaskId byte order. Each successful atomic rename is an
independent Task commit point; compose has no cross-file atomicity or rollback.
The first failure stops. A syntax or planning refusal has no draft. Once
admission began, the result retains admitted diffs and returns canonical DSL
for only the remaining intent. That draft always includes resolved `ns=` and
is directly reusable as compose input.

```ts
type TaskCompositionResult =
  | { kind: "accepted"; documentChanges: readonly TaskDocumentChange[] }
  | { kind: "refused"; refusal: TaskRefusal }
  | { kind: "incomplete"; documentChanges: readonly TaskDocumentChange[];
      stopped: TaskRefusal | { kind: "retry"; reason: "busy" | "concurrent-modification" };
      draft: string }
```

## Admission And Coordination

One Task file replacement is one commit point. Task never stages, commits, or
changes Git refs. It writes a temporary regular file, flushes it, rechecks the
observed predecessor bytes, atomically renames it, and syncs the directory when
that platform supports directory fsync.

Cooperating writers use `.keiyaku/locks/task/<namespace...>/<local-id>.sqlite`.
ID allocation first takes `.keiyaku/locks/task-allocation.sqlite`; compose then
takes its addressed task locks in TaskId byte order. Relation changes have no
world-wide adjudication and take only the addressed task lock. The shared
SQLite transaction primitive waits at most three seconds and propagates
cancellation. Databases contain no Task fact, owner row, PID, lease, heartbeat,
or stale-break policy and may be recreated when idle. Only coordination imports
`node:sqlite`.

Lock acquisition is awaited before a Task mutation enters its serial writer
section. The bounded `DatabaseSync` transaction used by the coordination owner
is the sole synchronous SQLite exception; it contains only one lock decision
and custody handoff. Task file observation and cleanup remain asynchronous.

Locks serialize cooperating writers; predecessor-byte comparison remains the
sole write adjudicator against manual editors. Byte movement returns
`concurrent-modification`. Removing idle lock files never affects authority.

## Contract Boundary

Task Markdown has no Contract association field and Task operations expose no
association mutation. Creation never infers actor from Contract state, current
namespace, Git author, Akuma dispatch, or TaskHolder settlement. The current
cross-product relationship is the TaskHolder authority defined by
[settlement.md](settlement.md). Task contributes only its complete identity
and the Task-owned state transition primitive used after settlement has judged
that holder.

## Keiyaku-Owned Data Reset

Task owns the custody of canonical Task Markdown authority and its allocation
and per-Task coordination locks. Confirmed Task reset removes only regular
canonical Markdown authority. It preserves
`.keiyaku/namespace/current`, its local ignore support, project Settings,
unknown `.keiyaku` bytes, and all non-Task authority; it does not remove now-
empty directories.

Before removal, Task validates its selected Markdown authority and dedicated
lock custody, then takes its allocation and addressed Task locks. Corruption,
foreign or nonregular lock custody, contention, or changed authority leaves
the affected custody for a retry rather than removing it. Repeating the literal
World confirmation retries remaining authority and never reconstructs it.
After releasing the locks, reset leaves their paths as harmless coordination
residue because it cannot prove the same path was not reacquired.

The Task owner exposes its deletion entry point; World composition does not
inspect Task custody.
