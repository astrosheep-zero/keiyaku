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
  establish(): WorldRoot
}

World.resolve(input: string | WorldResolutionInput): WorldResolution
World.locate(input: string | WorldResolutionInput): WorldRoot | null
World.at(path: string): WorldRoot
```

`World.resolve` resolves the invocation directory once and returns the current
root plus the creating operation for that same resolution. Reading `root`
never changes the filesystem; `establish()` creates only the selected marker.
`World.locate` is the read-only projection of `root`.

When `repositoryRoot` is supplied, that canonical Git primary worktree is the
WorldRoot; the marker is not consulted and no filesystem is changed. Without
it, the resolver climbs toward the filesystem root for the nearest `.keiyaku/`
marker. It skips the user home directory selected by the process edge (`$HOME`)
and the filesystem root itself; neither may be a World. A non-Git invocation
with no marker returns `null` and creates nothing.

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
changes the invocation World.
Two different repository coordinates name two Worlds and are never composed
into one aggregate observation.
