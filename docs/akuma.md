# Akuma

This chapter owns Akuma identity, heart facts, life, detached bodies, provider
boundaries, lifecycle verbs, and persistence. The current surface ships ACP,
Claude, Codex app-server, Grok Build, OpenCode V1, and Pi providers, public
handles, status, wait, interrupt, fork, Body Requests, CLI skin, and Kanshi
rows. Body Requests reroute the existing call surface; they add no public verb.

An akuma is a summoned agent: useful, dangerous, and cheap. The
flagship calls one, watches it, steers it, and collects what it brings back —
in TypeScript first. The CLI is argv skin over the same surface.

## Shape

One akuma is a set of durable facts in one place — its heart. Processes come
and go; the heart stays.

Filesystem and Heart observation crosses an asynchronous boundary. Public
initializers, roster reads, handles that read status or history, lifecycle
verbs, and transport operations return Promises and complete their observation
before fulfillment. Pure identity parsing, path derivation, projection of
already-read facts, and construction of a handle over a resolved WorldRoot stay
synchronous.

- **heart** — the closed custody core in `heart/`. It privately owns `heart.db`
  and `leash.db`; typed facts cross its index boundary, SQL rows and schemas do
  not. One authority boundary does not require one source file: facts, row
  mechanics, and transaction judges remain separate paragraphs of the same
  heart. Raw statements are row mechanics; they do not speak in the judge's
  transaction language.
- **soul** — the immutable birth facts: id, archetype, description, resolved
  provider execution, provider options, optional readonly restraint, summon
  cwd, origin, and confinement.
  The cwd is the akuma's seat, not a native resume coordinate; resumability
  remains a session fact.
- **body** — the detached, unsandboxed process currently driving the akuma.
  At most one body at a time; most of the time, none.
- **leash** — an exclusive transaction in `leash.db`. Whoever holds it is the
  body. Held for the body's whole life; the OS releases it on death. The same
  database holds the seal, so birth and sealing have one judge. It is the sole
  execution-seat and liveness authority.
- **seal** — a control row that closes a coordinate forever: a sealed
  directory will never be born.
  Written only under the leash; a late body's birth claim checks the seal
  in the same transaction and self-aborts if present.
- **provider** — the agent process the body drives through the built-in adapter
  kind selected by its frozen execution recipe. Its writable reach is a typed
  confinement fact, never an admission gate.

The dependency direction is fixed:

```text
cli -> akuma -> {body, heart, identity, archetype, provider, publication, requests, providers(map), settings}
archetype -> {identity, provider-recipe, provider, providers(map), settings}
body -> {heart, provider, providers, requests, runtime/proc}
requests -> {heart, identity, provider, provider-recipe, providers(map), publication}
publication -> {heart, identity, runtime/proc}
heart/facts -> provider-recipe
heart/soul -> {identity, provider-recipe, heart/facts}
provider -> {heart types, provider-recipe}
providers/map -> {provider-recipe, provider adapters}
providers/* -> {provider, provider-recipe, runtime/proc/stdio}
providers/{acp/index,grok-build} -> providers/acp/core
providers/acp/core -> {provider, runtime/proc/stdio}
providers/codex-app-server/index -> {events, provider, provider-recipe, runtime/proc/line-rpc}
providers/codex-app-server/events -> {provider, runtime/proc/line-rpc(type)}
runtime/proc/line-rpc -> runtime/proc/stdio
runtime/proc/stdio -> runtime/proc/run
kanshi -> akuma public values
```

Process custody is a live capability, not a durable description. The Body may
terminate only provider descendants represented by handles it directly owns.
The public lifecycle verbs write control and wait for the leash; they never
signal from a persisted pid, process group, start token, or reconstructed
identity. A successor does not inherit its predecessor's process capabilities.

## Life

Six states for a born akuma are computed only from a leash probe and durable
Heart facts:

