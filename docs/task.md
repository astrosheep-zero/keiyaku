# Task Product

Task is a directory-context planning product shipped from the same npm package
under `./task`. It answers what work exists, what can begin, and what blocks it.
It is not part of contract core, protocol, Git, or contract lifecycle.
Contract modules never import Task modules. Task does not import `Repo`, read
Contract authority, or interpret a retained contract association.

## World, Context, And Identity

A Task world is one product World. The CLI supplies the `WorldRoot` from its
single `World.resolve` result; the Task product receives that root directly.
`Tasks.of(root)` never searches upward, reads Git state, or inspects the process
cwd. In a Git repository every worktree uses the primary worktree WorldRoot;
a worktree marker cannot split Task authority. Outside Git, a nearer nested
marker deliberately starts another Task world.

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

An absent marker means the root namespace. A malformed marker refuses
context-consuming Task operations as `invalid-namespace-context`. `add`,
`addDocument`, and `compose` use it as their allocation default; `list`,
`ready`, and `blocked` use it as their default scope. Explicit full-TaskId
operations (`show`, `tree`, `update`, and lifecycle) never consult it.
`doctor` is always world-scoped. `setNamespace` atomically replaces it.

The byte law and read/write primitive belong to Task. Installation in a
managed Contract worktree is driven only by [settlement](settlement.md), which
derives the default from Contract state and calls the Task-owned primitive.

## Authority And Document

The sole Task authority is canonical Markdown at:

```text
.keiyaku/tasks/<namespace...>/<local-id>.md
```

Task authority is ordinary repository-visible content. A repository-level
ignore policy must leave `.keiyaku/tasks/**` visible to Git so Task state can
be reviewed and shared; runtime siblings such as locks, Akuma runs, responses,
and dispatch state remain ignored. Task itself still never stages, commits, or
changes Git refs.

The path owns identity. Closed front matter repeats the full `id` as an
integrity witness and contains `title`, `state`, `priority`, `needs`, `parent`,
`supersedes`, `relates`, `note`, `createdAt`, `updatedAt`, and optional
prose is the body. The ID must equal the path-derived coordinate.
Unknown keys and malformed documents are authority corruption. Manual editing
is authoritative; a manual move that breaks the witness is corruption.

`priority` is `0 | 1 | 2 | 3` and defaults to `2`. Relation arrays are ordered,
duplicate-free full TaskIds. `note` is a string and defaults to empty.
`createdAt` and `updatedAt` are canonical UTC ISO
timestamps. Product creation sets both to one captured time. A product mutation
that changes Task authority preserves `createdAt` and advances `updatedAt` once;
a no-op update preserves both. Manual writers own the truth of both timestamps
when they edit authority. `parent` is nullable. V1 has no
cached readiness, counters, task log, NDJSON trace, private history ref, or
`history <TaskId>`. Because manual, uncommitted Markdown edits remain
authoritative, Task does not promise complete change-since-observation,
history, or event-log reads; a partial journal would be dishonest.

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

Settlement alone may apply the coordination-only transition `done -> open`
for an abandoned current TaskHolder. It is not a public Task verb. Task itself
does not observe Contract state or TaskHolder authority, or decide when that
transition applies.

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

## Native TypeScript Surface

`@astrosheep/keiyaku/task` is the sole public import. Inputs are readonly
objects validated at the JavaScript boundary.

World discovery for Task reads is a three-arm observation: `present` carries a
read from one observed Task world, `absent` means no discoverable `.keiyaku`
world exists at the coordinate, and `failed` means a discovered world could not
be read. `Tasks.of` is constructed only in the `present` arm. Absence is never
converted to an accepted empty list or a healthy doctor report.

