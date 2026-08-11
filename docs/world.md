# World

World is the shared directory coordinate used by the Task and Akuma products
and by project-level Settings and Kanshi reads. It is not a Git world and it
does not own any product facts.

## Coordinate

```ts
type WorldRoot = Brand<string, "WorldRoot">

World.locate(cwd: string): WorldRoot | null
World.at(path: string): WorldRoot
```

`World.locate` resolves an existing directory and climbs toward the filesystem
root for the nearest `.keiyaku/` marker. It never climbs through the user home
directory selected by the process edge (`$HOME`); `$HOME` is never a World.
When no marker is found it returns `null` and creates nothing.

`World.at` resolves exactly the supplied existing directory, rejects `$HOME`,
and asserts or creates its `.keiyaku/` marker. It never searches upward or
downward. A missing directory or non-directory marker is a typed world error.

The CLI is the only climb policy: it calls `locate` for read commands and uses
`locate` followed by `at` for commands that create world-local facts. Library
callers pass the resulting `WorldRoot`; product constructors never resolve a
path or inspect the process cwd.

The invocation cwd is an input to this edge policy only. It is not persisted or
part of any identity. An Akuma persists its execution `cwd` as an answer to
where its body works, not where its world is stored.

## Product Boundaries

Task authority remains tracked Markdown in the checkout at
`.keiyaku/tasks/**`. A managed worktree is another checkout view of the same
tracked authority; its nearest marker selects that view. Akuma runtime facts
remain local under `<world>/.keiyaku/akuma/run`.

Git discovery is optional and belongs only to the Contract edge. A command may
therefore have one `WorldRoot | null` and one optional `Repo`, resolved once and
passed to all sections that need them.
