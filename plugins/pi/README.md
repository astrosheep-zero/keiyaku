# Keiyaku in Pi

The shipped Pi entry `plugins/pi/keiyaku.ts` registers native `keiyaku_*` tools
with `codemode` exposure, supplies `/keiyaku` (the Kanshi overlay), and keeps a
live status entry. It does not register a Keiyaku MCP server. No `mcp.json`
entry or global `keiyaku-mcp` binary is required.

The extension uses the supported package root for status and `@astrosheep/keiyaku/pi`
for tool registration. Build a checkout before loading it locally; installed
packages already carry both compiled entries.

```sh
keiyaku install pi
# One-invocation local development, after npm run build
pi --extension ./plugins/pi/keiyaku.ts
```

## Native tools through codemode

Every published Keiyaku model tool is registered once when the extension loads,
under the `keiyaku` namespace. Names prefix the shared catalogue with `keiyaku_`;
for example, `spawn` becomes `keiyaku_spawn` and `debt.add` becomes
`keiyaku_debt_add`. Inputs flatten coordinate and business fields into one
object. Descriptions, annotations, schemas and compact routing projections are
shared with the standalone MCP adapter, not maintained as another tool list.
Text uses the existing Keiyaku renderer. Business failures return `isError` with
failure data where available, rather than throwing away their evidence.

```js
const ns = await describeNamespace("keiyaku");
text(ns);
text(await tools.keiyaku_kanshi({}));
text(await tools.keiyaku_spawn({akumaName: "intern", prompt: "Inspect the tests"}));
```

At `session_start` the extension activates a registered `codemode` tool that
declares `reachesTools`. The normal Pi CLI includes codemode. SDK hosts must
load `createCodemodeExtension()` themselves. If it is missing, the extension
warns once; it never makes Keiyaku tools directly exposed as a fallback.

Each call uses the current context's working directory and session ID. Complete
Akuma actor declarations take precedence; otherwise the invoking Pi session is
the explicit caller, ignoring inherited native host IDs. Partial actor
declarations still refuse. Caller attribution does not rewrite the independently
selected notification initiator. Neither settings nor process environment is
modified by the adapter.

## Status and `/keiyaku`

Interactive Pi sessions show counts for running Akumas, active Contracts, and
open Debts across all namespaces. `0` is observed empty, `-` is absent, and `?`
is unknown or failed. The sampler refreshes five seconds after each read and on
`agent_settled`; shutdown or reload removes it. Non-TUI modes run no sampler.

`/keiyaku` opens a centered, read-only overlay of `keiyaku kanshi` from `PATH`.
A failed read shows `status unavailable`. Native model tools do not invoke the
CLI or a stdio server.

## Lifetime

Workers use ordinary detached execution, with no per-session Akuma host.
Cancelling a tool observation or closing Pi does not kill admitted work. Spawn
and tell return admission; wait observes existing work and ask observes its
exact structured answer. There is no MCP request timeout around native calls.

## Verification

```sh
npm run build
npm test -- tests/pi-keiyaku-tools.test.ts tests/keiyaku-caller.test.ts tests/pi-extension.test.ts tests/pi-status.test.ts tests/mcp-adapter.test.ts tests/package-consumers.test.ts
```

The native integration tests load the shipped entry with the real Pi SDK loader,
run actual QuickJS codemode scripts against an offline synthetic model, and
launch a real detached ACP fixture. They compare MCP declarations and read
results, exercise attribution, and retain worker lifetime across observation
cancellation and session shutdown.