| state    | leash | Heart evidence | meaning |
| -------- | ----- | -------------- | ------- |
| running  | held  | no hung diagnostic for the latest Body | a Body owns the execution seat |
| hung     | held  | latest Body records provider custody that did not retire | the owner cannot yield cleanly |
| untidy   | free  | no explicit end for the latest Body | physical death released the seat without clean settlement |
| asleep   | free  | latest Body ended `exited` | last turn completed; tell and fork ready |
| stranded | free  | latest Body ended `broke-off` or `put-down` | that drive did not complete normally |
| killed   | free  | latest Body has a kill witness | `kill` witnessed that Body's clean self-termination |

`hung` is constructed only by the live Body from failed provider-custody
retirement, never by a public timeout. `hung` and `untidy` are conservative
truth, not permission to reconstruct a process grip. A description can
diagnose, refuse, wait, or report; it cannot authorize signaling a non-child. A
later Body may take a free leash and supersede untidy history without claiming
that it terminated the predecessor.

Before birth a directory is **unborn**: either being born or abandoned by a
crashed caller — indistinguishable by reading, and no fact about the akuma
is claimed. Certainty costs the leash: take it; a soul means born; no soul
means you may seal it, and sealed is permanently **stillborn**. Age is
evidence for humans, never a judge.

An Akuma does not die when its current Body stops. A finished turn is asleep;
a failed turn is stranded; `kill` records that it stopped one exact Body. That
witness projects `killed` only while the witnessed Body remains latest. It does
not alter Soul, sessions, history, pending Tells, or Body Requests. A later
Tell wakes the same Akuma, and the successor Body naturally supersedes the old
kill witness. Retained history and fork remain readable throughout.

## Identity and birth

Identity is `aku/<archetype>/<hex8>`, the registered family in `docs/model.md`.
The physical directory name is the structural projection `/` -> `-`
(`spider-5fa5fb68`) — deterministic topology, not a second identity.
The identity boundary is the sole interpreter in both directions: identity to
directory and directory name back to identity.

Allocation is the atomic directory create. `EEXIST` means the coordinate is
taken — occupied, closed, or sealed, no difference — so redraw. The
directory is also the write-ahead record: it exists before any process is
spawned.

Birth order: create directory -> spawn body -> body takes the leash and, in
the same claim, checks for a seal (sealed -> self-abort) -> soul row written
under that claim -> visible. The ordinary birth timeout is 30 seconds, and
`call()` returns only after birth. A Body that fails before writing Soul seals
the directory under the leash with its exact diagnostic; the caller observes
that seal and reports the same spawn failure. The remaining window between
create and claim is owned by `call()` while it lives: on timeout it takes the
leash itself if it can, seals with `call-timeout` evidence, and reports the
timeout. Process output never decides whether the Body failed or what evidence
the Seal contains.
If the caller crashes inside the window, the directory is unborn until someone
pays the leash to seal it. Nothing sweeps blind; nothing adjudicates by age.

Tell input to an existing address requires a born Soul. Heart judges that
condition in the same transaction that would append the Tell: an
unborn address is refused without a timeline or Tell fact. The public handle
reports the existing not-born error; it never reports failure after leaving a
future input behind.

Public world and summon coordinates are normalized once at the Akuma boundary.
Soul cwd, heart paths, and detached launch paths are absolute below that point;
downstream layers do not reinterpret relative paths.

Each Body receives `KEIYAKU_ACTOR_ID` equal to that Soul's AkuId. The caller
process environment is unchanged.

Stillborn residue is visible in `list()` with its evidence. No automatic
cleaner ships until a real reader needs one; manual removal is safe because
a body must not outlive its heart (ENOENT -> abort through its live provider
handles, exit).

`list()` reads the complete compact fleet. `list({ archetype })` is the same
Akuma-owned read with one optional Archetype selection: Akuma validates the
name, decodes each physical identity, and includes only matching rows. The
caller does not parse AkuIds or filter a complete result itself.

