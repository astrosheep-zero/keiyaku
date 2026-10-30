# Keiyaku in Pi

The existing Pi package entry `plugins/pi/keiyaku.ts` supplies `/keiyaku` (the
status overlay) and ten native Akuma tools. It imports only the supported
`@astrosheep/keiyaku` package root. Build the checkout before loading it locally;
an installed npm package already carries its built SDK.

```sh
# Existing installation path; no separate experimental package
keiyaku install pi
# One-invocation local development, after npm run build
pi --extension ./plugins/pi/keiyaku.ts
```

## Native tools

All tools return the SDK result in `details`, `structuredContent`, and JSON
text. Typed refusals and partial birth results remain data. An exceptional
failure retaining a born Akuma also retains its identity in structured error
data. No native tool shells out to the CLI.

| Tool | Parameters |
| --- | --- |
| `akuma_call` | `akuma` definition name, `body`; optional `workdir`, `writableDirectories`, `detach`, `bare`, `wait`, `timeoutMs`, `schema` |
| `akuma_status` | `akuma`; optional `repo` |
| `akuma_list` | optional `archetype`, `limit` |
| `akuma_definitions` | optional `limit` |
| `akuma_tell` | `akuma`, `body`; optional `interrupt`, `detach`, `repo` |
| `akuma_ask` | `akuma`, `body`; optional `interrupt`, `detach`, `schema`, `timeoutMs`, `repo` |
| `akuma_wait` | `akuma` array; optional `completion` (`any` or `all`), `timeoutMs`, `repo` |
| `akuma_history` | `akuma`; optional `id`, `last`, `before`, `since`, `limit`, `repo` |
| `akuma_fork` | `akuma`, `at`; optional `detach`, `bare`, `repo` |
| `akuma_kill` | `akuma` array; optional `repo` |

`akuma_call` supports every configured provider, not only Pi. Default
`detach: false` launches in the calling Pi session's in-process host scope.
Default `wait: false` returns after birth and first-input admission; these are
**independent choices**. `wait: true` observes the first answer for up to five
minutes by default. `timeoutMs` on call requires `wait: true`.
Call and Fork pass `bare` through to the SDK: it omits only Keiyaku runtime
instructions and remains frozen through wake and inherited by forks. Providers
without a verified runtime-instruction channel retain their explicit refusal
unless the caller opts out.

`writableDirectories` grants native tools access to additional existing canonical
absolute directories at birth (currently Codex only). It preserves the native
sandbox mode, network policy, and existing writable roots. Other providers
refuse nonempty grants. These are explicit filesystem grants, not product-action
permissions; nothing automatically exposes the repository or Home. Forks
inherit the frozen native recipe; there is no live elevation option.

```json
{"akuma":"worker","body":"Inspect the parser without changing files."}
{"akuma":"worker","body":"Run the checks.","detach":true,"wait":true,"timeoutMs":300000}
```

Tell, Ask and Fork explicitly select future launch hosting through their own
`detach` option, also defaulting to false. A running Body never moves hosts. A
sleeping Akuma can be woken in the current session even if another host created
it. Ordinary CLI defaults and `--wait` semantics are unchanged.

World resolves from Pi's `ctx.cwd`. Relative `workdir` and `repo` paths resolve
there too; `repo` supplies Git association/selector context, not a different
World. Caller attribution comes from the current Pi session manager, not ambient
parent Akuma or harness environment declarations. Single targets accept IDs or
World-local aliases; Wait/Kill also accept globs and Contract selectors (the
latter need `repo`). History `id` and Fork `at` are exact returned `turn/n`
identities. Exact history cannot combine with paging or `last`.

Ask/Wait are unbounded unless `timeoutMs` is supplied. Deadline or tool abort
ends observation, not admitted work. Optional `schema` supplies a provider JSON
answer contract; the result is JSON-decoded, not locally validated against
arbitrary JSON Schema. Schema input to busy work retains the SDK refusal.

## Lifetime and permissions

The extension owns one `AkumaHost.inProcess()` scope per Pi session. Orderly
`session_shutdown` closes only that scope's exact in-process launches, including
setup and automatic succession. It never kills by AkuId, so an older session
cannot stop a foreign host's later wake of the same identity. Detached work
survives. Reload and session replacement follow Pi's shutdown/start lifecycle.

The Pi provider supplies the public SDK extension flag
`keiyaku-request-only: true` to its own sessions. The extension reads that flag
at native tool execution, before World establishment or SDK operations, and
refuses local tools there (including nested tool calls). Those child Akumas use
the existing CLI in their tool environment, with authenticated direct-parent
routing and frozen permissions. There is no ambient identity guess or duplicate
permission evaluator. If the optional extension is absent, Pi collects an
unknown-option diagnostic without failing provider startup.

In-process hosting is shared lifetime, not a sandbox: arbitrary extensions can
block or terminate the runtime. A noncooperative tool/provider can remain
physically live after the Body records hung and releases its leash. Scope close
rejects with that exact launch's retained failure; it never reports physical
retirement based on a later Body's status. Abrupt host death has no graceful
cleanup guarantee, and no daemon or persisted host policy recovers live objects.
Child model usage is not rolled into an already-returned parent tool result.

## Verification

```sh
npm run build
npm test -- tests/akuma-in-process.test.ts tests/pi-akuma-tools.test.ts tests/pi-extension.test.ts tests/package-consumers.test.ts
```

The native-tool tests load the built package's actual extension with Pi's public
loader and execute a deterministic offline model through real Pi tool calls,
SDK operations, Heart/leash, subprocess tools and detached launches. They do not
replace the Body engine or depend on model credentials. These are not real-model
quality or OS sandbox tests.
