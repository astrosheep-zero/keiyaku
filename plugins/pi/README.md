# Keiyaku in Pi

The existing Pi package entry `plugins/pi/keiyaku.ts` registers the package's
MCP server for each Pi session, supplies `/keiyaku` (the Kanshi overlay), and
keeps a live status entry. The registered server publishes the shared Keiyaku
MCP tools with Pi's `codemode` exposure; no separate `mcp.json` entry or global
`keiyaku-mcp` binary is required. The extension registers no Pi model tools of
its own. It imports only the supported `@astrosheep/keiyaku` package root. Build
the checkout before loading it locally; an installed npm package already
carries its built SDK.

```sh
# Existing installation path; no separate experimental package
keiyaku install pi
# One-invocation local development, after npm run build
pi --extension ./plugins/pi/keiyaku.ts
```

## Status sampler

Interactive Pi sessions show a compact status entry with the current World's
running Akuma, active Contracts, and open Debts across all namespaces. A zero
is an observed empty count; `-` means absent and `?` means unknown or failed.
The entry refreshes after each completed read (five seconds later) and when the
agent settles. It starts with the session and is removed on shutdown or reload;
non-terminal modes do not run the sampler.

## `/keiyaku`

`/keiyaku` opens a centered, read-only overlay of `keiyaku kanshi` from `PATH`.
It is available only with an interactive UI; a failed read shows
`status unavailable`.

## MCP server

The extension registers a stdio server named `keiyaku` for the current session
and runs the built MCP entry with the running Node executable. The server
publishes the shared invocation facet's MCP tools, so tool inputs, results, and
refusals keep their ordinary MCP semantics. Pi's `/mcp` view and exposure
settings apply to the registered server.

## Lifetime

Loading the extension registers the MCP server and `/keiyaku` command. In a TUI
session it starts the status sampler on `session_start`, refreshes it after each
read and on `agent_settled`, and stops it on `session_shutdown` or reload.
Non-TUI modes run no sampler. Pi owns the MCP connection lifetime.

## Verification

```sh
npm run build
npm test -- tests/pi-extension.test.ts tests/pi-status.test.ts tests/mcp-adapter.test.ts tests/package-consumers.test.ts
```
