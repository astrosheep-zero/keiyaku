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

Live tell exists only when the adapter's acknowledgement is its strongest
terminal native evidence or a receipt stream can supply that evidence. A provider
that can only queue or submit carries pending text into a later launch instead.
Missing receipt evidence remains missing; adapters and Body do not synthesize it.
An adapter without resume starts fresh only when no durable native resume promise
exists. An adapter without fork offers no emulation or capability registry.

## Narration And Admission

Adapters translate native events into bounded provider-neutral narration, drop
raw payloads, deltas, raw thinking, usage telemetry, and unsupported detail, and
preserve unknown kinds as bounded unknown narration. Activity is execution
history only: deleting retained activity never changes recovery, resume, fork,
outcome, failure, or life. Complete answers and native fork coordinates remain
Turn authority; sessions remain resume authority.

Provider context compaction is retained as bounded narration when the native
adapter reports it. Compaction is execution housekeeping, not a Turn failure,
retry, or lifecycle transition; a compaction error may be narrated separately
when the provider supplies an error detail.

Option admission happens once before identity allocation. Readonly realization
is an adapter fact, not a generic promise; unsupported enforcement remains an
honest admitted gap. Prompt and structured-answer changes apply only when the
provider begins a new Turn, never as live-tell mutation. Historical persisted
options retain their former interpretation and are never rewritten.

Each drive receives the one Body Request channel as provider transport setup.
This does not alter Library routing or permit recursive service. New provider
behavior must fit an existing provider-neutral capability or receive a new owner
ruling; there is no dialect passthrough, generic extension bag, or second
provider protocol.
