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
the title with the shared identity normalizer. For newly allocated Tasks only,
the local stem accumulates normalized hyphen-separated words without splitting
a word and stops before the next word would exceed 32 Unicode code points; the
first word is retained even when it is longer than that budget. A closed task
still occupies its coordinate. Collision allocation uses the first free numeric
suffix beginning at `-2` after the fitted base stem. Existing TaskIds and
references are never rewritten.
Callers never provide an arbitrary ID, and title updates never move authority.

Namespace is the immutable identity coordinate carried by a TaskId and
encoded by its authority path. Context is the directory-local default
pointer to a namespace. There is no third Contract namespace concept;
Settlement may install a ContractId-derived context value, and Kanshi
matches Tasks by TaskId namespace, never by directory context.

The world-local current namespace is context, not Task or Contract
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
namespace scope. An explicit add `--namespace` or compose `ns=` header is
authoritative and does not read or refuse on a malformed current marker.
Omitted selectors resolve current context. Explicit full-TaskId operations
(`show`, `tree`, `update`, and lifecycle) carry no context. `doctor` is always
world-scoped. `--world` on `list`, `ready`, `blocked`, and `query` selects
every namespace in the current Task world. The caller edge writes
`task context X` at the invocation directory for Git and at WorldRoot for
non-Git. Context source is a read-time classification from existing
workspace and Contract facts; it is not persisted provenance.

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

Confirmed `keiyaku nuke` enumerates owned Task authority from the
`.keiyaku/tasks/**` path topology and regular-file shape. A regular non-symlink
`.md` file whose relative path is a valid Task coordinate is eligible for
deletion even when its Markdown is corrupt; the reset never decodes content to
decide custody. Invalid-coordinate paths, symlinks, nonregular entries, and
bytes outside the Task authority root remain and are not decoded as Task
documents. The reset acquires the allocation lock first and enumerates owned
paths only while that lock is held, so a Task created while the reset waits is
still in the deletion set. It then acquires the per-Task locks for the complete
valid path-derived ID set in canonical byte order, re-observes those paths, and
deletes only still-present regular non-symlink owned files. A concurrent lock
timeout is the existing busy failure; a malformed document is not. Empty
directories inside the tasks root are removed after owned files are gone,
including when the owned set is empty, and only when no unknown, nonregular, or
symlink entry remains. The `.keiyaku/tasks` root and sibling authority stay.
Ordinary reads and mutations still reject corrupt persisted authority.

Public Task reads and writes are asynchronous and observe complete files. Each
mutation replaces one complete authority file atomically; there is no second
sync API or parallel writer.

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

Task may be reached through one direct-parent Akuma Body Request, but that
integration edge is not Task authority. The Task owner runs the same operation
for the caller-selected World and retains no request lifecycle fact.

## Lifecycle And Graph

Persisted states are `open`, `in_progress`, `on_hold`, `done`, and `drop`.
Creation may write any persisted state as a birth fact. After birth, only these
transitions are legal:

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

Reverse relations are one Task-owned projection of a complete board observation.
They are derived read state, never persisted or cached across observations, and
outgoing declarations remain canonical document authority.

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
tasks.batch(input: { verb: "start" | "done" | "drop" | "hold"; ids: readonly string[]; note?: string; signal?: AbortSignal }): Promise<TaskBatchResult>
tasks.compose(input: { markdown: string; namespace?: readonly string[]; actor?: string; signal?: AbortSignal; plan?: boolean }): Promise<TaskCompositionResult>

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

Each compact `TaskRow` contains `id`, `title`, `state`, `priority`,
`disposition`, persisted `updatedAt`, `bodyPresent`, and optional direct-child
counts `{ live, total }`. `bodyPresent` is true exactly when the persisted body
is nonempty. Child counts come from the one relation projection: `total` counts
all direct children and `live` excludes `done` and `drop`; the field is absent
when there are no children. `TaskQueryRow` carries these fields in addition to
its existing parent, needs, blocks, createdAt, and updatedAt facts.

`add` accepts structured title, namespace, body, note, priority, relations,
optional initial state, optional actor, and signal. `addDocument` accepts
creation-document Markdown plus an optional namespace, actor, and signal. The
creation document cannot set identity, timestamps, or `createdBy` but may set
note and any persisted state; omitted note is empty and omitted state defaults
to `open`. A new `Tasks.compose` node may likewise select any persisted initial
state and defaults to `open`; compose cannot set state on a pre-existing node.
`Tasks.compose` accepts the same optional actor and applies it only to newly
allocated nodes. `add`, `addDocument`, and `compose` validate actor as
optional nonblank bytes and persist it as `createdBy` when present. `update`,
start, stop, hold, resume, done, drop, batch, and settlement preserve existing
`createdBy` and do not accept actor. After creation, product state changes use
lifecycle methods. `done` and `drop` may replace the note in the same atomic
lifecycle mutation. `update` is a field-preserving patch: title, mutually
exclusive body or append-body, priority, relation replace/add/drop, nullable
parent, and note replacement. `appendBody` preserves its supplied bytes and
inserts exactly one LF at the boundary when the existing nonempty body does not
end in LF and the addition does not already begin with LF. An empty body
receives the addition unchanged; an existing trailing LF is never duplicated.
`TaskView` and full Task detail expose optional
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

