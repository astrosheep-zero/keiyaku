# Pi-hosted Akuma PoC

An opt-in Pi extension. It is not registered in `package.json`, installed globally,
or used by the normal CLI. It uses public Pi APIs, not private runtime fields.

## Load

From this checkout, start a separate Pi session with:

```sh
pi --extension ./experiments/pi-inprocess/extension.ts
```

The launch tool is `akuma_call`:

```json
{
  "akuma": "your-pi-definition",
  "body": "Inspect the cancellation path without changing files.",
  "workdir": "/absolute/execution/directory"
}
```

`akuma` names an existing Keiyaku definition and must select a Pi provider.
`body` is required; `workdir` is optional and resolves relative to the host session
cwd. The tool returns `{"id":"aku/<name>/<suffix>"}` after durable birth and
first-input admission, without waiting for the model's answer. Birth is not proof
that model startup or the task succeeded; observe that ID for the outcome.

```text
Pi tool -> existing Keiyaku publication / first-Tell admission
        -> existing Body in the host process
        -> existing Pi provider -> independent SDK session
```

Heart, leash, Turn records, and native Pi session files remain real. There is no
Body or Pi subprocess for this launch. Task tools such as bash may still launch
their ordinary subprocesses. No process-global environment or cwd is changed.

The PoC deliberately retains the existing SQLite Tell/control transport. Another
process with the same World can use the existing CLI:

```sh
keiyaku -C /absolute/world tell aku/name/12345678 "Additional input"
keiyaku -C /absolute/world status aku/name/12345678
keiyaku -C /absolute/world history aku/name/12345678
keiyaku -C /absolute/world kill aku/name/12345678
```

Those are external clients, not commands invoked by the native tools. A running
Body observes the recorded Tell/control and uses the provider's native steering
or cancellation. Orderly host session shutdown stops and awaits owned Bodies.

## Native operations

All tools call Keiyaku library operations directly, never the CLI. They use the
World resolved from the Pi session cwd and return the native result as both text
and structured data, preserving refusals and partial outcomes.

| Tool                | Input                                                                | Meaning                                                      |
| ------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------ |
| `akuma_call`        | `akuma`, `body`, optional `workdir`                                  | In-process Pi birth and first input                          |
| `akuma_tell`        | `akuma`, `body`, optional `interrupt`, `repo`                        | Admission receipt, not answer observation                    |
| `akuma_ask`         | `akuma`, `body`, optional `interrupt`, `schema`, `timeoutMs`, `repo` | Observe the answer to this exact input                       |
| `akuma_wait`        | `akuma` array, optional `completion`, `timeoutMs`, `repo`            | Observe existing work; defaults to `any`, supports `all`     |
| `akuma_history`     | `akuma`, optional `id`, `last`, `before`, `since`, `limit`, `repo`   | Exact outcome, last answer or paged history                  |
| `akuma_fork`        | `akuma`, `at`, optional `repo`                                       | Standard detached prompt-free fork at an answered history ID |
| `akuma_kill`        | `akuma` array, optional `repo`                                       | Stop each selected Akuma, preserving history                 |
| `akuma_status`      | `akuma`, optional `repo`                                             | Current lifecycle, work and outcome                          |
| `akuma_list`        | optional `archetype`, `limit`                                        | Recent-activity instance roster                              |
| `akuma_definitions` | optional `limit`                                                     | Visible callable definition catalogue                        |

Single targets accept IDs and World-local aliases. Wait/kill also accept globs
and Contract selectors; the latter require an explicit Git `repo` coordinate.
`repo` resolves relative to session cwd, supplies association/selector context,
and does not change the selected World. `archetype` is a definition-name roster
filter. `id`/`at` are exact `turn/n` identities returned by history, not ordinal
turn numbers. `before`/`since` are positive durable sequence cursors. Exact
history `id` cannot combine with `last` or paging options.

Ask/wait are unbounded unless `timeoutMs` is supplied. A deadline or cancellation
ends observation without retracting input or killing workers. The operation's
AbortSignal reaches tell, ask, wait and kill; status/history/fork have no ongoing
cancellation API. An already submitted fork cannot be undone by cancellation.
Ask's optional `schema` is a JSON Schema object passed as a provider answer
contract. As in the CLI, answers are JSON-decoded, not validated against arbitrary
JSON Schema locally. Schema input to a running Akuma retains the owner's busy
refusal; `interrupt` follows the standard stop-and-wake path.

**Hosting boundary:** only `akuma_call` uses the in-process birth seam. Tell/ask
to an already running Body use its existing SQLite/native steering transport.
Tell/ask to an asleep target, interrupt wake, and fork use the normal detached
Keiyaku path. They are native library tools, not a promise of in-process wake or
fork. Detached Bodies are not owned or stopped by the Pi host shutdown hook.

## Verification

```sh
node node_modules/typescript/bin/tsc -p experiments/pi-inprocess/tsconfig.json
node --import tsx --test --test-timeout=45000 experiments/pi-inprocess/poc.test.ts
```

To exercise another installed Pi SDK without changing dependencies:

```sh
POC_PI_SDK_MODULE=file:///absolute/pi-package/dist/index.js \
  node --import tsx --test --test-timeout=45000 experiments/pi-inprocess/poc.test.ts
```

The test uses a deterministic offline **model transport**, with no credential
writes or model API calls. Pi sessions, model-to-tool execution, the bash tool,
Akuma admission, Body, SQLite custody, and external CLI processes are real. It
checks same-process SDK execution, separate sessions, execution cwd and child
identity, unchanged host environment, native status/list/definitions, live native
Tell and input-bound Ask alongside foreign Tell in that exact native session,
schema-busy refusal, wait deadlines and completion, paged/exact/last history,
unknown-history refusal, a real detached prompt-free fork, native plural kill,
isolated foreign kill, unsupported-provider refusal, and shutdown retirement.
A second check loads this file using Pi's real extension loader and verifies all
ten registrations. Pi 1.0.0 and the installed host SDK 1.3.0 have been exercised.
This does not claim a real-model end-to-end pass.

Pi's extension loader aliases the coding-agent SDK import to its host package;
plain Node imports instead use this checkout's dependency. The loader check is
therefore separate from the inline-factory SDK check.

## Deliberate limits

- Children start fresh, not from the host conversation. Child extensions are
  disabled so they cannot inherit host identity or recursively load this tool.
  Extension-defined/virtual models are therefore not promised; normal configured
  provider/auth discovery remains the SDK's responsibility. The parent's live
  `ModelRuntime` is not shared.
- A Body runs in this host only while it is owned here. Once asleep, a later native
  tool or CLI Tell uses the existing detached wake path. There is no host-routed wake, daemon,
  or recovery of this process's live objects after exit.
- Nested delegation and detached handoff explicitly fail in this experiment.
  Existing Alias/Dispatch composition is not added to this lower-owner entry.
- Orderly shutdown is checked; abrupt host death is not graceful retirement.
- Child usage is not rolled into the already-returned host tool result.
- This proves a hosting option, not production readiness or a full-suite pass.
