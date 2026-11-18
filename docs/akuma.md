# Akuma

An Akuma is a summoned agent the flagship can spawn, observe, steer, and collect.
This chapter owns its identity, birth, life, akumaName admission, placement, and
execution/provider boundary. Processes come and go; the Heart remains its
durable authority.

Heart owns durable facts; each product owner judges its own operation legality.
Keiyaku has no separate product-action permission authority. Native provider
sandbox, headless, filesystem, and network policy remain with the provider
boundary.

## Identity, Birth, And Life

An Akuma has one complete public identity in the Akuma family defined by
[model.md](model.md). akumaName names are bounded canonical human identity
segments; Alias uses the same name admission. The bound applies to new names,
not the readability of existing identities. Physical topology is its private
structural projection, not a second identity. Atomic allocation prevents reuse; an occupied or sealed
coordinate is never adopted as a different Akuma. Complete native input
validation precedes allocation. A bounded observer may know the allocated
coordinate before birth so it can suppress duplicate notifications, but only the
ordinary birth owner initializes and publishes that same child. Cancellation or
failure preserves the allocation's existing leash and seal judgment; observation
never adopts, reuses, or silently recreates it.

Soul is the immutable birth snapshot: identity, admitted akumaName/provider
recipe, execution cwd, origin, optional declared caller, and the choice to omit
Keiyaku execution instructions. That opt-out changes
neither personality nor capabilities and remains frozen across wake and resume.
Caller attribution is independent of origin and fork lineage. It names either
an Akuma in its World or an external integration identity; absence is legal
for both existing and new births. Attribution is not authentication and never
changes Contract testimony or admission authority. A
Body is the one live driver, holding the exclusive leash for its lifetime. The
leash is the sole execution-seat and liveness authority; Heart owns durable
facts. Live process custody is a handle held by the spawning Body or adapter,
never a persisted process description. No successor reconstructs its
predecessor's process authority.

Birth becomes visible only when the child proves Soul under the leash. Failure
before Soul seals the coordinate with durable birth evidence. An uncertain or
crashed birth remains unborn until a contender pays the same leash judgment; age
never decides it. A present Heart that cannot be read is a hard observation
failure, not evidence that the Akuma is unborn. A seal is permanent: stillborn
cannot be reborn. Caller
cancellation asks the publication owner to close only its retained unborn child;
it cannot invent a third birth result. No blind cleaner adjudicates abandoned
births.

Publication ends process custody by writing a durable verdict — Soul proves birth, a Seal under the leash proves failure — or by leaving the unborn child to leash judgment when the leash is unavailable; proven exit is welcome evidence but never a custody precondition, and a termination or exit error by itself changes nothing durable.

Provider input is admitted once before any child exists, so a refused recipe
leaves no child. Confirmed birth is never replaced by a later stage's failure: a
spawn or first-Tell failure after Soul carries the born child together with its
native failure, and caller cancellation never discards a confirmed child or an
exact admitted Tell. Only a birth that never proved Soul is a failed birth.

Filesystem policy belongs to the selected provider's native configuration.
Explicit provider configuration remains part of the frozen birth recipe across
wake and fork; later definitions or Settings changes affect future births only.
This recipe does not snapshot native defaults or external configuration files.
Existing retained provider configuration remains ordinary configuration, without
provenance inference or rewriting.

Life is derived solely from leash and latest Heart evidence. A live Body is
running; an explicitly completed one is asleep; an unsuccessful one is stranded;
a witnessed stop is killed only while that Body remains latest. Free leash with
no clean end is untidy, not permission to signal a described process. `hung`
requires the latest Body's durable proof that its owned provider custody could
not retire; it permanently refuses same-identity succession even after physical
leash release. A later body may supersede untidy history but never hung history.
Stopping a Body preserves Soul, sessions, history, and pending tells.

Catalogue classification is independent of whether an observation can finish:
running, unborn, stranded, hung, and untidy Akumas are active, still in play;
asleep, killed, and stillborn Akumas are settled, at rest. Stuck execution remains
active rather than disappearing from the flagship's unresolved work. This
classification changes neither life evidence nor succession or retention judgment.

## Inactive Retention

The default retention age for an inactive Akuma is fifteen days. No setting,
command, timer, daemon, persisted schedule, or new lifecycle state introduces
it. Semantic age is the later durable life or activity instant already retained
by Heart, never directory metadata; a missing or unreadable instant never proves
staleness. Unborn and stillborn allocations are outside this policy.

Only a born, readable, stopped entry can be retired. A held execution seat, an
admitted pending Tell, a current Alias binding, or a Dispatch association whose
Contract is not terminal keeps the Akuma. A Contract in `claimed` or `abandoned`
is terminal; every other phase, a missing Contract, and any failed, corrupt, or
unavailable Git, Dispatch, or Contract observation keep the candidate.
Unrecognized bytes and noncanonical run directories are never adopted or
removed.