Every valid allocated directory remains in that fleet as born, unborn, or
stillborn from the evidence that exists. Missing Heart or leash in the ordinary
initialization window is unborn. A seal without Soul is stillborn. Soul selects
the born row. A name that is not a canonical physical AkuId is not an identity
and may be ignored. After a valid physical identity, schema mismatch, IO
corruption, and other read failures fail the fleet read; they are not absence.
That failure names the complete AkuId and physical directory and retains the
original cause. `list()` does not seal, sweep, repair, retry, or judge age.

## Archetype

An Archetype is the mask that combines an akuma's personality and provider
configuration. It is call-time input at exactly one path:

```text
~/.keiyaku/akuma/<name>.md
```

The file begins with one strict YAML mapping. `provider` is required;
`model`, `effort`, `readonly`, `network`, and `description` are optional.
When present, `readonly` accepts only literal `true`; `false`, non-boolean
values, and the removed `access` spelling are malformed. `network` is
`disabled | enabled`; every other consumed value is a nonblank string.
Additional top-level keys are ignored and never enter Archetype options or the
soul snapshot. A nonempty Markdown body after frontmatter overrides the system
prompt; an empty body leaves that option absent so the native harness keeps its
default.

`Akuma.of(root, settings?)` consumes one already resolved WorldRoot. All
worktrees of one Git repository therefore share one fleet, Alias authority,
and Heart storage. The Soul's execution cwd remains the actual invocation
worktree or subdirectory and does not participate in World identity. Akuma uses the injected
Settings snapshot when present and otherwise constructs one Settings value for
that world. `call({ archetype })` validates the name, reads this one Archetype file,
resolves its `provider` as an execution name in the Settings `providers`
namespace, and asks the selected built-in adapter kind to admit the Archetype
options before allocating an identity. Missing, malformed, unknown-provider,
and unsupported option input is typed failure; inability to enforce a requested
readonly restraint is instead an admitted, durable fact. A missing or malformed
Archetype retains the exact path searched as typed evidence. User-facing text
does not expose the internal term or print that path. A missing name renders
`` `<name>` was not found `` followed by
`` use `keiyaku ls aku/` to list available Akuma ``. There is no fallback
Archetype or directory layering.

`world.listArchetypes()` is the filename-only public Akuma read. It enumerates
canonical `.md` filenames in that same directory and returns their normalized
names in byte order. It does not decode definitions, resolve providers, or
duplicate call admission.

The package-root identity Catalog uses the separate Akuma-owned definition
catalog read. That read decodes every canonical definition and returns its
name, optional `model`, and complete optional `description` in byte order. It
does not resolve the provider namespace, select an adapter, or admit provider
options. A malformed definition fails this selected read with its exact path;
it is not silently reduced to a filename. A missing directory is an empty
catalog, and other IO failures remain exceptions for both reads.

A provider entry is one strict object with required `kind`, optional nonblank
`description` and `executable`, optional object `config`, and optional `env`
whose values are strings. The built-in kinds are `acp`, `claude-agent-sdk`,
`codex-app-server`, `grok-build`, `opencode-sdk`, and `pi`; each kind owns its
optional configuration shape. When no same-name Settings entry exists, Archetype names
`claude`, `codex-app-server`, `opencode-sdk`, `pi`, and `grok-build` select
Akuma-owned default executions. A configured same-name entry replaces that
default wholly under Settings shadow law.

Birth snapshots the Archetype name, optional description, complete provider
execution, admitted options, and the adapter's optional readonly restraint into
the soul. The body never reads Settings or the Archetype file. A newly admitted
native session snapshots the exact options used alongside its coordinate and
cwd; resume reads that session recipe. Before admission, the body uses the
soul's options and summon cwd. Thus later edits to Archetype Markdown affect only
future akuma.

Provider kind `claude-agent-sdk` consumes `model`, `effort`, and
the system prompt. `readonly: true` selects plan mode and records native
enforcement; absence selects the provider's noninteractive native default.

