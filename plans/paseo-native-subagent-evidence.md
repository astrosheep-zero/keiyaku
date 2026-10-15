# Paseo native subagent feasibility evidence

## Scope and evidence levels

Read-only feasibility research for `kei/paseo-parent-session-native-b486`.
Sections 1-7 record the earlier read-only research phase, when only this evidence
document changed. Implementation was subsequently authorized under the amended
Contract; section 8 records that phase. No installation, dependency changes,
or user Paseo daemon operations were performed.
Paseo source below is `/Users/astrosheep/Developer/paseo`, HEAD `e8108d909`;
installed `@getpaseo/server` is `0.11.2`. Source references are not live UI proof.
The newer native-provider-ID proposal is investigated in section 6; no design
choice or Contract change is implied by these findings. Section 7 supersedes the
old Claude environment caveat with direct evidence from native Claude 2.1.299;
`Developer/claude-code` is a third-party mirror, not current-version authority.

- Observed: native Claude Bash execution through the real Paseo adapter and SDK
  exports the current native session ID, including resume and fork/resume (section 7).
- Observed: real Codex `0.160.1` and Pi `1.2.0` subprocesses execute ordinary,
  prompt-free Keiyaku calls and preserve the injected external caller in birth.
- Source-traced: daemon session-open injection, native child placement,
  completed-creation replay, and app selection/navigation.
- Not observed: a real daemon-created parent, model-driven shell tool calls,
  authenticated live attach RPC, or visible UI rendering. No model was called or
  substituted. The native-shell probes invoke the registered plugin hook in a
  harness; they are not two live daemon/provider E2E variants.

## 1. Environment propagation and observed births

Historical pre-implementation baseline: plugin `plugins/paseo/plugin/index.server.ts:11` supplied
`KEIYAKU_EXTERNAL_CALLER=paseo:<request.agentId>` in `agent.session_open`.
Actual Paseo paths differ:

- `packages/server/src/server/agent/agent-manager.ts:5329-5360` awaits the hook,
  uses its returned env, and adds `PASEO_AGENT_ID`/`PASEO_AGENT_CWD`.
- Codex: `providers/codex-app-server-agent.ts:7268-7283` builds the app-server env
  from launch context; `:7226-7249` supplies it to `spawnProcess` as `baseEnv`.
  `agent/provider-launch-config.ts:218-253` and `server/paseo-env.ts:20-34`
  preserve this variable while sanitizing unrelated runtime/Claude controls.
- Pi: `providers/pi/agent.ts:2523-2531` passes launch-context env into runtime;
  `pi/runtime.ts:98-103` merges runtime and session env; `pi/cli-runtime.ts:54-68`
  merges that with process env and launches the real JSONL RPC process.
  Installed Pi's `dist/core/tools/bash.js:63-66,132-143` uses local shell env;
  `dist/utils/shell.js:115-125` preserves `process.env`. These latter paths are
  under `~/.pi/agent/install/releases/1.2.0/node_modules/@earendil-works/pi-coding-agent`.
- Keiyaku `src/cli/akuma-caller.ts:5-22` decodes the external coordinate only
  without the higher-priority complete Akuma actor pair. The probe explicitly
  removes its enclosing Akuma/request identities, rather than forwarding into it.

These probes concern the explicitly injected `KEIYAKU_EXTERNAL_CALLER`, not
native harness-ID auto-injection. In particular Codex `command/exec` is outside
a thread: it proves nothing about `CODEX_THREAD_ID` in model-driven thread tools.

Observed native-shell results (both exit 0):

| Native route, no LLM | Shell caller | Born Akuma |
| --- | --- | --- |
| Codex `command/exec` | `paseo:probe-codex-parent` | `aku/worker/545f568b` |
| Pi RPC `bash` | `paseo:probe-pi-parent` | `aku/worker/34cb8161` |

Both calls returned `kind: called`, `observation.kind: born`. The recording
observer received exactly these caller payloads:

```json
[
  {"kind":"akuma.born","akumaId":"aku/worker/545f568b","bodySequence":1,"origin":{"kind":"direct"},"caller":{"kind":"external","integration":"paseo","id":"probe-codex-parent"}},
  {"kind":"akuma.born","akumaId":"aku/worker/34cb8161","bodySequence":1,"origin":{"kind":"direct"},"caller":{"kind":"external","integration":"paseo","id":"probe-pi-parent"}}
]
```

Separate `Akuma.status()` reads returned those same frozen birth callers, both
`life: asleep`. A zero-timeout public glob wait returned both status observations
and `unobserved: []`. These prompt-free fixtures had no outcome to observe;
**this does not establish that status or wait is a side-effect-free read**.

### Reproducible native-shell probe

Run the following as an `.mts` file with `node --import tsx <file>` from this
worktree. The exact source used is retained below, not solely in `/tmp`.
It creates only temporary homes/Worlds, loads no user Pi resources, and makes no
model request. The worker recipe is a controlled prompt-free fixture, not a
substitute real worker/model execution. Paths reflect the machine measured.

