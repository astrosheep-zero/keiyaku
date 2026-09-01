# Akuma

An Akuma is a summoned agent the flagship can call, observe, steer, and collect.
This chapter owns its identity, birth, life, Archetype admission, placement, and
execution/provider boundary. Processes come and go; the Heart remains its
durable authority.

## Identity, Birth, And Life

An Akuma has one complete public identity in the Akuma family defined by
[model.md](model.md). Physical topology is its private structural projection,
not a second identity. Atomic allocation prevents reuse; an occupied or sealed
coordinate is never adopted as a different Akuma.

Soul is the immutable birth snapshot: identity, admitted Archetype/provider
recipe, execution cwd, origin, frozen restraint, and effective permissions. A
Body is the one live driver, holding the exclusive leash for its lifetime. The
leash is the sole execution-seat and liveness authority; Heart owns durable
facts. Live process custody is a handle held by the spawning Body or adapter,
never a persisted process description. No successor reconstructs its
predecessor's process authority.

Birth becomes visible only when the child proves Soul under the leash. Failure
before Soul seals the coordinate with durable birth evidence. An uncertain or
crashed birth remains unborn until a contender pays the same leash judgment;
age never decides it. A seal is permanent: stillborn cannot be reborn. Caller
cancellation asks the publication owner to close only its retained unborn child;
it cannot invent a third birth result. No blind cleaner adjudicates abandoned
births.

Publication releases process custody only after the child has retired and the retained leash has proved Soul or permanent Seal; a termination or exit error is evidence to adjudicate, never a reason to wait forever or release blindly.

Life is derived solely from leash and latest Heart evidence. A live Body is
running; an explicitly completed one is asleep; an unsuccessful one is stranded;
a witnessed stop is killed only while that Body remains latest. Free leash with
no clean end is untidy, not permission to signal a described process. `hung`
requires the latest Body's durable proof that its owned provider custody could
not retire; it permanently refuses same-identity succession even after physical
leash release. A later body may supersede untidy history but never hung history.
Stopping a Body preserves Soul, sessions, history, pending tells, and requests.

## Archetype And Placement

An Archetype is call-time personality and provider configuration. Its exact
Markdown grammar is edge detail; admission rejects malformed, unknown, or
unsupported provider input before allocation. The selected provider alone judges
its opaque configuration and realization of readonly restraint. Readonly only
adds a frozen birth restriction; it can never be loosened or toggled later.
Later Archetype or Settings edits affect only future births. A missing native
resume promise never authorizes reconstructing one.

Archetype definitions may come from both the current project and Home. A
project definition shadows a Home definition with the same canonical name;
Home remains the fallback when the project has no definition. This precedence
applies only to call-time definition configuration and never changes World
runtime custody, Heart evidence, or leash ownership.

All worktrees of one repository share one Akuma World, fleet, Alias authority,
and Heart storage. Soul cwd is execution input, not World identity. Akuma state
lives in the World rather than a Contract worktree, so ordinary worktree cleanup
cannot erase it. Home supplies Archetype configuration only, never runtime
authority. The accepted risk of force-cleaning repository-local management
state is not hidden by a second store or automatic defense.

Confirmed World reset stops and retains each recognized Akuma's leash through
deletion of its known custody. It removes only known management material and
preserves unknown bytes; unsupported historical Hearts remain reset custody but
are not opened through current Heart interpretation. Failure to prove stop or
complete deletion retains custody for retry.

## Dependency Direction

The public surface composes identity, Archetype, Heart, Body, provider,
Requests, publication, and Settings. Body drives providers and writes typed
Heart facts. Request service composes Heart, identity, provider recipe, and
publication. Provider adapters depend on the provider-neutral boundary, never
on public or lifecycle projections. Kanshi consumes public values only.
