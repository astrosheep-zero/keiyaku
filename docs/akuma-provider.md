# Akuma Provider Boundary

This chapter owns the provider-neutral execution boundary and native adapter
obligations. Provider recipes preserve opaque adapter configuration; only the
selected adapter may accept, refuse, or interpret it. Provider dialects, SDK
methods, command lines, and event fields are implementation evidence, not law.

## Attempt Custody

Start, resume, and fork create one synchronous attempt owner before native setup
begins. The attempt owns every resource it creates, including resources arriving
after cancellation, and exposes one eventual result, graceful abort, forced
disposal, and mandatory closure proof. Closure succeeds only after all owned
children or native sessions retire; cleanup failure remains visible. The Body
signal is notification, never a custody key or proof. No pid, host, registry,
or reconstructed OS identity crosses this boundary.

An admitted Session has one native execution. It supplies provider narration and
one terminal result, with optional resume, fork, live tell, and receipt
capabilities. Provider completion settles a Turn once; narration cannot create
another outcome. Provider fences correlate submissions only within the admitted
Turn and remain opaque outside this boundary. Providers never return product
identities; Body supplies Heart correlation and is the sole writer of Heart
facts.

Live tell exists when the adapter can prove native admission into the active
session. An exact native enqueue broadcast is sufficient terminal delivery
evidence; delivery does not promise model consumption or obedience. Mere
submission or transport acknowledgement without native admission is not a
receipt. Stronger native receipts remain authoritative where available. A
provider without native admission evidence carries pending text into a later
launch instead. Missing receipt evidence remains missing; adapters and Body do
not synthesize it.
An adapter without resume starts fresh only when no durable native resume promise
exists. An adapter without fork offers no emulation or capability registry.

## Headless Permission Baseline

An opencode-sdk spawn is headless: no channel can answer a native permission
ask, so an unanswered ask never settles, its tool call stays running, and the
Turn never resolves. Every spawn therefore composes a base permission layer
before the native server starts, making a human-reply wait impossible by
construction rather than by caller-configuration luck.

The baseline resolves to allow every action permission whose native default can
ask for a human decision — external-directory access outside the worktree,
continuation after repeated identical failures, and reads the native defaults
gate behind an ask — and refuses the question tool, whose Turn then fails fast
instead of waiting for an answer that cannot come. The class list is evidence
from the installed opencode version, not a stored schema: in 1.18.33 the primary
agents begin from an allow-all rule with `external_directory` and `doom_loop`
set to ask, `read` set to ask for env files, and `question` allowed by the
tool's awaiting semantics; every other class matches the allow-all rule and
cannot await. A provider version bump re-opens the list.

Explicit settings keep per-key precedence: a caller permission key replaces the
baseline class it names, so a project may narrow — a project-root whitelist, or
re-enabling the question tool — through its own settings. The baseline only
fills classes the caller leaves unspecified, and non-permission configuration
passes through untouched. An execution environment layer may replace the whole
composed config variable; that remains the documented escape hatch.

## Narration And Admission

Adapters translate native events into bounded provider-neutral narration, using typed construction rather than decoding their own trusted neutral values. The neutral structural declaration belongs to Heart; provider code owns only native dialect adaptation and capability meaning.

Adapters drop raw payloads, deltas, raw thinking, usage telemetry, and unsupported detail, and
preserve unknown kinds as bounded unknown narration. Activity is execution
history only: deleting retained activity never changes recovery, resume, fork,
outcome, failure, or life. Complete answers and native fork coordinates remain
Turn authority; sessions remain resume authority.

A generic native tool invocation may contribute one bounded compact preview of
the structured arguments it actually supplied. That preview is narration, not
execution authority: it never carries tool output, results, deltas, or a raw
native envelope, and it preserves the supplied values, types, and order without
fabricating defaults. Supplied arguments that exceed the narration bound keep an
explicit truncation fact cut at a complete code-point boundary. Missing
arguments stay absent, and explicitly empty arguments remain distinguishable
from absence rather than collapsing into it. An acknowledging or completion
event reuses the preview its correlated start admitted; an adapter whose native
protocol supplies no structured invocation arguments keeps a name-only
fallback. Existing known structural tool normalization is unchanged, and old
name-only narration keeps its former presentation.

Provider context compaction is retained as bounded narration when the native
adapter reports it. Compaction is execution housekeeping, not a Turn failure,
retry, or lifecycle transition; a compaction error may be narrated separately
when the provider supplies an error detail.

Option admission happens once before identity allocation. Prompt and
structured-answer changes apply only when the provider begins a new Turn,
never as live-tell mutation. Persisted records are not rewritten during option
admission.
Where an agent offers session configuration selectors, the adapter applies
admitted model and effort choices before the first prompt of each new or
resumed native session. Missing choices and unconfirmed selections fail that
attempt rather than silently running with the agent's default.

Each drive receives the one Body Request channel as provider transport setup.
This does not alter Library routing or permit recursive service. New provider
behavior must fit an existing provider-neutral capability or receive a new owner
ruling; there is no dialect passthrough, generic extension bag, or second
provider protocol.
