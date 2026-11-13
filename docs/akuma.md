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

Caller-selected additional writable directories are explicit birth-time filesystem
roots. Admission requires existing canonical directories before allocating a
child and deduplicates them. Only a provider with a verified native mapping
accepts nonempty roots. The admitted native recipe retains the roots across wake
and fork;
source definitions and shared Settings never change. No directory is granted
automatically, and adding roots never selects a broader sandbox mode or network
policy.

Life is derived solely from leash and latest Heart evidence. A live Body is
running; an explicitly completed one is asleep; an unsuccessful one is stranded;
a witnessed stop is killed only while that Body remains latest. Free leash with
no clean end is untidy, not permission to signal a described process. `hung`
requires the latest Body's durable proof that its owned provider custody could
not retire; it permanently refuses same-identity succession even after physical
leash release. A later body may supersede untidy history but never hung history.
Stopping a Body preserves Soul, sessions, history, and pending tells.

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
kills an Akuma, and a failure in one candidate never affects another candidate
or the operation that triggered the pass. If no later successful spawn or fork
occurs, eligible entries simply remain.

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

An akumaName definition may name one `base` definition at load time. The base is resolved
using the same project-over-Home precedence, then the child is merged into one
complete snapshot before catalog presentation or birth. Provider, model,
effort, network, and description are replaced only when present on the child;
otherwise the base value remains. A nonempty child body replaces the base body,
while an empty body inherits it. The resolved base relation is not part of
AkuId, Soul, Heart, Dispatch, or any public spawn input, and later file edits
affect only future loads.

An explicit base is never silently ignored. Missing or malformed bases,
invalid inherited data, repeated or cyclic chains, and a final snapshot without
a provider refuse before allocation. Refusals identify the reference chain
and the paths searched.

All worktrees of one repository share one Akuma World, roster, Alias authority,
and Heart storage. Soul cwd is execution input, not World identity. Contract
association never supplies that input: an explicit execution directory wins,
and otherwise the effective invocation directory stands. Akuma state lives in
the World rather than a Contract worktree, so ordinary worktree cleanup cannot
erase it. Home supplies akumaName configuration only, never runtime authority.
The accepted risk of force-cleaning repository-local management state is not
hidden by a second store or automatic defense.

A disposable World-local lineage record may cache each born Akuma's frozen
caller edge beside Heart custody, so a caller-scoped roster need not open every
Heart to learn known edges. It stores no identity or lifecycle fact of its own, is reconstructible from Hearts alone, and is never a second
authority: an offered edge only proposes a candidate, and every returned
member's caller chain is rechecked against its born Souls before that member is
accepted. Any disagreement discards the record for an answer built from direct
Soul evidence rather than an empty result. A record row whose Akuma directory no
longer exists is pruned before the closure and never resurrects an identity.
Pruning that record never deletes Heart or Akuma data, and confirmed World reset
removes it with the rest of known Akuma custody.

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
