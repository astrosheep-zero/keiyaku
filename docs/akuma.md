# Akuma

This chapter owns Akuma identity, heart facts, life, detached bodies, provider
boundaries, lifecycle verbs, and persistence. The current surface ships the
Claude and Codex app-server providers, public handles, status, wait, interrupt,
fork, Body Requests, CLI skin, and Kanshi rows. Body Requests reroute the
existing call surface; they do not add a public verb.

An akuma is a summoned agent: useful, dangerous, cheap, and it can die. The
flagship calls one, watches it, steers it, and collects what it brings back —
in TypeScript first. The CLI is argv skin over the same surface.

## Shape

One akuma is a set of durable facts in one place — its heart. Processes come
and go; the heart stays.

- **heart** — the closed custody core in `heart/`. It privately owns `heart.db`
  and `leash.db`; typed facts cross its index boundary, SQL rows and schemas do
  not. One authority boundary does not require one source file: facts, row
  mechanics, and transaction judges remain separate paragraphs of the same
  heart. Raw statements are row mechanics; they do not speak in the judge's
  transaction language.
- **soul** — the immutable birth facts: id, archetype, description, resolved
  provider execution, provider options, summon cwd, origin, and confinement.
  The cwd is the akuma's seat, not a native resume coordinate; resumability
  remains a session fact.
- **body** — the detached, unsandboxed process currently driving the akuma.
  At most one body at a time; most of the time, none.
- **leash** — an exclusive transaction in `leash.db`. Whoever holds it is the
  body. Held for the body's whole life; the OS releases it on death. The same
  database holds the seal, so birth and sealing have one judge.
- **collar** — the body's recorded process coordinates: pid, process group,
  spawn time. The only safe grip for putting a body down.
- **seal** — a control row that closes a coordinate forever: a sealed
  directory will never be born.
  Written only under the leash; a late body's birth claim checks the seal
  in the same transaction and self-aborts if present.
- **provider** — the agent process the body drives through the built-in adapter
  kind selected by its frozen execution recipe. Its writable reach is a typed
  confinement fact, never an admission gate.

The dependency direction is fixed:

```text
cli -> akuma -> {body, heart, identity, archetype, provider(codec), publication, requests, providers(map), settings, runtime/proc(collar)}
archetype -> {identity, provider, providers(map), settings}
body -> {heart, provider, providers, requests, runtime/proc}
requests -> {heart, identity, provider, providers(map), publication}
publication -> {heart, identity, runtime/proc}
provider -> heart types
providers/* -> {provider, runtime/proc/line-rpc}
providers/codex-app-server/index -> {events, provider, heart, runtime/proc/line-rpc}
providers/codex-app-server/events -> {provider, runtime/proc/line-rpc(type)}
kanshi -> akuma public values
```

The two process-tree duties are distinct. The body puts down a predecessor
before driving; the public `kill` verb is the killer and performs its own
collar duty. Both consume domain-free `runtime/proc` evidence, and neither
moves lifecycle adjudication out of the heart.

## Life

Five states for a born akuma, all computed from two probes — try the leash,
check the collar. Never from a clock, never from a pid table, never from
trust.

| state    | leash | collar               | meaning                                     |
| -------- | ----- | -------------------- | ------------------------------------------- |
| running  | held  | —                    | a body is driving a turn                    |
| asleep   | free  | proven gone          | last turn completed; tell and fork ready    |
| stranded | free  | proven gone          | last turn broke off; that work is lost, typed |
| headless | free  | **not proven gone**  | tree alive, or collar unverifiable — the
                                                evidence says which; wait or kill          |
| dead     | —     | —                    | a death row exists                          |

`headless` never claims more than the probe can prove: it carries the collar
evidence (`alive` / `unverifiable`). A recycled pid is never group-killed
blind; unverifiable stays unverifiable until the flagship acts or the tree
exits.

A headless akuma whose collar stays unverifiable is an in-model dead end:
`tell` refuses (waking requires putting the predecessor down first) and
`kill` reports `unavailable`. The escape is documented, not automated —
fork the work out of retained history; once a human confirms the tree is
gone, remove the run directory by hand. Rare (same-user process identity
is readable on every supported platform in the normal case), but the law
names the dead end rather than pretending it isn't there.

Before birth a directory is **unborn**: either being born or abandoned by a
crashed caller — indistinguishable by reading, and no fact about the akuma
is claimed. Certainty costs the leash: take it; a soul means born; no soul
means you may seal it, and sealed is permanently **stillborn**. Age is
evidence for humans, never a judge.