```ts
Tasks.of(root: WorldRoot): Tasks
tasks.root: string
tasks.namespace(): Promise<TaskNamespaceResult>
tasks.setNamespace(input: { namespace: readonly string[] }): Promise<void>
tasks.task(input: { id: string }): Task
tasks.add(input: AddTaskInput): Promise<TaskMutationResult>
tasks.addDocument(input: AddTaskDocumentInput): Promise<TaskMutationResult>
tasks.list(input?: { selection?: "active" | "closed" | "all"; scope?: "namespace" | "world"; limit?: number }): Promise<TaskList>
tasks.ready(input?: { scope?: "namespace" | "world"; parent?: string; limit?: number }): Promise<TaskList>
tasks.blocked(input?: { scope?: "namespace" | "world"; parent?: string; limit?: number }): Promise<BlockedTaskList>
tasks.query(input?: { where?: TaskQueryExpression; scope?: "namespace" | "world"; sort?: "priority" | "created" | "updated" | "id"; limit?: number }): Promise<TaskQueryResult>
tasks.doctor(): Promise<TaskDoctorReport>
tasks.batch(input: { verb: "done" | "drop" | "hold"; ids: readonly string[]; note?: string; signal?: AbortSignal }): Promise<TaskBatchResult>
tasks.compose(input: { markdown: string; signal?: AbortSignal }): Promise<TaskCompositionResult>

task.read(): Promise<TaskDetail | null>
task.tree(input?: { full?: boolean }): Promise<TaskDependencyTree>
task.update(input: UpdateTaskInput): Promise<TaskUpdateResult>
task.start(input?: { signal?: AbortSignal }): Promise<TaskMutationResult>
task.stop(input?: { signal?: AbortSignal }): Promise<TaskMutationResult>
task.hold(input?: { signal?: AbortSignal }): Promise<TaskMutationResult>
task.resume(input?: { signal?: AbortSignal }): Promise<TaskMutationResult>
task.done(input?: { note?: string; signal?: AbortSignal }): Promise<TaskMutationResult>
task.drop(input?: { note?: string; signal?: AbortSignal }): Promise<TaskMutationResult>
```

`TaskList`, `BlockedTaskList`, and `TaskQueryResult` accepted values carry
`rows`, the complete matching `total`, `returned`, and whether the requested
limit truncated the rows. The default limit is 100 and a caller may select an
integer from 1 through 1000. The fixed priority-then-TaskId order is stable for
one observed board snapshot; Task owns no continuation cursor or observer
session.

`add` accepts structured title, namespace, body, note, priority, relations,
optional initial state, and signal. `addDocument` accepts
creation-document Markdown plus an optional namespace and signal. The creation
document cannot set identity or timestamps but may set note and any persisted
state; omitted note is empty and omitted state defaults to `open`.
After creation, product state changes use lifecycle methods. `done` and `drop`
may replace the note in the same atomic lifecycle mutation. `update` is a
field-preserving patch: title, mutually exclusive body or append-body, priority,
relation replace/add/drop, nullable parent, and note replacement.

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
`tree <TaskId> [--full]` follows the parent decomposition relation recursively,
marks cycles, and either deduplicates shared nodes or expands every acyclic
occurrence. `needs` traversal remains the ordering/blocking projection in
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
input is a typed expression tree, never a shell string. The predicate fields
are `state`, `priority`, `title`, `id`, `parent`, recursive `under`, `needs`,
reverse `blocks`, `ready`, `blocked`, `created`, and `updated`; boolean nodes
are `and`, `or`, and `not`. The evaluator rejects unknown fields, incompatible
operators, malformed TaskIds, and invalid timestamps before reading authority.
It returns the same bounded page shape as the named views: `rows`, complete
`total`, `returned`, and `truncated`. Filtering precedes limiting, and sorting
is deterministic with a TaskId byte tie-breaker. Query has no cursor, session,
claim, assignment, scheduler, Contract, Akuma, Git, or prose-inferred field.
`under` and the named-view `parent` selector require an existing parent and
select recursive descendants only; a missing parent is a typed Task refusal.
An omitted query expression selects active Tasks, excluding `done` and `drop`.
The Task operations owner can project the complete world rows and these blocker
references from one board snapshot for a composite reader; this observation
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
observed predecessor bytes, atomically renames it, and syncs the directory.

Cooperating writers use `.keiyaku/locks/task/<namespace...>/<local-id>.sqlite`.
ID allocation first takes `.keiyaku/locks/task-allocation.sqlite`; compose then
takes its addressed task locks in TaskId byte order. Relation changes have no
world-wide adjudication and take only the addressed task lock. The shared
SQLite transaction primitive waits at most three seconds and propagates
cancellation. Databases contain no Task fact, owner row, PID, lease, heartbeat,
or stale-break policy and may be recreated when idle. Only coordination imports
`node:sqlite`.

Locks serialize cooperating writers; predecessor-byte comparison remains the
sole write adjudicator against manual editors. Byte movement returns
`concurrent-modification`. Removing idle lock files never affects authority.

## Contract Boundary

Task Markdown has no Contract association field and Task operations expose no
association mutation. The current cross-product relationship is the
TaskHolder authority defined by [settlement.md](settlement.md). Task contributes
only its complete identity and the Task-owned state transition primitive used
after settlement has judged that holder.
