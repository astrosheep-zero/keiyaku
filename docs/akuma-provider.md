# Akuma Provider Boundary

This chapter owns the provider-neutral protocol and native adapter obligations.

## Provider boundary

```ts
type ProviderAdapter = {
  confinement(input: {
    cwd: string;
    options: ProviderOptions;
  }): Confinement;
  admitOptions(options: ProviderOptions): ProviderOptionAdmission;
  start(input: {
    prompt: string;
    cwd: string;
    options: ProviderOptions;
    session?: ResumeCoordinate;
    requests?: { dir: string };
  }): Promise<Drive>;
  fork?(input: {
    session: ResumeCoordinate;
    at: string;
    cwd: string;
  }): Promise<{ session: ResumeCoordinate }>;
};

type Drive = {
  events: AsyncIterable<AgentEvent>;
  completion: Promise<TurnResult>;
  abort: () => Promise<void>;
};
```

Provider observation is the closed public vocabulary:

```ts
type AgentEvent =
  | { type: "session"; coordinate: ResumeCoordinate }
  | { type: "assistant"; text: string }
  | { type: "thought"; text: string }
  | {
      type: "tool";
      id: string;
      phase: "started" | "completed";
      name: string;
      call: ToolCall;
      result?: ToolResult;
    }
  | { type: "note"; text: string }
  | { type: "unknown"; kind: string };

type ToolCall =
  | { kind: "run"; command: string }
  | { kind: "read"; path: string }
  | { kind: "search"; query: string }
  | {
      kind: "fileChange";
      changes: readonly {
        op: "add" | "update" | "delete";
        path: string;
        diffstat?: { added: number; removed: number };
      }[];
    }
  | { kind: "other"; display: string };

type ToolResult = {
  status: "ok" | "error";
  message?: string;
  exitCode?: number;
};
```

The provider boundary owns this vocabulary and its strict encode/decode pair. The body
encodes normalized events before handing opaque JSON to Heart; public activity
readers decode through the same owner before history or snapshot folding. Exhaustive
event-type switches make a union change fail typecheck until the codec changes
with it. Heart remains the opaque persistence owner and does not import provider
semantics.

Each native adapter separates process/session control from pure native-event
translation. The driver consumes the typed translation result and does not
reinterpret native event payloads.

`session` is authored when the native harness grants a resumable coordinate.
The pump records that coordinate immediately as
the heart's authoritative session fact and also appends the event as activity;
it never waits for turn completion. `assistant` contains a bounded completed
agent narration of at most 16,384 characters, never deltas or summaries. The
complete answer is stored separately in `TurnFact` and is never truncated.
`tool` preserves the provider's stable
tool id, the started/completed lifecycle, one provider-neutral call shape, and
the typed result disposition. A started event carries no result; a completed
event requires one. Result `message` is a bounded diagnostic, never stdout,
stderr, or a native result body. `thought` is one completed reasoning summary
or block bounded at 4,000 characters, never raw thinking text or a delta stream.
`note` is one bounded line for non-tool plan, todo, retry, warning, or refusal
narration. Every other persisted activity text field, including tool names,
calls, diagnostics, and unknown native names, is bounded at 16,384 characters.
The provider codec is the sole persistence-bound judge; session coordinates and
tool pairing ids are never truncated. `unknown` contains only the unmapped native kind or method name
and never carries the native payload.

Activity is persistent execution narration. Deleting retained activity changes
history and recent snapshots, but never recovery, resume, fork, outcome,
failure, or life. Complete answer bytes and fork coordinates remain
authoritative only in `TurnFact`; a session row remains the sole resume
authority.

Every adapter owns a total disposition of its native events. Known native
kinds are mapped or explicitly dropped, and every unrecognized kind becomes
`unknown`. Tool, command, and file-change lifecycle maps to `tool`; bounded
completed reasoning summaries map to `thought`; plan or todo updates and
retry, warning, and refusal map to `note`. A native completion
must provide the matching typed tool result. Partial and delta streams, input
echoes, tool-result bodies and command output streams, raw thinking and
reasoning deltas, and token, cost, and rate-limit telemetry are dropped. The Claude adapter's SDK
union disposition is compile-time exhaustive with a runtime unknown fallback.
The Codex app-server method set is open, so its explicit known dispositions end
in an unknown fallback. Tests pin both tables and both unknown paths.

Claude's terminal answer is exactly `result.result`. Codex joins all completed
`agentMessage` texts in order with one blank line. A failed Codex turn preserves
the native explanation from an `error` notification or `turn.error`, using a
generic status diagnostic only when no native detail exists.

File-change adapters preserve every available native operation, path, and
per-change diffstat. Missing optional facts make the public row shorter; an
adapter never invents a diffstat. Codex app-server derives diffstat only from a
native unified patch and preserves the native change operation. Claude derives
add/update from its named write/edit tool and omits diffstat when the SDK does
not provide one. A multi-file public summary prints an aggregate only when
every represented change supplies a diffstat. No terminal file ledger, event
bus, subscription fan-out, usage or cost arm, raw-provider passthrough,
severity taxonomy, or native output body belongs in this boundary.

An answered `TurnResult.historyId` is the provider-owned fork point, not a
generic result identifier. The Claude adapter uses the outer assistant message
UUID associated with the successful result; the result UUID is not a valid
substitute. Together with the session observed by the body, it forms the
answered turn's durable fork coordinate.

Provider execution and option admission are provider-owned validation at the
public boundary, before identity allocation. `start()` is their effect reader.
The execution crosses the detached process boundary in the soul; each native
session records the execution name and exact options. Tell, resume, recovery,
and fork reconstruct the adapter only from those durable facts. A rerouted Body
Request carries its already resolved recipe into the parent heart, so the body
does not reopen Settings to birth the child. A fork inherits its parent's
execution.

`executable` constrains each provider process start. Literal provider `env`
values overlay the ambient environment at every provider interaction whose
native boundary accepts an environment. The ambient environment remains
launch-local and is not a Settings scope or durable fact. Codex start and fork
both use the frozen execution. Claude start uses its frozen executable and env,
but the in-process SDK `forkSession` primitive accepts neither; a Claude
execution carrying env therefore refuses fork instead of silently consulting
the default native session world. Akuma loads no dotenv file and performs no
environment interpolation.

Alongside its adapter, each provider states its confinement for a
given call: declared writable roots, or `unconfined`. The soul records it;
nothing gates call admission on it. During a declared drive the adapter grants
the body-owned request transport as one additional writable root and injects
`AKUMA_REQUESTS`; an unconfined adapter never receives that input.

No `probe`, plugin registry, or registration schema exists. Provider instance
names are Settings data; built-in provider kinds remain a closed composition
used by the public boundary and detached body.