```ts
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import pino from '/Users/astrosheep/Developer/paseo/node_modules/pino/pino.js';
import { buildCodexAppServerEnv } from '/Users/astrosheep/Developer/paseo/packages/server/src/server/agent/providers/codex-app-server-agent.ts';
import { CodexAppServerClient } from '/Users/astrosheep/Developer/paseo/packages/server/src/server/agent/providers/codex/app-server-transport.ts';
import { PiCliRuntime } from '/Users/astrosheep/Developer/paseo/packages/server/src/server/agent/providers/pi/cli-runtime.ts';
import contribute from '/Users/astrosheep/Developer/keiyaku-v4/.keiyaku/wt/devnull/plugins/paseo/plugin/index.server.ts';

const root = await mkdtemp('/tmp/paseo-b486-native-shell-');
console.log(JSON.stringify({ root, scope: 'Real native non-model shell RPCs, NOT model-driven or daemon/UI E2E' }));
const home = join(root, 'home'), world = join(root, 'world'), bin = join(root, 'bin');
for (const path of [home, world, bin, join(world,'.keiyaku'), join(world,'plugins'), join(home,'akuma'), join(home,'pi'), join(home,'codex')]) await mkdir(path, {recursive:true});
const worktree = '/Users/astrosheep/Developer/keiyaku-v4/.keiyaku/wt/devnull';
const tsx = '/Users/astrosheep/Developer/keiyaku-v4/node_modules/tsx/dist/loader.mjs';
await writeFile(join(bin,'keiyaku'), `#!/bin/sh\nexec '${process.execPath}' --import '${tsx}' '${worktree}/src/cli/index.ts' "$@"\n`, {mode:0o755});
await writeFile(join(home,'akuma','worker.md'), '---\nprovider: fixture\n---\nPrompt-free probe.\n');
await writeFile(join(world,'plugins','record.mjs'), `import {appendFileSync} from 'node:fs'; export default {manifest:{id:'record',apiVersion:1}, activate(context){return {signals:{'akuma.born':event => appendFileSync(context.config.output, JSON.stringify(event)+'\\n')}}}};`);
await writeFile(join(world,'.keiyaku','settings.json'), JSON.stringify({plugins:{record:{package:'./plugins/record.mjs',config:{output:join(root,'births.jsonl')}}}, providers:{fixture:{kind:'acp',executable:process.execPath,config:{argvBefore:[],argvAfter:[],modelArg:'--model',effortArg:'--effort',systemPromptArg:'--system-prompt',systemPromptMode:'append'}}}}));
// Do not route a probe into this researcher's enclosing Akuma or load user resources.
for (const key of Object.keys(process.env)) if (/^(KEIYAKU_|AKUMA_|SQUARE_|PI_|PASEO_|CODEX_)/u.test(key)) delete process.env[key];
Object.assign(process.env, { HOME:home, KEIYAKU_HOME:home, PI_CODING_AGENT_DIR:join(home,'pi'), CODEX_HOME:join(home,'codex'), PASEO_HOME:join(home,'paseo'), PATH:`${bin}:${process.env.PATH}`, XDG_CONFIG_HOME:join(home,'xdg') });
const logger = pino({level:'silent'});
let hook:any;
const closePlugin = contribute({ registerProvider(){}, handle(){}, before(name:any, fn:any){ if(name==='agent.session_open')hook=fn; return ()=>{}; } } as any);
const command = `printf 'CALLER=%s\\n' "$KEIYAKU_EXTERNAL_CALLER"; keiyaku -C '${world}' call worker --json`;
async function environment(provider:string) {
 const request = {agentId:`probe-${provider}-parent`,workspaceId:null,provider,cwd:world,reason:'create',purpose:'interactive',env:{}};
 const transformed = await hook({request},{signal:new AbortController().signal});
 return {...transformed.env,PASEO_AGENT_ID:request.agentId,PASEO_AGENT_CWD:world};
}
const codexEnv = buildCodexAppServerEnv(undefined, await environment('codex'));
const codexChild = spawn('/opt/homebrew/bin/codex',['app-server'],{cwd:world,env:codexEnv,stdio:['pipe','pipe','pipe']});
const codex = new CodexAppServerClient(codexChild,logger);
try {
 await codex.request('initialize',{clientInfo:{name:'b486_research',version:'1'},capabilities:{experimentalApi:true}},10000);
 codex.notify('initialized');
 const result:any = await codex.request('command/exec',{command:['/bin/sh','-c',command],cwd:world,timeoutMs:20000,sandboxPolicy:{type:'dangerFullAccess'}},25000);
 console.log(JSON.stringify({provider:'codex',method:'command/exec',result}));
 await writeFile(join(root,'codex-result.json'), JSON.stringify(result,null,2));
} finally { await codex.dispose(); }
const runtime = new PiCliRuntime({logger,command:['/Users/astrosheep/.pi/agent/bin/pi']});
const pi = await runtime.startSession({cwd:world,env:await environment('pi'),noSession:true,extraArgs:['--no-extensions','--no-skills','--no-prompt-templates','--no-themes']});
try {
 const result:any = await pi.request({type:'bash',command},25000);
 console.log(JSON.stringify({provider:'pi',method:'bash',result}));
 await writeFile(join(root,'pi-result.json'),JSON.stringify(result,null,2));
} finally { await pi.close(); await closePlugin(); }
const births = (await readFile(join(root,'births.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
console.log(JSON.stringify({births}));
assert.deepEqual(births.map(b=>b.caller),['codex','pi'].map(provider=>({kind:'external',integration:'paseo',id:`probe-${provider}-parent`})));
console.log('PASS: two real native shell subprocesses -> ordinary prompt-free keiyaku call -> durable births with exact injected external caller');
```

To repeat the persistence observation, use this separate process, supplying the
printed probe root. This is deliberately labeled an **observing** public read:

```ts
import { Akuma, Akumas, World } from './src/index.ts';
const root = process.argv[2]!;
process.env.KEIYAKU_HOME = `${root}/home`;
const world = await World.at(`${root}/world`); // Probe marker already exists.
const akumas = Akumas.of(world);
const roster = await akumas.list({limit:500});
console.log(await Promise.all(roster.rows.filter(r=>'archetype' in r)
  .map(r=>Akuma.select(world,r.id).status())));
console.log(await akumas.wait({akuma:['aku/*/*'],completion:'all',timeoutMs:0}));
```

The original process transcripts remain additionally at
`/tmp/paseo-b486-research.i4CfDY/{probe.log,observe.log}`. The observed fixture root
was `/tmp/paseo-b486-native-shell-FLKThc`; neither is a required durable artifact.

## 2. Public birth reads: no observer-free surface found

Correction to the initial recovery sketch: `Akuma.status()` is not a pure read.

- `src/akuma/akuma-instance.ts:71-76,166-168` uses `owner(true)` and installs
  `outcomePluginObserver`.
- `src/akuma/akuma-owner.ts:198-201` calls `observeStatusOutcome` after projection.
  `src/akuma/akuma-observe.ts:110-114` observes an outcome selected by the snapshot;
  `src/plugin/akuma-signals.ts:35-55` can emit `akuma.outcome-observed` through
  selected plugins. Plugin observers can have external effects.
- `Akumas.status()` does the same (`src/library/selection.ts:416-432`).
  `Akuma.idle`, history, and `Akumas.wait`, including zero-timeout glob wait,
  also participate in outcome observation (`selection.ts:471-489`). A diagnostic
  callback changes reporting, not observation semantics.
- `Akumas.list()` is non-observing but its rows do not carry birth/caller
  (`src/akuma/akuma.ts:23-47`). Default 50, maximum 500, `hasMore`, no cursor.
  Complete glob expansion uses the internal complete-roster helper, but the
  public wait still observes outcomes.
- Package root and `./plugin` exports provide no Soul reader, birth-only getter,
  or observer-off option. `projectAkumaBirth` and an unobserving `AkumaOwner`
  exist internally, not as an exported package API. Existing `akuma.born`
  carries caller but is an ephemeral signal, not a recovery read.

**No existing public observer-free durable birth read was found.** A recovery
flow requiring that property cannot currently be assembled from public reads.
This is a limitation, not authorization to add an interface, disable plugins,
or import private Heart files. Existing mirror history reads also use the public
observing `history` path; read-only mirror means no work control, not universally
zero plugin-observation effects.

## 3. Idempotent replay preserves detach/archive

Source trace, not a live daemon replay test:

1. Client `packages/client/src/index.ts:527-545` maps `parent` to `callerAgentId`.
   `daemon-client.ts:2886-2893` returns the Creation result. Server
   `session.ts:3996-4027` submits the same request/key to `CreationService`.
2. `server/creation/index.ts:65-86`: fingerprint conflict refuses; an active
   duplicate joins; a completed record calls `validateCompleted` and immediately
   returns its retained snapshot. It does **not** enter `claimResources` or `run`.
   `outcomeUnknown` also returns without another create attempt.
3. The real validator is `server/websocket-server.ts:598-615,683-688`. For an
   agent creation it only checks that the agent exists live or in storage.
   It does not restore labels, unarchive, resume, or recreate an agent. Missing
   agents refuse with `Previously created agent no longer exists`.
4. Detach removes `paseo.parent-agent-id` via
   `agent/agent-manager.ts:711-717,2173-2212`. Archive persists `archivedAt` and
   closes/discards the live runtime (`:1828-1874,1952-1965`). Those stored records
   still satisfy the completed-creation existence check.

Therefore, with the original completed receipt and identical request,
**replay neither reattaches a detached child nor resurrects an archived child**.
The retained creation snapshot can still contain original labels/archive state;
it is not a fresh proof of current visibility. Existing attach returns
`{attached:true}` after create acknowledgement, even for such completed replay.
Do not interpret that boolean as proof that the child is currently in the track.

Boundary: a missing/purged receipt is not a protected completed replay; a changed
request fingerprint refuses; an unknown partial outcome is not auto-retried.
No guarantee is inferred across deliberate deletion of Paseo's receipt storage.

## 4. Manual replay of existing attach RPC

The RPC already accepts `{world, akuId, caller}` and canonicalizes World before
using the same creation key (`plugins/paseo/plugin/server/attach.ts:10-18`).
An authenticated caller can replay that exact payload without a new bridge API.
Caller attribution is supplied data, not an authorization/provenance proof.

Public-surface distinction: root `createPaseoClient()` / `PaseoApi` has **no**
plugin-RPC operation (`packages/client/src/index.ts:489-518`). The package does
export `@getpaseo/client/internal/daemon-client`, whose `invokePluginRpc` is the
existing forwarder's transport (`daemon-client.ts:5673-5686`). This is an
exported **internal** client surface, not a new high-level public client method.
A plugin client context also has public `rpc(contract,input)`, but needs its
existing hosted plugin context, not an ordinary standalone root client.

Minimal standalone example below uses the same exported internal client. Save
as `replay.mts` in this worktree and run with `node --import tsx replay.mts
<isolated-paseo-home> <world> <akuId> <caller-json-file>`. Prerequisites: a
separately prepared isolated TCP daemon with this plugin and mirror provider
available, a real parent, and a previously retained birth caller JSON object.
It never starts/restarts/enables a daemon and deliberately refuses non-temporary
homes. **Not executed against any daemon in this research.**

```ts
import { readFile, realpath } from 'node:fs/promises';
import WebSocket from 'ws';
import { DaemonClient, type WebSocketLike } from '@getpaseo/client/internal/daemon-client';
import { waitForDaemonReady, readLocalCredentialForTarget } from '@getpaseo/server/daemon-control';
import { buildDaemonWebSocketUrl } from '@getpaseo/protocol/daemon-endpoints';
import { attachRpc } from './plugins/paseo/plugin/shared/attach-rpc.ts';
const [homeArg, worldArg, akuId, callerFile] = process.argv.slice(2);
if (!homeArg || !worldArg || !akuId || !callerFile) throw new Error('four arguments required');
const home = await realpath(homeArg);
if (!home.startsWith('/private/tmp/paseo-') && !home.startsWith('/tmp/paseo-'))
  throw new Error('isolated /tmp/paseo-* home required; no user daemon');
const { listen } = await waitForDaemonReady(home, {timeoutMs:1000});
if (/^(unix|pipe):\/\//u.test(listen)) throw new Error('TCP daemon required');
const token = readLocalCredentialForTarget(home, listen);
const client = new DaemonClient({
  url:buildDaemonWebSocketUrl(listen,{useTls:false}),
  clientId:'keiyaku-manual-attach-probe', clientType:'cli',
  localCredential:()=>token ?? undefined, connectTimeoutMs:1000,
  reconnect:{enabled:false},
  webSocketFactory:(url,cfg)=>new WebSocket(url,cfg?.protocols,{headers:cfg?.headers}) as unknown as WebSocketLike,
});
try {
  await client.connect();
  const caller = JSON.parse(await readFile(callerFile,'utf8'));
  const input = attachRpc.input.parse({world:await realpath(worldArg),akuId,caller});
  console.log(attachRpc.output.parse(await client.invokePluginRpc('keiyaku-paseo','attach',input)));
} finally { await client.close(); }
```

If "public client" means root `PaseoApi` only, standalone manual plugin-RPC replay
is **not available on that surface**. No interface was added to conceal this.
The example receives a retained caller; it does not pretend to recover one via
a public observer-free read. A first successful attachment creates a native
mirror whose existing history reader can itself perform outcome observation.

## 5. Native UI child-selection chain

The label is the native managed-subagent path, not a plugin panel or a
provider-owned subagent descriptor:

1. Attach's `parent=A` becomes `callerAgentId=A` via client conversion above.
   `server/session.ts:4400-4446` resolves caller placement through
   `agent/create-agent/intent.ts:29-45`, setting
   `PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id"` to A and inheriting its
   workspace. No second worker/model session is requested by the mirror provider.
2. Agent snapshots carry labels (`agent/agent-projections.ts:250-252,272-276`).
   App directory sync fetches all active-agent pages, includes background
   workspaces where supported, and subscribes to deltas
   (`app/src/runtime/directory-sync/index.ts:626-667`).
3. `app/src/utils/agent-snapshots.ts:91-138` derives `parentAgentId` using
   `protocol/src/agent-labels.ts:16-20`. Directory projection normalizes snapshots
   into `session.agents` (`runtime/directory-sync/internal/agent-store.ts:75-105`).
4. `app/src/subagents/select.ts:70-98` selects precisely agents whose
   `parentAgentId === A`, excluding archived/pending-archive agents. It has no
   provider whitelist: a `keiyaku` agent qualifies. It produces `kind: "paseo"`
   rows. The `providerSubagents` feature gate applies to the separate
   provider-owned rows, not these managed children.
5. Parent panel `panels/agent-panel.tsx:1156` calls
   `useSubagentsForParent({serverId,parentAgentId:agentId})`; `agent-tracks.tsx:130`
   renders `SubagentsTrack`. `subagents/track.tsx:193-200` routes a managed row to
   `onOpenSubagent(row.id)`. `agent-tracks.tsx:62-85` opens the normal agent pane
   or navigation target, not the provider-subagent panel.

**Source-backed conclusion:** an active synchronized mirror with that parent
label belongs in A's native subagents track. Detached children lose the label;
archived children are excluded. This is not an observed rendered-screen result.

## Recovery feasibility boundary (no policy selected)

A later existing hint supplies exact World/Akuma coordinates; existing lifecycle
hooks and paginated Paseo agent listing can also provide bounded event-driven
opportunities. Existing attach and completed-creation idempotency avoid a new
attachment registry. However:

- retrieving a lost caller through current public birth-bearing reads can emit
  outcome observation; there is no observer-free public recovery reader;
- a parent's cwd does not identify arbitrary Worlds selected with `keiyaku -C`;
- lifecycle repair has no guarantee without a later event; an ordinary bounded
  Akuma list cannot promise exhaustive coverage;
- completed replay preserves user detach/archive and therefore does not promise
  visible reattachment, even when attach returns true.

These are technical limits for holder policy/amendment, not implemented choices.

## 6. Native provider ID -> Paseo agent mapping (new proposal)

### Result and public API proof

Paseo does retain native IDs and expose them through public agent snapshots for
all three providers once known. A bridge can enumerate public snapshots and
compare them. **There is no public unique native-ID reverse-lookup operation,
no proven one-to-one constraint, and no permanent old-ID alias history.** This
establishes a query ingredient, not a complete replacement for Paseo-ID injection.

The complete exposure chain, rather than an inference from private persistence:

- Public `AgentPersistenceHandle` has `provider`, `sessionId`, optional
  `nativeHandle` and metadata (`packages/protocol/src/agent-types.ts:171-177`).
  The actual wire `AgentSnapshotPayloadSchema.persistence` retains these fields
  (`protocol/src/messages.ts:790-797,812-834`). `runtimeInfo.sessionId` is also
  public but optional/nullable; it is not a stronger unique mapping authority.
- Actual live/stored projection preserves ID fields: `server/agent/agent-projections.ts:139,199-245,347-379`.
  Wire sanitization removes MCP configuration from metadata, not `sessionId` or
  `nativeHandle`.
- Actual fetch-agents handler uses full snapshots, not the compact list-item
  helper: `server/session.ts:5450-5536,6186-6228`. Wire list entries contain
  `agent: AgentSnapshotPayloadSchema` (`protocol/src/messages.ts:4158-4185`).
- Public plugin `context.paseo.agents.list()` delegates unchanged to
  `fetchAgents` (`packages/client/src/index.ts:675-694`); entries expose
  `entry.agent.persistence`. `agents.ref(paseoId).refresh()` returns the full
  fetched snapshot (`client/src/index.ts:940-944`;
  `protocol/src/messages.ts:4599-4607`), including `result.agent.persistence`.
  The `ref` input is a **Paseo ID**, not a native-ID resolver.
- Public list filters (`protocol/src/messages.ts:908-919,1241-1269`) have no
  native session/thread/handle filter. Enumeration is cursor-paginated, maximum
  200 per page. Background and archived records need explicit inclusion;
  `scope: active` further narrows discovery and should not be mistaken for all
  retained identities. Provider visibility, internal-agent hiding, and
  unavailable-provider filtering still apply (`server/agent/directory.ts:20-65`).
  For stored unavailable providers, persistence can be projected as null.

Non-mutating candidate enumeration using an existing public Paseo API context
(narrowed to the subsequently authorized exact session-ID rule):

```ts
async function nativeCandidates(paseo, provider, nativeId) {
  const matches = [];
  let cursor;
  do {
    const page = await paseo.agents.list({
      includeBackground:true, filter:{includeArchived:true},
      page:{limit:200,...(cursor ? {cursor} : {})},
    });
    for (const {agent} of page.entries) {
      const handle = agent.persistence;
      if (handle?.provider === provider && handle.sessionId === nativeId)
        matches.push(agent);
    }
    if (!page.pageInfo.hasMore) break;
    cursor = page.pageInfo.nextCursor;
    if (!cursor) throw new Error('incomplete directory page');
  } while (cursor);
  return matches; // Zero/one/many: no arbitrary parent selection policy here.
}
```

This snippet was not run against a daemon. It cannot promise an atomic directory
snapshot while identities change, discover hidden agents, or make duplicates
unique. An exact `ref(...).refresh()` can recheck a candidate but is not a lock.

### Per-provider meaning, availability, recovery and fork

| Provider | Value publicly exposed after native admission | Earliest availability / normal recovery |
| --- | --- | --- |
| Codex | `sessionId` is the native thread ID; a full provider persistence handle also puts it in `nativeHandle` and metadata `threadId` | Normal manager registration eagerly ensures a thread through `getRuntimeInfo`, before publication; session-open itself is earlier. Resume starts from the retained thread ID. |
| Pi | `persistence.sessionId` is Pi session UUID; `nativeHandle` is its session-file path, not that UUID | Paseo awaits real `get_state` before registering a newly created session. Resume requires the file handle and reads current state again. |
| Claude | `persistence.sessionId` and `nativeHandle` both equal the root Claude session ID | Fresh adapter starts with no ID. SDK messages/init establish it. Resume initializes from the retained session ID. |

Codex evidence:

- `providers/codex-app-server-agent.ts:4913-4937` implements that full provider
  persistence projection. Resume sets `currentThreadId` from handle in the
  constructor (`:3571-3574`). The provider factory itself connects without a
  thread (`:7255-7286`, `:3617-3677`), **but normal Paseo manager registration
  subsequently awaits `getRuntimeInfo` before persisting/publishing**
  (`agent-manager.ts:3629-3636`). Codex `getRuntimeInfo` calls `ensureThread`
  (`codex-app-server-agent.ts:4576-4595`), so a normal successful created-agent
  response already has a native thread ID; it need not await the first prompt.
  `ensureThread` reads actual `thread/start` (`:5283-5310`). `session_open` runs
  earlier and has no native ID field. Manager runtime-info refresh can swallow
  a native failure (`agent-manager.ts:4070-4094`), so null still remains valid.
  Its fallback persistence contains sessionId only (`:4082-4086`); nativeHandle
  is optional until a full provider handle is captured. Native `thread/started`
  also updates/emits the ID (`codex-app-server-agent.ts:6098-6107`).
- Rewind is implemented by native thread fork (and sometimes rollback), not a
  forever-stable thread ID: `providers/codex/rewind.ts:99-129` calls
  `setThreadId(forked/rolledBack.thread.id)`; adapter `:4959-4966` updates the same
  Paseo runtime. The old native ID is not retained as a public alias of this
  Paseo agent. A native fork separately imported into Paseo is another mapping.
- No `CODEX_THREAD_ID` injection/adaptation was found in Paseo's provider launch
  code. The earlier out-of-thread `command/exec` probe is explicitly **not**
  evidence of that variable in native thread tools. Host-side tool-shell source
  proof remains with the holder's investigation.

Pi evidence:

- `providers/pi/agent.ts:1475-1486` maps state UUID/file into persistence;
  `:2523-2547` awaits `runtimeSession.getState()` before constructing the session.
  `pi/cli-runtime.ts:161` uses real `get_state`; installed Pi 1.2.0
  `dist/modes/rpc/rpc-mode.js:345-356` returns `session.sessionId` and
  `session.sessionFile`. This is a session UUID mapping, not file-path guessing.
- `pi/agent.ts:2556-2623` requires `handle.nativeHandle` for resume, starts with
  that file, and adopts fresh runtime state. Missing UUID and missing file handle
  are different failure cases; a UUID alone is not the provider's resume input.
- Paseo's Pi rewind uses captured-entry tree navigation, not a native session
  fork (`:1556-1584`, `pi/rewind.ts`). State is refreshed via `get_state`
  (`:2477-2478`, also prompt completion at `:1700-1712`). No source evidence was
  found guaranteeing synchronous public mapping refresh before the next shell
  command after arbitrary native `/fork` or session-switch operations. Do not
  infer it from the normal resume path.
- Paseo launches Pi with runtime/session env but adds no `PI_SESSION_ID`
  injector or `bashSpawnHook`/`exposeSessionEnvironment` override. Its generated
  `session_start` extension captures timeline/tree entries
  (`pi/agent.ts:715-717`), not shell env. The holder's Pi-core bash-env finding
  supplies the native-ID emission side; Paseo does not replace that mechanism.

Claude evidence:

- `providers/claude/agent.ts:2245-2257` initializes from a resume handle or null;
  `:2782-2797` exposes the actual ID in persistence. Fresh create constructs the
  adapter without starting an SDK query (`:1548-1565`). Native SDK message/init
  capture accepts `session_id`/`sessionId` and emits thread-start evidence when
  first known or changed (`:4740-4822`).
- Resume binds `options.resume` to that ID (`:3438-3443,3494-3496`). Rewind calls
  SDK `forkSession` and rebinds to the resulting session ID
  (`claude/rewind.ts:13-28`; `claude/agent.ts:3087-3115`), retaining the Paseo
  agent while replacing its native ID. Fresh-conversation handling also creates
  a new UUID (`:3118-3133`). Old IDs are not preserved as public lookup aliases.
- Existing Paseo SDK adaptation does **not** install a SessionStart callback to
  export `CLAUDE_CODE_SESSION_ID`, `CLAUDE_ENV_FILE`, or another native-ID env.
  Its env builder adds `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`
  (`:3403-3412`); SDK hooks are PreToolUse/PostToolUse/SubagentStop effort
  observation only (`:3483`, `:5032-5052`). `claude/query.ts:58-116` customizes
  spawn/env but does not perform a native-ID handshake.
- Interactive Claude loads user/project/local settings (`claude/agent.ts:153-157,3463`),
  so independently configured shell hooks may exist. That is not a shipped
  Paseo identity adapter or verified SDK `CLAUDE_ENV_FILE` behavior. Internal
  helpers disable hooks (`:3513-3523`). Provider options are strict and do not
  offer a hooks/SessionStart setting (`claude/options.ts:46-89`). The standalone
  `mergeClaudeHooks` helper and its SessionStart unit-test fixture do not prove a
  production SessionStart ID-export path. **This does not mean native Claude
  lacks its own ID export:** section 7 directly verifies that 2.1.299 supplies
  `CLAUDE_CODE_SESSION_ID` without any such hook. The earlier ordinary-environment
  caveat based on the third-party source mirror is superseded.

### Uniqueness and timing limits common to all three

Paseo ID is not a native-ID unique key:

- `server/agent/agent-storage.ts:129-140` explicitly returns an **array** of
  records matching `(provider, sessionId OR nativeHandle)`; storage's unique
  execution index concerns daemon-owned execution, not provider session IDs.
- Normal import tries to reject an already-active match and reuse an archived
  one (`agent/import-sessions.ts:207-234`), but this is an import-path guard,
  not a storage/API one-to-one invariant.
- A concrete other source path: `session.ts:3370-3400` selects the newest matching
  record for unarchive metadata; `:4484-4494` then calls
  `resumeAgentFromPersistence(handle, overrides)` without its optional Paseo ID.
  `agent-manager.ts:1339-1363` generates a fresh Paseo ID when that argument is
  absent. There is no native-ID uniqueness admission in that registration path.
  `registerSession` checks only collision of the chosen Paseo ID
  (`agent-manager.ts:3575-3581`), not collision of native session IDs. This is
  source evidence of possible multiple managed mappings, not a live
  duplicate-session experiment. Selecting newest is existing resume behavior,
  not authority to apply that policy to bridge attribution.
- The manager initially records whatever `describePersistence()` currently
  knows (`agent-manager.ts:3778-3782`); `thread_started` refreshes current
  persistence (`:4424-4426,4507-4521`), and turn finalization refreshes it again
  (`:2733-2740`). Disk persistence from agent-state events is asynchronous
  (`server/persistence-hooks.ts:44-60`). There is no atomic transaction between
  a shell's external call and a paginated public reverse lookup.

A native ID received late after fork/reset can consequently be absent from the
current snapshot, while a resumed ID can match multiple Paseo records. Provider
and daemon/home scope must accompany an ID; an unqualified UUID is not a global
Paseo address. Native provider-owned subagent `agent_id` values are another
namespace, not automatically root `persistence.sessionId`. The public subagent
descriptor has no universal native-handle field
(`protocol/src/messages.ts:4698-4714`); no generic reverse mapping for those IDs
was established in this investigation.

### Controlled public-surface probe (not live provider evidence)

The following exact probe passed: real Paseo stored-wire projector -> public
snapshot schema -> public SDK `agents.list()` and `ref(...).refresh()` retain
both native ID fields for Codex, Pi and Claude **fixture records**. Transport is
stubbed; it proves no native execution, live uniqueness, or event timing.
Save as `.mts` and run `node --import tsx <file>` from this worktree.

```ts
// Controlled wire/SDK probe only: no daemon, native process, model, or real provider session.
import assert from 'node:assert/strict';
import { buildStoredAgentPayload } from '/Users/astrosheep/Developer/paseo/packages/server/src/server/agent/agent-projections.ts';
import { AgentSnapshotPayloadSchema } from '/Users/astrosheep/Developer/paseo/packages/protocol/src/messages.ts';
import { createPaseoApi } from '/Users/astrosheep/Developer/paseo/packages/client/src/index.ts';
const handles = [
 {provider:'codex',sessionId:'fixture-codex-thread',nativeHandle:'fixture-codex-thread'},
 {provider:'pi',sessionId:'fixture-pi-session',nativeHandle:'/tmp/fixture-pi/session.jsonl'},
 {provider:'claude',sessionId:'fixture-claude-session',nativeHandle:'fixture-claude-session'},
];
const entries = handles.map((handle,i) => {
 const record:any = {id:`fixture-paseo-${i}`,provider:handle.provider,cwd:'/tmp',
  createdAt:'2026-10-15T06:00:00.000Z',updatedAt:'2026-10-15T06:00:00.000Z',
  lastActivityAt:'2026-10-15T06:00:00.000Z',lastUserMessageAt:null,lastStatus:'idle',lastModeId:null,
  labels:{},title:'Controlled native-ID projection',persistence:handle,config:{provider:handle.provider,cwd:'/tmp'}};
 return {agent:AgentSnapshotPayloadSchema.parse(buildStoredAgentPayload(record,['codex','pi','claude'])),project:null};
});
const api = createPaseoApi({
 async fetchAgents(){return {requestId:'list',entries,pageInfo:{hasMore:false,nextCursor:null,prevCursor:null}};},
 async fetchAgent({agentId}:any){return entries.find(e=>e.agent.id===agentId)??null;},
} as any);
try {
 const listed = await api.agents.list();
 const refreshed = await Promise.all(entries.map(e=>api.agents.ref(e.agent.id).refresh()));
 assert.deepEqual(listed.entries.map(e=>e.agent.persistence),handles);
 assert.deepEqual(refreshed.map(e=>e?.agent.persistence),handles);
 console.log(JSON.stringify({scope:'controlled serializer/schema/public SDK probe, NOT live provider/daemon evidence',listed:listed.entries.map(e=>({id:e.agent.id,persistence:e.agent.persistence})),refreshed:refreshed.map(e=>({id:e?.agent.id,persistence:e?.agent.persistence}))},null,2));
} finally { await api.dispose(); }
```

Observed: all three `listed` and `refreshed` records preserved the exact handles
above, with no schema stripping or SDK hiding. The original extra transcript is
`/tmp/paseo-b486-research.i4CfDY/native-id-public-surface.log`; this document
retains the runnable probe and its assertions independently of that file.

## 7. Current native Claude Bash ID export: actual SDK/Paseo probe

### Result and provenance

**Native Claude 2.1.299 exports `CLAUDE_CODE_SESSION_ID` into Bash without
`USER_TYPE=ant`, a SessionStart exporter, or `CLAUDE_ENV_FILE`.** The value
matched both SDK `system.init.session_id` and Paseo adapter persistence in fresh,
resume, and real SDK fork-then-resume probes. No hook adaptation is needed to
obtain this ID on the tested version. This does not choose attribution policy
or remove the zero/multiple-match and publication-timing limits in section 6.

Version/provenance actually inspected and executed:

- Production default resolver: `providers/claude/agent.ts:1756-1764` resolves
  `claude` through the normal provider launch resolver. The isolated real
  `ClaudeAgentClient` resolved `/Users/astrosheep/.local/bin/claude`, a symlink to
  `/Users/astrosheep/.local/share/claude/versions/2.1.299`. No binary resolver or
  version stub was installed. Running this binary with isolated env returned
  `2.1.299 (Claude Code)`.
- Native binary: 247,931,696 bytes; SHA-256
  `ba5ab7b8c195fa03ab8d5bf3915c76153b576a2c40e79a5c46e265e7ed9744b3`.
- Real installed SDK: Paseo's `@anthropic-ai/claude-agent-sdk` **0.3.246**.
  Paseo source HEAD remains `e8108d9092a43c88fabebc0bf938584d34e462d6`.
- `/Users/astrosheep/Developer/claude-code` is a **third-party xorespesp mirror**.
  Its `USER_TYPE=ant` branch does not describe this installed executable and is
  not used as evidence for current behavior. No release-introduction claim is
  made here; the holder owns official docs/release research.

### Direct executable evidence, not mirror source

The installed Mach-O contains its versioned bundled JavaScript. Read-only byte
inspection found these actual clauses (offsets refer to the SHA above):

```js
// Offset 200735494: shared subprocess identity, no USER_TYPE condition.
function _3e(e) {
  let n = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: e.sessionId,
    CLAUDE_CODE_CHILD_SESSION: "1", /* attended flag, pid, etc. */ };
  // Other fields are optional; the session-ID assignment above is unconditional.
  // ...
  return n;
}
// Offset 205776276: native shell spawn environment, excerpt.
function Mdr({shellType:e,binShell:n,envOverrides:r,sandboxEnv:s,
              sandboxUnsetEnv:h,effortLevel:y}) {
  return {...gs(),SHELL:e==="bash"?n:void 0,GIT_EDITOR:"true",...r,...s,
    ..._3e({sessionId:K(),effortLevel:y,source:"agent"}),
    ...h&&Object.fromEntries(h.map((b)=>[b,void 0]))};
}
```

At offset 205771288 the actual shell subprocess receives `env:Mdr(...)`.
At 205793303, inline skill shell expansion (`eSe`) chooses `Ti` for Bash;
at 205795123 it calls `await y.call({command:be},Ae)` after permission checks. At 206637776 `Ti` is the native tool object, and at 238921580
the bundle exports `Ti as BashTool`. Thus the no-model skill probe below really
executes the native Bash tool; it is not an unrelated child shell assumed to
stand in for it. These excerpts are executable-inspection evidence, not a
public source API or an invariant across all future versions.

The native `bash_command` wire message is **not** used: its schema describes a
separate one-shot `/bin/sh -c` route, and its implementation at 232023875 uses
`env:gs()` instead of this Bash-tool path. A result from that route would not
prove Bash-tool identity injection.

### Actual adapter/SDK execution and results

The probe constructs real `ClaudeAgentClient`, calls public `createSession`,
`run`, `describePersistence`, `close`, and `resumeSession`, and leaves its real
`claudeQuery` custom spawn path intact. Only a query-factory observation wrapper
is added; it delegates to the real installed SDK, never a fake response.

Test-only options are explicit: `--bare` prevents keychain/auth discovery and
other unrelated activity; an explicit local plugin supplies a failing inline
Bash preflight. Bare skips project skill discovery, so explicit `plugins` is
needed. This is not an unchanged production-settings E2E test. The existing
Paseo options remain observable: setting sources are `[user,project,local]`,
hooks are only `[PreToolUse,PostToolUse,SubagentStop]`, and the actual production
spawn callback is used. Neither SDK launch env nor native spawn env contained
`CLAUDE_CODE_SESSION_ID`, `USER_TYPE`, or `CLAUDE_ENV_FILE`.

The inline Bash command records only those identity variables, then intentionally
exits 42. Claude reports a local-command failure and a successful zero-turn
result before any model query. No credentials or real model endpoint are given;
`ANTHROPIC_BASE_URL` points to closed loopback port 1. All three SDK results
reported `duration_api_ms:0`, `num_turns:0`, `total_cost_usd:0`, `is_error:false`.
No model was called or substituted.

Observed final run (all assertions passed):

| Phase | Bash `CLAUDE_CODE_SESSION_ID` = SDK init/result = Paseo sessionId/nativeHandle |
| --- | --- |
| Fresh | `785af4fa-73eb-4f96-ac13-422d10f93151` |
| Resume | `785af4fa-73eb-4f96-ac13-422d10f93151` |
| SDK fork, then resume fork | `ad8b7a79-6f47-4dce-8235-16b8a429c5d2` |

For every phase `USER_TYPE:null`, `CLAUDE_ENV_FILE:null`, `CLAUDECODE:"1"`, and
`CLAUDE_CODE_CHILD_SESSION:"1"`. Fresh options had no `resume` or explicit
`sessionId`; resume options used the first UUID; fork/resume options used the
new UUID. The fork used the real SDK `forkSession` on the real locally recorded
zero-model transcript, not a fabricated transcript or an invented handle.

Fork boundary: this exercises SDK file fork plus a new adapter's `resumeSession`.
Paseo's same-agent conversation rewind/rebind remains **source-traced**, not a
live UI rewind test: `claude/rewind.ts:13-28` calls the same SDK fork operation;
`agent.ts:2895-2909,3087-3115` rebinds that new ID, invalidates runtime info, and
emits `thread_started`. No claim of live daemon/UI mapping refresh is made.

### Reproducible probe retained here

Save this TypeScript as `/tmp/claude-native-id-probe.mts`. The launcher below
creates all other files under a fresh temporary directory. It needs the already
installed Paseo dependencies; it performs no installation or repository writes.
The query observer records only selected option/message fields, not credentials.

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { ClaudeAgentClient } from '/Users/astrosheep/Developer/paseo/packages/server/src/server/agent/providers/claude/agent.ts';
import { query, forkSession } from '/Users/astrosheep/Developer/paseo/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
const require=createRequire('/Users/astrosheep/Developer/paseo/package.json');
const pino=require('pino');
const root=process.argv[2], cwd=root+'/project';
let phase='fresh';
const records:any[]=[];
const log=(r:any)=>{records.push({phase,...r});console.log(JSON.stringify(records.at(-1)));};
for(const key of ['CLAUDE_CODE_SESSION_ID','USER_TYPE','CLAUDE_ENV_FILE'])
  assert.equal(process.env[key],undefined,key+' must not be supplied');
const client=new ClaudeAgentClient({logger:pino({level:'silent'}),queryFactory(input:any){
  log({kind:'options',binary:input.options.pathToClaudeCodeExecutable,
    settingSources:input.options.settingSources,resume:input.options.resume??null,
    sessionId:input.options.sessionId??null,hooks:Object.keys(input.options.hooks??{}),
    idInLaunchEnv:input.options.env?.CLAUDE_CODE_SESSION_ID??null});
  for(const k of ['CLAUDE_CODE_SESSION_ID','USER_TYPE','CLAUDE_ENV_FILE'])
    assert.equal(input.options.env?.[k],undefined);
  const originalSpawn=input.options.spawnClaudeCodeProcess;
  const q=query({...input,options:{...input.options,
    extraArgs:{...input.options.extraArgs,bare:null},
    plugins:[{type:'local',path:cwd+'/.claude'}],
    spawnClaudeCodeProcess(spawn:any){
      for(const k of ['CLAUDE_CODE_SESSION_ID','USER_TYPE','CLAUDE_ENV_FILE'])
        assert.equal(spawn.env?.[k],undefined);
      log({kind:'spawn',command:spawn.command,
        identityInEnv:spawn.env?.CLAUDE_CODE_SESSION_ID??null});
      return originalSpawn(spawn);
    },
  }});
  const iterable=q[Symbol.asyncIterator].bind(q);
  (q as any)[Symbol.asyncIterator]=function(){const it=iterable();return {
    async next(...args:any[]){
      const v=await it.next(...args), m:any=v.value;
      if(m&&(m.type==='system'&&m.subtype==='init'||m.type==='result')) {
        log({kind:'sdk',type:m.type,subtype:m.subtype,session_id:m.session_id,
          claude_code_version:m.claude_code_version,duration_api_ms:m.duration_api_ms,
          num_turns:m.num_turns,total_cost_usd:m.total_cost_usd,error:m.is_error});
        if(m.type==='result') {
          assert.equal(m.duration_api_ms,0);assert.equal(m.num_turns,0);
          assert.equal(m.total_cost_usd,0);assert.equal(m.is_error,false);
        }
      }
      return v;
    },
    async return(...args:any[]){return it.return(...args);},
    [Symbol.asyncIterator](){return this;},
  };};
  return q;
}});
let active:any;
try {
  active=await client.createSession({provider:'claude',cwd});
  for(const step of ['fresh','resume','fork']) {
    phase=step;
    const before=(await fs.readFile(root+'/captures.jsonl','utf8').catch(()=>''))
      .trim().split('\n').filter(Boolean).length;
    const result=await active.run('/isolated-id-probe:probe-native-id');
    const handle=active.describePersistence();
    const captures=(await fs.readFile(root+'/captures.jsonl','utf8'))
      .trim().split('\n').map(JSON.parse);
    assert.equal(captures.length,before+1);
    const capture=captures.at(-1);
    assert.equal(capture.CLAUDE_CODE_SESSION_ID,handle.sessionId);
    assert.equal(handle.nativeHandle,handle.sessionId);
    assert.equal(result.sessionId,handle.sessionId);
    assert.equal(capture.USER_TYPE,null);assert.equal(capture.CLAUDE_ENV_FILE,null);
    const init=records.findLast(r=>r.phase===phase&&r.kind==='sdk'&&r.subtype==='init');
    assert.equal(init?.session_id,handle.sessionId);
    assert.equal(init?.claude_code_version,'2.1.299');
    log({kind:'observed',capture,persistence:{provider:handle.provider,
      sessionId:handle.sessionId,nativeHandle:handle.nativeHandle},runSessionId:result.sessionId});
    await active.close();active=null;
    if(step==='fresh')active=await client.resumeSession(handle,{cwd});
    if(step==='resume') {
      const fork=await forkSession(handle.sessionId,{dir:cwd});
      assert.notEqual(fork.sessionId,handle.sessionId);
      log({kind:'fork',source:handle.sessionId,newId:fork.sessionId});
      active=await client.resumeSession({...handle,sessionId:fork.sessionId,
        nativeHandle:fork.sessionId},{cwd});
    }
  }
  await fs.writeFile(root+'/records.json',JSON.stringify(records,null,2));
  console.log('PASS: native Bash IDs match Paseo persistence; no model');
} finally {await active?.close();}
```

Launcher (minimal explicit environment, no inherited harness identities/auth):

```python
import json, os, pathlib, signal, subprocess, tempfile
p=pathlib.Path(tempfile.mkdtemp(prefix='claude-native-id-'))
for name in ['home','config','project','tmp']: (p/name).mkdir()
plugin=p/'project/.claude'
(plugin/'.claude-plugin').mkdir(parents=True)
(plugin/'skills/probe-native-id').mkdir(parents=True)
(plugin/'.claude-plugin/plugin.json').write_text(json.dumps({
  'name':'isolated-id-probe','version':'1.0.0'}))
(p/'capture.py').write_text('''import json, os, pathlib, sys
record={k:os.environ.get(k) for k in ['CLAUDE_CODE_SESSION_ID','USER_TYPE',
 'CLAUDE_ENV_FILE','CLAUDECODE','CLAUDE_CODE_CHILD_SESSION']}
with (pathlib.Path(__file__).parent/'captures.jsonl').open('a') as f:
 f.write(json.dumps(record)+'\\n')
print(json.dumps(record),flush=True)
print('INTENTIONAL_PREFLIGHT_STOP_NO_MODEL',flush=True)
sys.exit(42)
''')
(plugin/'skills/probe-native-id/SKILL.md').write_text(
  '---\nname: probe-native-id\ndescription: Isolated no-model identity probe\n'
  'allowed-tools: Bash(*)\nshell: bash\n---\n```!\n'
  +'/opt/homebrew/bin/python3 '+str(p/'capture.py')+'\n```\n')
env={'PATH':'/Users/astrosheep/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
 'HOME':str(p/'home'),'CLAUDE_CONFIG_DIR':str(p/'config'),
 'XDG_CONFIG_HOME':str(p/'home/.config'),'TMPDIR':str(p/'tmp'),
 'SHELL':'/bin/bash','TERM':'xterm-256color','DISABLE_AUTOUPDATER':'1',
 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC':'1','ANTHROPIC_BASE_URL':'http://127.0.0.1:1'}
args=['/opt/homebrew/bin/node',
 '/Users/astrosheep/Developer/paseo/node_modules/tsx/dist/cli.mjs',
 '/tmp/claude-native-id-probe.mts',str(p)]
with (p/'probe.log').open('wb') as out:
 proc=subprocess.Popen(args,env=env,cwd=p/'project',stdout=out,
   stderr=subprocess.STDOUT,start_new_session=True)
 try:
  code=proc.wait(timeout=55)
 except subprocess.TimeoutExpired:
  os.killpg(proc.pid,signal.SIGTERM)
  try: proc.wait(timeout=5)
  except subprocess.TimeoutExpired: os.killpg(proc.pid,signal.SIGKILL);proc.wait()
  raise
print(p, 'exit', code)
print((p/'probe.log').read_text())
assert code==0
```

Both code blocks above were extracted from this document and executed together;
the launcher exited 0 with all assertions passing. The table records that exact
rerun. Its artifact root is
`/var/folders/xd/ln7zbjqx4xsdgd6n98ln_wb80000gn/T/claude-native-id-bglt1eab`
(`probe.log`, `records.json`, `captures.jsonl`). Earlier direct CLI and SDK
artifacts remain in
`/var/folders/xd/ln7zbjqx4xsdgd6n98ln_wb80000gn/T/claude-native-id-2pw2xja4`.
The essential sources, observed IDs, zero-model results, and executable hash are
retained above rather than depending solely on temporary artifacts.

### Remaining limits / smallest usable path

For this binary version, a descendant command of the root native Bash tool can
read `CLAUDE_CODE_SESSION_ID` directly and send it with the Claude provider and
Paseo/home scope. Paseo's existing public snapshots expose the same root ID as
`persistence.sessionId`/`nativeHandle`. No exporter hook, `USER_TYPE` spoof,
additional daemon, model, or launch-time ID injection is necessary for that
technical path. No adapter or caller implementation was changed here.

This does **not** prove model obedience, a real Keiyaku call from Claude,
provider-owned subagent identity mapping, unmodified user settings/sandbox
behavior, observer-free public Keiyaku birth reads, unique reverse mapping, or
live manager/UI timing. It also does not claim SessionStart JS callbacks return
shell environment variables, or that old Claude versions have this feature.
No user settings/daemon operations, Contract mutation, audit, or delivery ran.

## 8. Authorized native-ID implementation and parallel evidence

The holder subsequently amended b486 and explicitly authorized implementation.
The CLI now records native Codex/Pi/Claude IDs in the existing external caller;
complete Akuma attribution wins, incomplete custody refuses, and multiple native
host IDs refuse instead of guessing. The old declared external caller remains a
fallback when there is no native host ID. No caller schema or Square code changed.
The existing Akuma execution environment already removes all three inherited
native IDs and the old external caller, so no second cleaning implementation was
added.

The Paseo session-open injector is removed. Attach enumerates public snapshots
with archived/background inclusion and exact persistence provider/session ID
matching, finishes pagination before accepting uniqueness, then refreshes the
sole candidate. Missing/duplicate/archived/stale identities return non-attachment
with a diagnostic. Old `paseo` callers keep direct-ID lookup. Canonical
World/Akuma idempotency, the forwarder, and the read-only mirror are reused.
No retry queue, registry, polling, native alias history, or duplicate worker was
introduced. Completed daemon-creation replay preserving user detach/archive
remains the source-backed boundary in section 3, not a newly simulated live test.

Verification completed in this worktree:

- Contract command `node --import tsx --test tests/paseo*.test.ts`: green.
- Paseo tests plus new native-caller and existing CLI-caller tests: green.
- Birth/request regression: `tests/library-akuma-creation.test.ts` and
  `tests/cli-akuma-msys.test.ts`: green.
- `npm run test:typecheck` and `npm run build`: green.

These are focused/fixture tests, not real daemon/UI evidence. The registered
plugin seam asserts no session-open hook, canonical native/legacy retry identity,
and the public client parent-to-wire mapping. Native-parent tests cover all three
providers, later-page matches, Pi handle-only rejection, a later-page duplicate
including an archived record, and refresh-time missing/archive/identity changes.

Background API version boundary: the repository's installed client/protocol
0.11.2 types lack `includeBackground`; the current inspected Paseo source accepts
`filter.includeBackground` (`protocol/src/messages.ts:917`,
`server/session.ts:5466-5468`). The plugin uses the host-injected public Paseo API,
not a client constructed from Keiyaku's pinned transport. Its filter carries both
inclusion flags. The focused fake transport asserts those flags but cannot prove
an older host honors them. No dependency was silently upgraded. In particular,
a manual client constructed from the old pinned protocol strips unknown flags;
that is not evidence of current-host background enumeration.

### Parallel Codex evidence: real thread-scoped shell to ordinary CLI birth

An independent evidence-only Akuma (`aku/intern/020fc249`) ran real Codex 0.160.1
with Paseo's actual env builder and app-server transport, using isolated homes.
Unlike out-of-thread `command/exec`, **`thread/start` + `thread/shellCommand`**
automatically supplied the native thread ID. A prompt-free ordinary
`keiyaku call worker --json` from that shell recorded:

```json
{"kind":"akuma.born","akumaId":"aku/worker/25a53256","bodySequence":1,"origin":{"kind":"direct"},"caller":{"kind":"external","integration":"codex","id":"01a13ed1-c063-7583-afdd-53c4e262671e"}}
```

This is a projection of the recorded birth (unrelated initiator omitted).
The original artifact root is `/tmp/b486-codex-inthread-t1sqxI`; the parent read
both `births.jsonl` and `in-thread-env.txt` directly. The latter had
`CODEX_THREAD_ID=01a13ed1-c063-7583-afdd-53c4e262671e` and
`KEIYAKU_EXTERNAL_CALLER=<unset>`. Notifications contained a real
`commandExecution` item and thread turn. This is **not** a model-driven
`exec_command`, a Paseo-manager-created parent, or UI attachment proof.
Paseo's adapter itself does not call `thread/shellCommand`.

Runnable probe retained here (save as `.mts`, run with Paseo's installed tsx
loader). The worker used the same route and a fixed post-command observation
pause; the retained version also asserts the recorded caller explicitly.

```ts
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import pino from '/Users/astrosheep/Developer/paseo/node_modules/pino/pino.js';
import {buildCodexAppServerEnv} from '/Users/astrosheep/Developer/paseo/packages/server/src/server/agent/providers/codex-app-server-agent.ts';
import {CodexAppServerClient} from '/Users/astrosheep/Developer/paseo/packages/server/src/server/agent/providers/codex/app-server-transport.ts';
const root=await mkdtemp('/tmp/b486-codex-inthread-');
const home=join(root,'home'),world=join(root,'world'),bin=join(root,'bin');
for(const p of [home,world,bin,join(world,'.keiyaku'),join(world,'plugins'),join(home,'akuma'),join(home,'codex')])
  await mkdir(p,{recursive:true});
const wt='/Users/astrosheep/Developer/keiyaku-v4/.keiyaku/wt/devnull';
const tsx='/Users/astrosheep/Developer/keiyaku-v4/node_modules/tsx/dist/loader.mjs';
await writeFile(join(bin,'keiyaku'),`#!/bin/sh\nexec '${process.execPath}' --import '${tsx}' '${wt}/src/cli/index.ts' "$@"\n`,{mode:0o755});
await writeFile(join(home,'akuma/worker.md'),'---\nprovider: fixture\n---\nPrompt-free probe.\n');
await writeFile(join(world,'plugins/record.mjs'),`import {appendFileSync} from 'node:fs'; export default {manifest:{id:'record',apiVersion:1},activate(c){return {signals:{'akuma.born':e=>appendFileSync(c.config.output,JSON.stringify(e)+'\\n')}}}};`);
await writeFile(join(world,'.keiyaku/settings.json'),JSON.stringify({
  plugins:{record:{package:'./plugins/record.mjs',config:{output:join(root,'births.jsonl')}}},
  providers:{fixture:{kind:'acp',executable:process.execPath,config:{argvBefore:[],argvAfter:[],
    modelArg:'--model',effortArg:'--effort',systemPromptArg:'--system-prompt',systemPromptMode:'append'}}}}));
for(const k of Object.keys(process.env))
  if(/^(KEIYAKU_|AKUMA_|SQUARE_|PI_|PASEO_|CODEX_|CLAUDE_)/u.test(k))delete process.env[k];
Object.assign(process.env,{HOME:home,KEIYAKU_HOME:home,PI_CODING_AGENT_DIR:join(home,'pi'),
  CODEX_HOME:join(home,'codex'),PASEO_HOME:join(home,'paseo'),PATH:`${bin}:${process.env.PATH}`,
  XDG_CONFIG_HOME:join(home,'xdg')});
const env=buildCodexAppServerEnv(undefined,{PASEO_AGENT_ID:'probe-parent',PASEO_AGENT_CWD:world});
assert.equal(env.CODEX_THREAD_ID,undefined);assert.equal(env.KEIYAKU_EXTERNAL_CALLER,undefined);
const child=spawn('/opt/homebrew/bin/codex',['app-server'],{cwd:world,env,stdio:['pipe','pipe','pipe']});
const codex=new CodexAppServerClient(child as any,pino({level:'silent'}));
try {
  await codex.request('initialize',{clientInfo:{name:'b486_probe',version:'1'},capabilities:{experimentalApi:true}},15000);
  codex.notify('initialized');
  const started:any=await codex.request('thread/start',{cwd:world},20000);
  const id=started.thread.id, dump=join(root,'identity.txt');
  const command=`printf '%s\\n%s\\n' "\${CODEX_THREAD_ID-<unset>}" "\${KEIYAKU_EXTERNAL_CALLER-<unset>}" > '${dump}'; keiyaku -C '${world}' call worker --json`;
  await codex.request('thread/shellCommand',{threadId:id,command,timeoutMs:30000},40000);
  await new Promise(r=>setTimeout(r,1500));
  const identity=await readFile(dump,'utf8');assert.equal(identity,`${id}\n<unset>\n`);
  const births=(await readFile(join(root,'births.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(births.length,1);
  assert.deepEqual(births[0].caller,{kind:'external',integration:'codex',id});
  console.log(JSON.stringify({root,threadId:id,akumaId:births[0].akumaId,caller:births[0].caller}));
} finally {try{await codex.dispose();}finally{child.kill('SIGKILL');}}
```

### Pi: real tool clause versus RPC/user-shell limitation

The independent clean-env probe used real Paseo `PiCliRuntime` and installed Pi
1.2.0 (`/Users/astrosheep/.pi/agent/bin/pi`). `get_state` returned native session
`01a13ed2-94c1-76a4-a8f7-34872a544996`, but RPC `bash` printed
`PI_SESSION_ID=<unset>`, `PI_SESSION_FILE=<unset>`, `PI_PROVIDER=<unset>`.
An earlier unclean run forwarded the enclosing Pi ID instead. Thus section 1's
RPC `bash` evidence is only about the explicitly injected external caller and
must **not** be used to claim native Pi tool identity.

The real installed `createBashToolDefinition(...).execute(...,ctx)` was also
called by the host in isolation with a controlled context supplying a real RPC
session ID. It stripped a decoy inherited Pi ID and emitted the context's ID;
`exposeSessionEnvironment:false` and no context emitted no Pi ID. This confirms
the actual installed tool clause, **not** that the real model loop supplied that
context. The controlled context's provider/model strings were fixture labels;
no model was selected, called, or substituted. The worker found no public
model-free RPC tool-call route to that path, and no Claude-like inline shell
expansion. Real model-loop/Paseo-manager Pi env evidence remains missing.

Original scripts: `/tmp/b486-pi-rpc-bash2.mts`, `/tmp/b486-pi-tool.mts`.
The following compact equivalent retains the probe path without a fake model
selection; its context is explicitly controlled, not a live AgentContext.

```ts
import assert from 'node:assert/strict';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import pino from '/Users/astrosheep/Developer/paseo/node_modules/pino/pino.js';
import {PiCliRuntime} from '/Users/astrosheep/Developer/paseo/packages/server/src/server/agent/providers/pi/cli-runtime.ts';
const {createBashToolDefinition}=await import('/Users/astrosheep/.pi/agent/install/releases/1.2.0/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js');
const root=await mkdtemp('/tmp/b486-pi-boundary-'),home=join(root,'home'),cwd=join(root,'cwd');
for(const p of [home,cwd,join(root,'tmp'),join(home,'pi')])await mkdir(p,{recursive:true});
for(const k of Object.keys(process.env))
  if(/^(KEIYAKU_|AKUMA_|SQUARE_|PI_|PASEO_|CODEX_|CLAUDE_)/u.test(k))delete process.env[k];
const env={PATH:process.env.PATH??'/usr/bin:/bin',HOME:home,PI_CODING_AGENT_DIR:join(home,'pi'),
  TMPDIR:join(root,'tmp'),SHELL:'/bin/bash',TERM:'dumb'};
Object.assign(process.env,env);
const runtime=new PiCliRuntime({logger:pino({level:'silent'}),command:['/Users/astrosheep/.pi/agent/bin/pi']});
const pi=await runtime.startSession({cwd,env,noSession:true,
  extraArgs:['--no-extensions','--no-skills','--no-prompt-templates','--no-themes']});
try {
  const state:any=await pi.request({type:'get_state'},20000);
  assert.ok(state.sessionId);
  const command=`printf 'PI_SESSION_ID=%s' "\${PI_SESSION_ID-<unset>}"`;
  const rpc:any=await pi.request({type:'bash',command},20000);
  assert.equal(rpc.output,'PI_SESSION_ID=<unset>');
  const ctx={cwd,thinkingLevel:'off',sessionManager:{
    getSessionId:()=>state.sessionId,getSessionFile:()=>state.sessionFile}};
  const result:any=await createBashToolDefinition(cwd).execute('probe',{command},undefined,undefined,ctx);
  const text=result.content[0].text;
  assert.equal(text,`PI_SESSION_ID=${state.sessionId}`);
  console.log(JSON.stringify({root,nativeSessionId:state.sessionId,rpcShell:rpc.output,
    controlledToolContext:text,scope:'real tool code, controlled context; NOT live model loop'}));
} finally {await pi.close();}
```

Neither parallel probe operated on the user's Paseo or proved live native UI
selection. Missing UI/model-loop evidence is not disguised as test coverage,
and implementation/verification was not delayed waiting for it. Holder review
remains independent; no self-review verdict has been recorded.

Both section-8 TypeScript blocks were extracted from this document and rerun
successfully by the implementing parent. Codex rerun: root
`/tmp/b486-codex-inthread-bEoeq0`, thread
`01a13ed7-e288-72b0-a328-a31f887431d8`, birth `aku/worker/b57fc1a3` with that exact
`external/codex` caller. Pi rerun: root `/tmp/b486-pi-boundary-hVrrmb`, real session
`01a13ed7-e379-711d-af21-3f4eb1039467`; RPC shell remained unset, controlled-context
real tool emitted that ID. No model call or user daemon/config operation occurred.

The holder added `docs/cli.md` to b486 Region before delivery. Its caller law now
records native-host capture, conflicting-host refusal, explicit external fallback,
and custody precedence without duplicating executable env grammar. Source and
focused tests proceeded before this documentation amendment was authorized.