Provider kind `codex-app-server` runs the selected executable, defaulting to
`codex`, as `app-server --listen stdio://`. It consumes `model`, `effort`,
and the system prompt. `readonly: true` selects the native read-only sandbox
and records native enforcement; absence selects the provider's native default.
`network` selects the sandbox's native network flag and defaults to disabled. Its
resumable coordinate is the native thread id; its answered history id is the
completed native turn id, and native fork is `thread/fork` at that exact pair.
The frozen `config` object is supplied to native thread start/resume.
Each app-server instance is a detached helper process tree. Drive completion
awaits termination of that complete tree, so provider descendants cannot outlive
the Body turn or leave an answered Akuma untidy.

Provider kind `opencode-sdk` runs the selected executable, defaulting to
`opencode`, through the official public V1 Session API. It consumes `model` and
the system prompt. Archetype `effort` is passed as OpenCode's native model
variant; it is not a per-call override. V1 has no per-session permission input,
so `readonly: true` is admitted with `none` enforcement and a concrete
diagnostic. Fresh and resumed drives use the frozen session id, and native fork
uses that exact session plus the answered assistant message id. Native
admission, completion, event, and tell semantics belong exclusively to
[akuma-provider.md](akuma-provider.md).

Provider kind `pi` uses the in-process `@earendil-works/pi-coding-agent`
SDK. Model is an exact `<provider>/<id>` lookup through `ModelRuntime`; effort
is one native thinking level; the system prompt is supplied through the native
resource loader. For `readonly: true`, its admitted tool set excludes `bash`,
`edit`, and `write`, and records native enforcement. Its confinement is the
call cwd. Resume and fork use the exact persisted session file. Native steer
proves queueing only, so Pi does not expose live tell.

Provider kind `grok-build` uses the shared ACP lifecycle under its own `x.ai`
wire identity. Its fixed launch consumes `model` and `effort`; custom executions
may replace only executable and environment. It exposes native live tell through
`x.ai/interject`, has no fork, and makes no readonly enforcement claim.

`readonly: true` promises only that the Akuma cannot mutate its task surface.
Native enforcement means the session's reachable capabilities physically lack
every such mutation path, whether by OS sandboxing or harness-level tool
removal; prompt instructions never qualify. Absence makes no portable
restriction claim and leaves the provider at its native default.

The pinned Pi dependency contains a broken internal transitive declaration
path. Project compilation therefore uses `skipLibCheck`; project source and
direct official SDK usage remain strictly checked under NodeNext. No ambient
SDK shim, vendored declaration patch, CommonJS require, or nonliteral import
replaces that narrow compiler setting.

## Placement

Hearts live in the primary world:

```text
<world>/.keiyaku/akuma/run/<name>-<hex8>/{heart.db, leash.db, stdio.log}
```

- Never inside a contract worktree. Git reconcile removes clean
  worktrees lawfully; the akuma pillar must not bleed when that pillar acts.
- `run/.gitignore` containing `*` is written when `run/` is created — the
  ledger ignores itself; the user does nothing.
- Known risk, accepted: `git clean -fdx` in the primary world erases run
  state. Same fate as `.keiyaku/response`; repo-local state is repo-local.
  No defense is built.
- Home keeps Archetype configuration only, never state. Nothing reads it back
  after call.

## Confinement

Threat model, ruled: users and agents are assumed **non-malicious**;
malignant errors — a lying ledger, silent loss of recorded facts — are
barred; kernel-grade correctness is not the bar. Defenses against
deliberate forgery are out of scope: a hostile process with host authority
can falsify anything, and no placement law changes that, so none pretends
to.

What remains is accident isolation, and placement already buys it: hearts
never live in a contract worktree — the provider's task surface — so a
zako's `rm -rf` or `git clean` in its own workspace cannot reach them.
When cwd is the primary world itself, the heart sits inside the provider's
reach; that is the same accepted repo-local risk as anyone running
`git clean -fdx` there, and **no refusal is built**.

The adapter still states the provider's writable surface. During a declared
drive it can grant the body-owned request transport as an additional writable
root; the transport never moves into the user's worktree. The statement rides
into the soul as a typed `confinement` fact — evidence for triage, never a gate.
