# Settings

Settings is the public resource value for user and project configuration. It
owns where settings files live, their common outer grammar, scope precedence,
failure isolation, entry provenance, and observation. It owns no product
namespace name or record-internal schema.

## Public Resource

```ts
settings(input?: { root?: string; home?: string }): Settings

type Settings = Readonly<{
  scopes: Readonly<{
    project: SettingsScopeState
    user: SettingsScopeState
  }>
  namespace(name: string): SettingsNamespaceView
}>
```

`root`, when present, is normalized to one absolute project coordinate and
selects `<root>/.keiyaku/settings.json`. An omitted root means there is no
project scope; Settings never reads `process.cwd()`. `home` selects
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
validates only those two container levels; a Gate entry may be an array while a
provider entry may be an object. It treats every unknown root key as a possible
future namespace and never imports product vocabulary.

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

The Contract product publicly provides `gatesFrom({ settings, name? })`. It reads
the `gates` namespace and returns one concrete ordered, duplicate-free public
Gate snapshot. A gate word matches `^[a-z][a-z0-9-]{0,63}$`; `reviewed` and
`verified` are conventional words, not privileged type members. Each named
entry is an array of unique gate words, and an empty array is legal. Omitted
name selects `default` and returns `[]` when that entry is absent; an explicitly
selected missing name is usage failure. Bind and amend continue to accept
concrete Gate arrays. Admission freezes that array into Contract terms; later
settings edits never alter an existing Contract or its status.

Akuma owns the `providers` interpreter, its record grammar, defaults, and Soul
freeze in [akuma.md](akuma.md). Settings contributes only the resolved opaque
entry and its provenance.

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

The Settings module never names `gates`, `providers`, a provider kind, or any
other product concept. Product modules never read settings file paths. Those
two checks are the boundary sentinels.
