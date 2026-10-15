# Read-only Akuma mirrors

Two plugins form one bridge:

- Install `plugin/` as a Paseo directory-source plugin (`keiyaku-paseo`).
- Enable the bundled Keiyaku forwarder in the World's Settings:

```json
{ "plugins": { "paseo": { "package": "@astrosheep/keiyaku-plugin-paseo" } } }
```

A present `plugins` namespace is the explicit plugin set. Include a Square entry
as well if that observer should remain enabled.

Create a Paseo agent with provider `keiyaku`, a working directory, and these
opaque `providerOptions` (not model settings):

```json
{ "world": "/absolute/path/to/world", "akuId": "aku/archetype/id" }
```

The provider only executes `keiyaku -C <world> history <akuId> --json --limit 200`.
It strips inherited harness, Square and Keiyaku caller identities before reading.
It reopens the same identity on refresh/resume. Prompts and provider-side archive
are unsupported; interrupt and close end observation, never the Akuma.

Opening reads once. Turn-start, turn-outcome and Body-end signals send refresh
hints over one lazy authenticated local Paseo client. Body-end releases that
client. Only TCP daemon listeners are supported. A failed hop is a single host
plugin diagnostic, not a Keiyaku failure or a retry queue.

No polling repairs lost hints. A mirror remains stale until another hint or
Paseo refresh. Retention gaps and read failures appear as timeline notices;
read failure retains the previous mirror.

Tests use mocked reads/transports and a fake history executable. They do not
start a daemon, restart the user's Paseo, or call a model. Live experiments, if
explicitly requested, must use a temporary `PASEO_HOME` and an unused TCP port.
