# World

World is the shared directory coordinate used by the Task and Akuma products
and by project-level Settings and Kanshi reads. A Git repository determines one
World, but World owns neither Git nor product facts.

## Coordinate

```ts
type WorldRoot = Brand<string, "WorldRoot">

type WorldResolutionInput = {
  cwd: string
  repositoryRoot?: string
}

type WorldResolution = {
  root: WorldRoot | null
  candidate: WorldRoot | null
  establish(): Promise<WorldRoot>
}

World.resolve(input: string | WorldResolutionInput): Promise<WorldResolution>
World.locate(input: string | WorldResolutionInput): Promise<WorldRoot | null>
World.at(path: string): Promise<WorldRoot>
```

`World.resolve` resolves the invocation directory once and returns the current
root, the non-writing candidate root, and the creating operation for that same
resolution. Reading either coordinate never changes the filesystem;
`establish()` creates only the selected marker. `World.locate` is the read-only
projection of `root`.

Each operation completes its filesystem observation before its Promise resolves.

When `repositoryRoot` is supplied, that canonical Git primary worktree is the
WorldRoot; the marker is not consulted and no filesystem is changed. Without
it, the resolver climbs toward the filesystem root for the nearest `.keiyaku/`
marker. It skips the user home directory selected by the process edge (`$HOME`)
and the filesystem root itself; neither may be a World. A non-Git invocation
with no marker returns `null` and creates nothing.

`candidate` is the coordinate that `establish()` would select. It equals
`root` when a marker or repository root selected one; otherwise it is the
canonical invocation directory. Home and filesystem root yield a null
candidate and retain their typed refusal when establishment is attempted.

`establish()` is the creating form of the same invocation resolution. With a
`repositoryRoot` it establishes the primary worktree marker. Without one it
reuses the nearest marker, or establishes the invocation directory when none
exists.

`World.at(path)` is different: it constructs an explicitly selected WorldRoot
and establishes exactly that existing directory. It never climbs. This is the
library boundary for callers that already hold the coordinate rather than an
invocation path. A missing directory or non-directory marker is a typed world
error. Home and filesystem root remain forbidden.

The CLI resolves the invocation Git repository once, passes its
`primaryWorktree` as `repositoryRoot`, and retains one `WorldResolution` for
the invocation. Library callers pass the resulting `WorldRoot`; product
constructors never resolve a path or inspect the process cwd.

The invocation cwd is an input to this edge policy only. It is not persisted or
part of any identity. An Akuma persists its execution `cwd` as an answer to
where its body works, not where its world is stored.

## Product Boundaries

Task authority remains tracked Markdown at `<world>/.keiyaku/tasks/**`.
Linked and managed worktrees are execution views of the same Git World; their
markers cannot split product identity. Akuma runtime facts remain local under
`<world>/.keiyaku/akuma/run`, so a body launched from any worktree reads and
writes the same fleet while retaining its actual execution cwd.

Git discovery is an invocation-edge concern. A command carries one resolved
`WorldRoot | null` and one optional `Repo` to all sections that need them.
Explicit Contract `--repo` selection is a separate Git coordinate and never
changes the invocation World. Contract-selector wait and kill read Dispatch
from that Repo and operate on the resolved AkuIds in the `-C` World; they do
not scan another World or replace `-C` with `--repo`.
Two different repository coordinates name two Worlds and are never composed
into one aggregate observation.

## Keiyaku-Owned Data Reset

`nuke` is a Keiyaku-owned data reset for exactly one resolved `WorldRoot`. It
is not repository cleanup and is not a generic World teardown. World owns the
reset scope, literal confirmation, preservation rule, and one execution result;
each product owner owns its deletion custody.

A bare operation is the `nuke-confirmation-required` refusal. A confirmation
must equal the resolved `WorldRoot` byte for byte; mismatch is the
`nuke-confirmation-mismatch` refusal before every owner effect. Confirmed
execution stops live writers before deleting their owned state and returns one
success or failed diagnostic. The same literal confirmation retries remaining
owned data. No preview, token, snapshot hash, prompt, World-wide lock, reset
ledger, backup, trash, undo, or lifecycle simulation exists.

Only Keiyaku-produced management data owned by the selected World is in scope.
Repository source and business refs, ordinary worktree bodies, project and
user Settings, namespace configuration, global Archetypes, and unknown
`.keiyaku` bytes remain. A managed worktree is removable only because its
worktree and appointment are Keiyaku-owned custody; this does not authorize
repository cleanup or deletion of arbitrary worktrees. A marker or directory
is removed only after owner cleanup leaves it empty. Recognized Akuma entries
are Keiyaku-owned custody: nuke removes their known management artifacts and
known request-channel protocol files, preserves unknown child bytes including
unknown descendants inside a request channel, and preserves coordination lock
files outside the entry. A recognized entry and the Akuma run root are removed
only when no non-Keiyaku bytes remain.

The reset law maps to one owner per concern:

| Concern | Owner |
| --- | --- |
| Resolved World coordinate, literal confirmation, execution result, and preservation rule | This chapter |
| Runtime-body admission, stoppage, and World-local Alias authority | [akuma.md](akuma.md), [akuma-heart.md](akuma-heart.md), and [alias.md](alias.md) |
| Keiyaku refs, managed-worktree custody, appointments, locks, and reconciliation residue | [git.md](git.md), [workspace.md](workspace.md), [git-reconciliation.md](git-reconciliation.md), and [settlement.md](settlement.md) |
| Task authority and Task locks | [task.md](task.md) |
| Authored Settings, namespace configuration, and global Archetypes that remain | [settings.md](settings.md) |
| Package-root inputs and result declarations | [public-api.md](public-api.md) and [public-results.md](public-results.md) |
| Command grammar and output projection | [cli.md](cli.md) and [cli-output.md](cli-output.md) |

The package composition stops active writers, then attempts the owner-local
deletion entry points independently. It has no fixed cross-owner order,
storage path, ref, glob, inventory, count, or residue-specific knowledge.

The Git owner performs its reset state-first: it removes the state authority
with an expected-OID compare-and-swap before deleting regenerable topology.
This ordering is local to Git and does not create a World-wide reset lock or
transaction; an owner failure remains retryable under the same confirmation.