Natural death does not exist. A finished akuma is asleep, not dead. Failures
are turn facts, not entity death. Death has exactly one writer: `kill`.
Retained history outlives death — a dead akuma can still be forked, and its
answers remain readable.

Death closes every outstanding caller obligation in the same heart
transaction: pending tells become `voided-by-death`, and `admitted` or
`reserved` Body Requests become `voided` with death evidence. A reserved
request copies its child coordinate into that evidence before clearing the
state field. Death-void is receipt-scoped: it proves no caller can ever receive
a receipt, not that the separately judged child failed to be born. A child that
did finish birth remains a real, origin-bearing akuma.

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
under that claim -> visible. `call()` returns only after birth. The window
between create and claim is owned by `call()` while it lives (it polls for
birth; on timeout it takes the leash itself if it can, seals, and reports a
typed spawn failure). If the caller crashes inside the window, the directory
is unborn until someone pays the leash to seal it. Nothing sweeps blind;
nothing adjudicates by age.

Public world and summon coordinates are normalized once at the Akuma boundary.
Soul cwd, heart paths, and detached launch paths are absolute below that point;
downstream layers do not reinterpret relative paths.

Stillborn residue is visible in `list()` with its evidence. No automatic
cleaner ships until a real reader needs one; manual removal is safe because
a body must not outlive its heart (ENOENT -> kill own tree, exit).

`list()` reads the complete compact fleet. `list({ archetype })` is the same
Akuma-owned read with one optional Archetype selection: Akuma validates the
name, decodes each physical identity, and includes only matching rows. The
caller does not parse AkuIds or filter a complete result itself.

## Archetype

An Archetype is the mask that combines an akuma's personality and provider
configuration. It is call-time input at exactly one path:

```text
~/.keiyaku/akuma/<name>.md
```

The file begins with one strict YAML mapping. `provider` is required;
`model`, `effort`, `access`, `network`, and `description` are optional.
`access` is `read | write | auto`; `network` is `disabled | enabled`; every
other consumed value is a nonblank string. Additional top-level keys are
ignored and never enter Archetype options or the soul snapshot. The Markdown body
after frontmatter is the system prompt, including an empty one.

`Akuma.of(root, settings?)` consumes one already resolved WorldRoot. It uses the injected
Settings snapshot when present and otherwise constructs one Settings value for
that world. `call({ archetype })` validates the name, reads this one Archetype file,
resolves its `provider` as an execution name in the Settings `providers`
namespace, and asks the selected built-in adapter kind to admit the Archetype
options before allocating an identity. Missing, malformed, unknown-provider,
and provider-unsupported input is typed failure; a missing or malformed Archetype
includes the exact path searched. There is no fallback Archetype or directory
layering.

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
whose values are strings. The two kinds are `claude-agent-sdk` and
`codex-app-server`; only Codex consumes `config`. When no same-name Settings
entry exists, Archetype names `claude` and `codex-app-server` select their
Akuma-owned default executions. A configured same-name entry replaces that
default wholly under Settings shadow law.

Birth snapshots the Archetype name, optional description, complete provider
execution, and admitted options into the soul. The body never reads Settings or
the Archetype file. A newly admitted
native session snapshots the exact options used alongside its coordinate and
cwd; resume reads that session recipe. Before admission, the body uses the
soul's options and summon cwd. Thus later edits to Archetype Markdown affect only
future akuma.

Provider kind `claude-agent-sdk` consumes `model`, `effort`, and
the system prompt. `access` maps `read` to plan mode, `write` to edit acceptance,
and `auto` or absence to bypass mode. Claude cannot honestly enforce the
portable `network` claim, so either network value is refused before birth.

Provider kind `codex-app-server` runs the selected executable, defaulting to
`codex`, as `app-server --listen stdio://`. It consumes `model`, `effort`,
and the system prompt. Missing `access` and `access: write` both select native
workspace-write rooted exactly at the normalized call cwd; `network` selects
that sandbox's native network flag and defaults to disabled. `read` and `auto`
are refused because this cut has no second honest policy mapping for them. Its
resumable coordinate is the native thread id; its answered history id is the
completed native turn id, and native fork is `thread/fork` at that exact pair.
The frozen `config` object is supplied to native thread start/resume.
Each app-server instance is a detached helper process tree. Drive completion
awaits termination of that complete tree, so provider descendants cannot outlive
the body turn or leave an answered Akuma headless.

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