Before removal, the final judgment holds the Alias authority lock and, in a Git
World, the same private-state publication seat Dispatch publication uses. Alias
and Dispatch observations are read under that custody and removal happens
before it is released, so a new reference cannot commit between the final
judgment and deletion. The last step under that custody re-reads Heart: an
admitted pending Tell, a changed life, or a changed age retains the entry. Tell
admission does not take that cross-authority custody, so a Tell observed by the
final read is preserved while an admission immediately after it is a documented
best-effort boundary rather than an atomic guarantee. A busy authority also
retains the candidate. Dispatch and Contract observation uses the World's Git
repository; a World without one has no Dispatch authority.

Retention is a best-effort maintenance pass triggered only after a successful
spawn or fork has made its new Akuma durable. It runs outside the birth
transaction and never changes, rolls back, or replaces that birth result. List,
status, history, wait, tell, ask, and every other observation path never retire
bytes. One sweep removes only recognized per-entry custody, never signals or
kills an execution process, and a candidate failure never affects another
candidate or the operation that triggered the pass. Without a later successful
spawn or fork, eligible entries simply remain. Only positively confirmed inactive
retirement supplies an optional retirement observation. It is not inferred from
Body settlement, kill, a missing World, or failed input, and failure to notify
neither restores nor changes Akuma custody.

## akumaName And Placement

An akumaName definition is spawn-time personality and provider configuration. Public callers select it as `akumaName`; no second configuration vocabulary appears on the CLI, SDK, or MCP face. Its exact
Markdown grammar is edge detail; admission rejects malformed, unknown, or
unsupported provider input before allocation. Later definition or Settings edits
change only future births. A definition file joins the catalogue exactly when
its stem is one canonical name under [model.md](model.md); when the spelling
rule widens, previously inadmissible files become live akumaName definitions unchanged. A missing native resume promise never authorizes
reconstructing one.

akumaName definitions are configuration kept apart from World runtime custody.
Project definitions are eligible for version control. Definitions may come from
both the current project and Home. A project definition shadows a Home definition
with the same canonical name; Home remains the fallback when the project has no
definition. This precedence applies only to spawn-time definition configuration
and never changes World runtime custody, Heart evidence, or leash ownership.

An akumaName definition may inherit from one base. A project definition looks
for its base in the project first, then Home. A Home definition can only inherit
from Home, even when a project definition reached it by fallback. Both listing
and birth resolve this relation the same way. Explicit child selections override
inherited values; an empty child body inherits both the personality and its
prompt mode, while any nonempty body, including whitespace, supplies both anew.
The base relation is not itself a durable fact of the Akuma or a public spawn
input. Later file edits affect only future loads.

An explicit base is never silently ignored. Missing or malformed bases,
invalid inherited data, a repeated name anywhere in the chain even across
scopes, and a resolved definition without a provider refuse before allocation.
Definition failures distinguish absence from invalid or unreadable material,
identifying the failing name, relevant paths, and full base chain when one is
involved. Invalid authorship reports an actionable reason and preserves the
underlying failure when available.

All worktrees of one repository share one Akuma World, roster, Alias authority,
and Heart storage. Soul cwd is execution input, not World identity. Contract
association never supplies that input: an explicit execution directory wins,
and otherwise the effective invocation directory stands. Akuma state lives in
the World rather than a Contract worktree, so ordinary worktree cleanup cannot
erase it. Home supplies akumaName configuration only, never runtime authority.
The accepted risk of force-cleaning repository-local management state is not
hidden by a second store or automatic defense.

Caller ancestry is observed directly from frozen Souls for the answer that needs
it; no persistent lineage record stands beside Heart custody. A caller-scoped
answer therefore costs one Soul observation per recognized identity in its World,
and no file timestamp or stored edge substitutes for that evidence. An absent
Soul is unborn evidence, an unreadable Soul is uncertainty rather than absence,
and a readable downstream edge cannot bridge an unreadable one above it. The
observation neither repairs nor rewrites Heart or Soul bytes. Confirmed World
reset still recognizes the retired lineage-record file names as known custody
and removes them with the rest of known Akuma custody; unknown bytes remain
foreign.

Confirmed World reset stops and retains each recognized Akuma's leash through
deletion of its known custody. It removes only known management material and
preserves unknown bytes; unsupported historical Hearts remain reset custody but
are not opened through current Heart interpretation. Failure to prove stop or
complete deletion retains custody for retry.

## Dependency Direction

One Akuma owner implements creation, admission, observation, and lifecycle. The
standalone identity handle and plural selection are faces over those same
algorithms rather than parallel orchestrators. That owner reads only Heart, leash, provider, akumaName,
Settings, and filesystem state; optional Alias, Dispatch, and Contract
associations are composed after its values by the World composition that owns
them, so a standalone operation still works when those optional authorities are
corrupt or unavailable. Its roster supplies native membership, semantic
activity order, and observed extent, and the upper composition attaches Alias
context without counting or reopening the board.

The public surface composes identity, akumaName, Heart, Body, provider,
publication, and Settings. Body drives providers and writes typed Heart facts. Provider adapters depend on the provider-neutral boundary, never
on public or lifecycle projections. Kanshi consumes public values only.
Inactive retirement follows the same split: the Akuma owner reads Heart, leash,
and filesystem state and removes recognized custody, while the World
composition supplies Alias and read-only Dispatch and Contract associations.
