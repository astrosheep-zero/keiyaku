# Akuma

An Akuma is a summoned agent the flagship can call, observe, steer, and collect.
This chapter owns its identity, birth, life, Archetype admission, placement, and
execution/provider boundary. Processes come and go; the Heart remains its
durable authority.

## Identity, Birth, And Life

An Akuma has one complete public identity in the Akuma family defined by
[model.md](model.md). Archetype names are bounded canonical human identity
segments; Alias uses the same name admission. The bound applies to new names,
not the readability of existing identities. Physical topology is its private
structural projection, not a second identity. Atomic allocation prevents reuse; an occupied or sealed
coordinate is never adopted as a different Akuma.

Soul is the immutable birth snapshot: identity, admitted Archetype/provider
recipe, execution cwd, origin, and effective permissions. A
Body is the one live driver, holding the exclusive leash for its lifetime. The
leash is the sole execution-seat and liveness authority; Heart owns durable
facts. Live process custody is a handle held by the spawning Body or adapter,
never a persisted process description. No successor reconstructs its
predecessor's process authority.

Birth becomes visible only when the child proves Soul under the leash. Failure
before Soul seals the coordinate with durable birth evidence. An uncertain or crashed birth remains unborn until a contender pays the same leash judgment; age never decides it. A seal is permanent: stillborn cannot be reborn. Caller
cancellation asks the publication owner to close only its retained unborn child;
it cannot invent a third birth result. No blind cleaner adjudicates abandoned
births.

Publication ends process custody by writing a durable verdict — Soul proves birth, a Seal under the leash proves failure — or by leaving the unborn child to leash judgment when the leash is unavailable; proven exit is welcome evidence but never a custody precondition, and a termination or exit error by itself changes nothing durable.

A direct call and a requested call served by its parent share one lower birth
authority. The initiating caller's admitted provider recipe, execution directory,
and first Tell are retained as caller intent: the serving parent admits provider
input itself but never reloads Settings or an Archetype, and never reinterprets
that intent. Provider input is admitted once before any child exists, so a refused
recipe leaves no child; a requested child is reserved before it is published.
Confirmed birth is never replaced by a later stage's failure: a spawn or
first-Tell failure after Soul carries the born child together with its native
failure, and caller cancellation never discards a confirmed child or an exact
admitted Tell. Only a birth that never proved Soul is a failed birth.

Life is derived solely from leash and latest Heart evidence. A live Body is
running; an explicitly completed one is asleep; an unsuccessful one is stranded;
a witnessed stop is killed only while that Body remains latest. Free leash with
no clean end is untidy, not permission to signal a described process. `hung`
requires the latest Body's durable proof that its owned provider custody could
not retire; it permanently refuses same-identity succession even after physical
leash release. A later body may supersede untidy history but never hung history.
Stopping a Body preserves Soul, sessions, history, pending tells, and requests.

## Archetype And Placement

An Archetype is call-time personality and provider configuration. Publicly these are Akuma names; the word Archetype never appears on the CLI face. Its exact
Markdown grammar is edge detail; admission rejects malformed, unknown, or
unsupported provider input before allocation. Later Archetype or Settings edits
change only future births. A definition file joins the catalogue exactly when
its stem is one canonical name under [model.md](model.md); when the spelling
rule widens, previously inadmissible files become live Archetypes unchanged. A missing native resume promise never authorizes
reconstructing one.

Archetype definitions may come from both the current project and Home. A
project definition shadows a Home definition with the same canonical name;
Home remains the fallback when the project has no definition. This precedence
applies only to call-time definition configuration and never changes World
runtime custody, Heart evidence, or leash ownership.

An Archetype may name one `base` Archetype at load time. The base is resolved
using the same project-over-Home precedence, then the child is merged into one
complete snapshot before catalog presentation or birth. Provider, model,
effort, network, and description are replaced only when present on the child;
otherwise the base value remains. A nonempty child body replaces the base body,
while an empty body inherits it. The resolved base relation is not part of
AkuId, Soul, Heart, Dispatch, or any public call input, and later file edits
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
erase it. Home supplies Archetype configuration only, never runtime authority.
The accepted risk of force-cleaning repository-local management state is not
hidden by a second store or automatic defense.

Confirmed World reset stops and retains each recognized Akuma's leash through
deletion of its known custody. It removes only known management material and
preserves unknown bytes; unsupported historical Hearts remain reset custody but
are not opened through current Heart interpretation. Failure to prove stop or
complete deletion retains custody for retry.

## Dependency Direction

One lower Akuma owner implements creation, admission, observation, and
lifecycle. The standalone identity handle, plural selection, and the Body
Request service are thin faces over those same algorithms rather than parallel
orchestrators. That owner reads only Heart, leash, provider, Archetype,
Settings, and filesystem state; optional Alias, Dispatch, Task, and Contract
associations are composed after its values by the World composition that owns
them, so a standalone operation still works when those optional authorities are
corrupt or unavailable. Its roster supplies native membership, semantic
activity order, and observed extent, and the upper composition attaches Alias
context without counting or reopening the board.

The public surface composes identity, Archetype, Heart, Body, provider,
Requests, publication, and Settings. Body drives providers and writes typed
Heart facts. Request service composes Heart, identity, provider recipe, and
publication. Provider adapters depend on the provider-neutral boundary, never
on public or lifecycle projections. Kanshi consumes public values only.
