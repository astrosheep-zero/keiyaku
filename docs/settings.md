# Settings

Settings is the public resource value for user and project configuration. It
owns where settings files live, their common outer grammar, scope precedence,
failure isolation, entry provenance, and observation. It owns no product
namespace name or record-internal schema.

## Public Resource

```ts
settings(input?: { root?: string; home?: string }): Promise<Settings>

type Settings = Readonly<{
  scopes: Readonly<{
    project: SettingsScopeState
    user: SettingsScopeState
  }>
  namespace(name: string): SettingsNamespaceView
}>
```

`root`, when present, is one absolute WorldRoot supplied by the process edge
and selects `<root>/.keiyaku/settings.json`. Git worktrees of one repository
receive the same primary-worktree root; Settings never treats a managed
worktree marker as a separate project scope. An omitted root means there is no
project scope; Settings never reads `process.cwd()` or discovers a world.
`home` selects
`<home>/settings.json`; it defaults to `~/.keiyaku`. A caller-supplied home
always wins. The library never interprets `KEIYAKU_HOME`; a process edge may
map that environment value to the explicit `home` input.

Each scope is `read`, `absent`, or `failed`. Every state exposes its absolute
path. A read scope exposes its namespace names; a failed scope carries one
bounded diagnostic. Missing files are lawful absence. JSON, root-grammar, and
I/O failure fail only that scope.

## Grammar And Shadowing

The root is an object from namespace name to namespace value. Every namespace
is an object from entry name to an opaque JSON value. The resource layer
validates only those two container levels; a Gate entry and a provider entry
may each be objects with unrelated product-owned grammars. It treats every
unknown root key as a possible future namespace and never imports product
vocabulary.

Project entries shadow user entries by the complete same-name record. Fields
never merge. A resolved entry exposes its `project` or `user` source; a project
entry may expose that it shadows a user candidate. A malformed higher-scope
namespace or a failed higher scope never silently falls through to the lower
same-name record.

Namespace container grammar is evaluated when `namespace(name)` is read. A malformed
namespace fails that namespace view without failing unrelated namespaces. A
failed scope fails every namespace view because the reader cannot know whether
that scope contains a shadowing entry. Unread malformed namespaces do not
block unrelated operations.

Settings itself is the complete resource observation. There is no disease
catalog, registry, deep merge, per-field provenance, eager product validation,
or second diagnostic model.

## Product Consumption

Products own entry-name grammar, record-internal fields, defaults, validation,
and admission timing. A missing or malformed selected entry rejects only the
operation that selected it. Unknown record fields are judged by that product,
not by Settings.

The Contract product publicly provides `gatesFrom({ settings, names? })`. It
reads the `gates` namespace and returns one concrete ordered, duplicate-free
public Gate snapshot. A catalog name and gate word match
`^[a-z][a-z0-9-]{0,63}$`. Each selected entry is exactly one record of this
first supported kind:

```json
{ "kind": "bundle", "gates": ["reviewed", "verified"] }
```

`bundle.gates` contains leaf producer tokens, not names of other catalog
entries. This bundle-only grammar admits only the currently dischargeable
`reviewed` and `verified` leaves; an empty bundle and repeated leaves are
legal. Selection expands records in caller order and removes duplicate leaves
stably at their first occurrence. A selected bare array, unknown field,
unknown kind, invalid leaf, or unknown explicit name is a product Settings
error. Unselected entries remain opaque and unvalidated so future kinds do not
break unrelated selections.

Omitted `names` selects `default` and returns `["reviewed"]` when that entry is
absent. A present empty `default` bundle overrides that built-in default.
Explicit `names: []` selects nothing. Bind and amend continue to accept
concrete Gate arrays. Admission freezes only the expanded array into Contract
terms; catalog names, definitions, and later Settings edits never alter an
existing Contract or its status.

The Contract product also provides `worktreeHooksFrom({ settings })`. It reads
the `worktree` namespace and returns one concrete `WorktreeHooks` value. The
namespace has exactly two optional entries, `create` and `destroy`; an unknown
entry is a product settings error. Each entry is an ordered array of commands:

```json
{
  "worktree": {
    "create": [
      { "argv": ["npm", "ci", "--ignore-scripts"], "timeoutMs": 300000 }
    ],
    "destroy": [
      { "argv": ["./scripts/teardown.sh"], "timeoutMs": 60000 }
    ]
  }
}
```

An omitted entry means an empty command array. `argv` must be a nonempty array
of strings whose executable is nonblank. `timeoutMs` must be an integer from 1
through 2,147,483,647. Commands execute directly without a shell; interpolation
and environment loading are not part of Settings. The returned arrays and
commands are deeply frozen. A Keiyaku-created worktree uses only commands
decoded from the project Settings bytes in the snapshot it checks out. Managed
worktrees freeze those commands in their durable marker. Disposable Verification
scratch uses a project-only reader against its materialized integration tree:
it does not read user Settings, caller-current Settings, caller lockfiles, or
caller `node_modules`, and it retains no marker or progress state. Execution
and durable freezing rules are owned by [git-reconciliation.md](git-reconciliation.md).

The Git integration consumer publicly provides
`requireBranchesToBeUpToDateFrom({ settings })`. It reads the one optional
boolean entry `git.requireBranchesToBeUpToDate` and defaults to `false` when
the entry is absent. The `git` namespace rejects unknown entries and a
non-boolean selected value with `SettingsError`. The CLI resolves this consumer
for each deliver and audit invocation and passes only the resulting boolean;
Git custody never imports Settings. Project/user shadowing and provenance
remain the generic namespace behavior above.

Akuma owns the `providers` interpreter and record grammar in
[akuma-provider.md](akuma-provider.md), with Soul freezing in
[akuma.md](akuma.md). Settings contributes only the resolved opaque
entry and its provenance. Settings scope paths are observation evidence, not
Akuma's home coordinate.

Keiyaku does not load `<home>/.env`, `<root>/.keiyaku/.env`, or any other
dotenv file. It performs no environment interpolation inside settings JSON.
Shells and environment managers may populate `process.env` before invocation;
that remains outside the Settings resource.

## Observation

The CLI `settings [--json]` command constructs this public value from its
resolved `-C` root and explicit edge-mapped home, then renders scope states and
resolved namespace entries with their source and shadow observation. It is
read-only. Settings files remain user-edited resources; there is no settings
write command and no redaction under the local-trusted-user threat model.

The Settings module never names `gates`, `worktree`, `providers`, a provider
kind, or any other product concept. Product modules never read settings file
paths. Those two checks are the boundary sentinels.
