# Contract Workspace

This chapter owns the Contract-facing derived files in a managed worktree: local
appointment, guidance, ignore protection, and the handoff to terminal cleanup.
Git owns worktree topology and reconciliation. The journal remains the sole
Contract authority.

## Guidance

Guidance is one canonical, read-only projection of the admitted Contract terms
and current arc. It identifies itself as derived, keeps the source terms intact,
and states the appointed Deliverer or Reviewer responsibilities without choosing
a seat or changing Contract acceptance. Every guidance reader and managed
worktree uses these same bytes, so a display, library read, and materialized
workspace cannot diverge.

Derived guidance reserves its own document space from caller extensions. It
does not make harness identity, worker identity, selected seat, or skill
procedure into a Contract or Dispatch fact. Skills can give operating procedure
but cannot amend Contract terms or gain acceptance authority. Guidance is a
projection, not an audit result or an alternate lifecycle surface.

## Managed Place

Place is the sole durable local appointment for a managed Contract worktree. It
is neither a Git identity, a journal field, nor a second product. The workspace
owner maintains one canonical appointment register and its coordination boundary;
the register gives each Contract at most one current Place and allows each Place
to serve at most one Contract. Its allocation is deterministic and stable once
written. Derived lookup indexes, filesystem occupancy, Git registration, and
guidance do not replace that authority.

Writers serialize a fresh read and durable replacement; corrupt or unavailable state is an appointment failure. Only active Contracts receive missing appointments; terminal ones retain an existing Place for cleanup.

After admission, composition appoints before Git realizes the worktree and retries use that Place. Release waits for Git to prove the path absent; failures retain the appointment, so no reusable Place hides managed bytes. Bind returns the appointed path, and target lag identifies that worktree subject.

## Derived Files And Cleanup

The workspace owner atomically creates or repairs its guidance, namespace
context, and narrow local ignore protection after an active managed worktree
exists. These files keep derived management material out of ordinary status and
delivery capture without hiding project-owned data. Namespace context is the
Contract-derived coordinate for active Task work; a valid local override remains
intact. The complete Contract coordinate is split into segments, so `kei/<slug>`
provides Task namespace `kei/<slug>` and identities under `task/kei/<slug>/...`.
Terminal Contracts never receive a new active context projection. A tracked
generated location is a failure. A recognized user-owned skill leaf remains
untouched; static seat skills contain procedure only, while Contract and arc
facts remain in canonical guidance.

All workspace reads, writes, protection, and cleanup are awaited. There is no
synchronous appointment surface or deferred cleanup queue. A derived-file
failure is a typed post-admission lag and preserves accepted facts and completed
Git effects. Git reconciliation does not parse guidance or invoke a projection
callback; it completes Git effects first, then active workspace projection runs
as the separate owner step. Terminal cleanup runs after the settlement
opportunity and may remove the managed worktree, including its active-only
derived context. Terminal byte custody and recovery remain owned by
[git-reconciliation.md](git-reconciliation.md).