`TaskContextResult` is `TaskOutcome<{ namespace: readonly string[]; source:
"default-root" | "contract-installed" | "local-override" }>` and preserves a
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

`show` observes complete addressed Tasks and their direct and derived
relationships. CLI argument grammar and text/JSON presentation belong to
[cli-task.md](cli-task.md).
`tree <TaskId>` follows parent decomposition from one observed board.
Starting at the addressed root, it recursively selects Tasks whose `parent`
equals the current TaskId, in canonical TaskId byte order. A node seen again
in its current ancestry is a terminal `cycle: true` node with empty children;
tree never recurses past it. Missing parent targets remain doctor issues and
do not invent child nodes. `needs` stays the ordering/blocking projection in
`show` and readiness; it is not the decomposition tree. `doctor` diagnoses the
complete world independently of current namespace.

`list` defaults to active Tasks in the current namespace; closed, all, and
world scope are explicit. `ready` and `blocked` share that scope and may select
recursive descendants of one existing parent. Results are priority-then-TaskId
ordered, bounded with complete totals, and never infer data from prose or mtime.
Blocked rows add unresolved blocker references. Presentation belongs to
[cli-task.md](cli-task.md).

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
The Task operations owner can project complete world rows and blocker references
from one board snapshot for composite readers. Public contextual rows retain
only the existing `TaskRow` fields, preserve priority-then-TaskId order, and are
complete rather than paged; they do not expose Task persistence or Contract
authority.

## Compose

Compose is the Task product's batch planning and admission operation. It accepts
one caller-supplied composition document and captures its effective namespace
once. The optional first-line `ns=` header is the document-level selector:
omission uses the already-resolved current context, `ns=/` selects root, and a
nonblank slash-separated value selects that namespace. Empty `ns=` is invalid
and the diagnostic names `ns=/`. Recovery drafts always emit `ns=/` for root.
Compose has no `--namespace` flag. Planning allocates every new Task identity
before admission, resolves
references against the pre-existing board plus document-local new-node
identities, and validates the complete post-image before any authority file is
replaced. A document may address one Task at most once.

Planning rejects malformed input, unresolved references, invalid relation
patches, self edges, and cycles introduced by the planned `needs` or `parent`
edges. Existing graph disease remains the responsibility of `doctor`. A valid
plan has a deterministic admission order: dependencies required by a new
`needs` or `parent` edge precede their dependents, and otherwise document order
is the tie-break. The optional plan result exposes the resolved aliases,
admission order, and body byte previews without writing authority.

Each new node may declare `state = open|in_progress|on_hold|done|drop` as its
birth state; omission means `open`. This property accepts only `=` and is
invalid on a pre-existing node, whose state remains writable only through
Task lifecycle methods. Composition aliases are nonempty single-line tokens
containing no Unicode whitespace or comma; all other characters are accepted.

Each admitted file replacement is an independent Task commit point. Compose has
no cross-file atomicity or rollback; the first admission failure stops and
retains already admitted changes. The incomplete result carries the stopped
reason, admitted changes, resolved composition facts, and a reusable draft for
only the remaining intent. Replaying that draft against the resulting board
completes the original intent and preserves body bytes. Compose does not change
the lifecycle state, title, or note of pre-existing Tasks, and does not alter
Contract/Akuma authority.

The public result is:

```ts
type TaskCompositionResult =
  | { kind: "planned"; aliases: readonly TaskCompositionAlias[]; admissionOrder: readonly TaskId[]; bodies: readonly TaskCompositionBodyPreview[] }
  | { kind: "accepted"; aliases: readonly TaskCompositionAlias[]; admissionOrder: readonly TaskId[]; documentChanges: readonly TaskDocumentChange[] }
  | { kind: "refused"; refusal: TaskRefusal }
  | { kind: "incomplete"; aliases: readonly TaskCompositionAlias[]; admissionOrder: readonly TaskId[]; documentChanges: readonly TaskDocumentChange[]; stopped: TaskRefusal | { kind: "retry"; reason: "busy" | "concurrent-modification" }; draft: string }
```

## Admission And Coordination

One Task file replacement is one commit point. Task never stages, commits, or
changes Git refs; predecessor-byte comparison is the write adjudicator.

Cooperating writers serialize allocation, addressed mutations, and confirmed
nuke cleanup with the Task-owned lock resources. Lock acquisition is awaited
before the serial writer section; coordination contains no Task facts or
durable owner state.

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
