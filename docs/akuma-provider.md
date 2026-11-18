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
children or native sessions retire, including resources owned by their loaded
extensions. An adapter attached to an externally hosted persistent runtime owns
its connection and execution-control obligation, not the retained runtime.
Normal completion retires only that connection. Explicit control cancels the
runtime's current execution without archiving, deleting, or closing the runtime;
this may affect concurrent human execution where native control is session-wide.
Connection closure proves only owned client retirement, never retained runtime
closure. A native client's logical disposal is not physical connection retirement:
the adapter observes closure of the connections it created, including during
cancelled setup, and preserves failures hidden by native cleanup. An inert native
setup promise is not live custody. Cancellation prevents later setup or submission
without making that promise a closure precondition. A failed cancellation or
client retirement remains visible independently of the Turn result.
Native shutdown hooks finish before an owned session is disposed, and
in-flight extension setup must finish before that retirement can prove closure.
Exact native terminal evidence settles the Turn without waiting for retirement.
Cleanup cannot revise that outcome, and a failed or unproven retirement
independently prevents ordinary Body completion. The Body signal is
notification, never a custody key or proof. No pid, host, registry,
or reconstructed OS identity crosses this boundary.

An admitted Session has one native execution. It supplies provider narration and
one terminal result, with optional resume, fork, live tell, and receipt
capabilities. Provider completion settles a Turn once; narration cannot create
another outcome. Provider fences correlate submissions only within the admitted
Turn and remain opaque outside this boundary. Providers never return product
identities; Body supplies Heart correlation and is the sole writer of Heart
facts.

Live tell exists when the adapter can prove exact native admission into the
active session. That proof is sufficient terminal delivery evidence; delivery
does not promise model consumption or obedience, and providers need not produce
a later consumption receipt. Queueing input, first yielding it, or receiving a
transport acknowledgement alone does not prove admission. If execution ends
before admission is witnessed, the input is not delivered; a later terminal
cannot retract admission already witnessed. A provider without native admission
evidence carries pending text into a later launch instead. Stronger native
receipts remain authoritative where available; previously recorded deliveries
that require them still do. Missing evidence remains missing; adapters and Body
do not synthesize it.
An adapter without resume starts fresh only when no durable native resume promise
exists. An adapter without fork offers no emulation or capability registry.

When a persistent native session has other writers, the adapter refuses an
observed busy session before starting its own prompt. A native send option that
may replace active work is not a guarantee of non-interruption. A remaining
check-to-send race is an upstream limitation, not exclusive execution custody;
the adapter never adds a second lease or claims protection it cannot prove.
Canonical native admission correlates the adapter's submission to its exact
native turn. Only that turn's complete assistant messages and terminal evidence
can supply its answer or outcome; unrelated human input, idle status, or transport
acknowledgement cannot settle it. Live observation loss is an honest failure,
not permission to infer completion or replay. Normal completion never cancels
a later human turn.

The Paseo integration supports successive Bodies against a retained live native
runtime, not upstream native reload or restart. Such reload discards the creation
environment; an unchanged agent or native session identity is not proof that the
provider session identity remains valid. After native reload the caller must
create a fresh Akuma. This integration does not promise session continuity across
unsupported native reload. It adds
no registry, daemon, plugin, inferred retention proof, or automatic repair.

A born Akuma may name another Akuma as its direct caller. The optional Paseo
observer attaches that child beneath the parent's exact existing mirror only
when persisted provider identity proves the caller's canonical World and AkuId
and a fresh read confirms the same unarchived mirror. Titles, ancestry, cwd,
native sessions, and aliases do not establish parent identity. Missing,
ambiguous, archived, stale, or unreadable evidence leaves the child unattached
with a best-effort diagnostic and never changes Akuma birth. This observation
adds no identity registry, backfill, polling, retry queue, or execution, and
external-parent attachment remains unchanged.

The Paseo bridge uses the installed Keiyaku library in its plugin process and
requires the current public observation surface; it does not emulate missing
capabilities. A successfully loaded library remains in that process for its
lifetime. Upgrading Keiyaku therefore requires a Paseo plugin reload, not a
daemon restart: each plugin runs in its own forked child, and reload replaces
that child. This plugin reload is separate from the unsupported native runtime
reload above.

The optional Paseo mirror requires trustworthy observation windows and record
identity. An individual record it cannot interpret leaves observation visibly
incomplete while later trustworthy records remain observable. The skipped record
cannot establish or change execution state, and its payload is not retained in
the diagnostic. A broken observation boundary remains a read failure; neither
case authorizes inferred completion or automatic recovery.

The mirror acknowledges input admission separately from execution. Correlating a
new execution request requires a fresh observation proving delivery of that exact
input to an open Turn. Missing delivery evidence or an already-ended Turn leaves
admission acknowledged without choosing another execution. Older unclosed Turns
and unrelated input supply no substitute correlation. Steering an existing
execution retains its captured host Turn acknowledgement as presentation, not
proof of native delivery. Independently observed starts and outcomes remain
authoritative without invented settlement.

## Headless Permission Baseline

An opencode-sdk spawn is headless: no channel can answer a native permission
ask, so an unanswered ask never settles, its tool call stays running, and the
Turn never resolves. Every spawn therefore composes a base permission layer
before the native server starts, making a human-reply wait impossible by
construction rather than by caller-configuration luck.

The baseline allows external-directory access and environment-file reads that
native defaults otherwise gate behind a human decision. It refuses the question
tool, which must fail rather than wait for an answer that cannot come. The list
is verified against the installed native producer; a provider version change
re-opens that verification rather than inheriting an older version's defaults.

Caller rules keep precedence by action: an explicit caller policy for an action
replaces that action's baseline, while unspecified actions retain the headless
baseline. Non-permission configuration passes through untouched. A caller may
intentionally narrow access or re-enable a human-reply tool; the resulting wait
is then its explicit policy rather than an adapter default. An execution
environment layer may replace the composed configuration, preserving the same
escape hatch.

## Native Continuity And Options

Keiyaku execution instructions are generated at one shared execution boundary,
separate from the frozen akumaName personality. They identify the actual Akuma
and give concise progress-report guidance. New births receive this section by
default; the birth opt-out omits only this section. Ordinary native resume may
retain the immutable section without a hot-update capability. Already existing
native sessions without the section are not retrofitted and never refuse solely
for its absence. Optional Contract observation never becomes resume eligibility
or a cached association authority.

Adapters compose the section through verified native system or developer
instruction channels, never a user-message substitute. A native fork supplies
the child's current context rather than treating the source's historical
identity as current. A bare fork deactivates inherited execution context without
introducing identity or reporting guidance; a fresh bare execution adds nothing.
Native supersession may leave historical sections in the
transcript; history is not an additional active identity, and preserving it does
not disable fork. Unsupported native capabilities remain explicit; no adapter
silently discards requested context or invents a system channel.

The OpenCode adapter uses the matching native client and checks native readiness,
not a successful response from the server's web application. A private serve
carries the Body's actor through its native launch environment; an ordinary
configured local MCP process that does not author those reserved variables
inherits the current pair. Keiyaku does not parse, rewrite, or supplement
authored native configuration; effective
commands, unrelated configuration, and remote servers retain native semantics.
Its live event feed is volatile. A disconnect or stream failure ends observation
without reconnection, prompt replay, or an inferred answer. An observed foreign input
consumed during the same execution makes exact attribution unavailable; the
adapter fails rather than adopting that writer's answer.

A completed answer retains the exact native boundary immediately after that
answer for historical fork. This is a native coordinate, not a reconstructed
history: a later fork excludes that boundary and therefore includes the answer
without copying subsequent native work. The adapter verifies the native
boundary and refuses a changed or missing one rather than falling back to the
latest session.

Additional system instructions use native durable instruction context and remain
part of native resume and fork. The adapter does not pretend that this facility
replaces the native system prompt. A requested replacement or native structured
answer facility that the installed protocol cannot supply refuses explicitly;
no option is silently discarded or translated into an invented native promise.

## Narration And Admission

Adapters select a small set of execution observations directly from native events,
using typed construction rather than decoding their own trusted neutral values.
The neutral structural declaration belongs to Heart; provider code owns only
native dialect adaptation and capability meaning.

Narration preserves complete assistant messages, supported bounded thought
observations, observed tool execution and results, compaction, and actual
execution, extension, and hook diagnostics. Completed compaction has one concise
note; failures retain the observed cause. A retryable diagnostic does not itself
fail a Turn. Raw payloads, token deltas, usage telemetry, administrative notices,
plan prose, task status, retry progress prose, and unsupported kinds or content
are silent. Silence neither leaks unsupported payloads nor infers an outcome.
Ignored traffic does not split contiguous buffered narration; native answer
boundaries remain authoritative independently of which observations are narrated.

Activity is execution history only: deleting retained activity never changes
recovery, resume, fork, outcome, failure, or life. Existing retained activity
remains readable. Complete answers and native fork coordinates remain Turn
authority; sessions remain resume authority. Native session admission and terminal
interpretation remain independent of narration selection, as do model and
permission observations.

Slow consumers receive bounded disposable narration in arrival order. Saturation
drops the oldest ordinary narration, including notes, unknown kinds and failed
tool observations, without inferring priority from their wording. A separate
bounded loss observation counts dropped narration until consumed; it retains its
first loss position and precedes the narration that caused that loss. It never
claims a terminal outcome was lost. Provider completion and physical closure
remain independent authoritative evidence.

The latest unconsumed session, runtime-model and pending-approval observations
are independently reserved from narration capacity. A newer observation replaces
only its own earlier state, including an unnamed model or cleared approvals,
and is ordered at its replacement's arrival. Superseded intermediate state is
coalesced rather than counted as lost narration. These ephemeral buffers create
no durable facts: Body still admits consumed evidence through Heart.

Native permission requests and their replies produce one provider-neutral
observation of the attempt's currently pending approvals. It preserves native
request identity and the action, resources, and tool actually observed; a reply
removes only its matching request, and an empty observation clears the wait.
Adapters correlate this evidence to their admitted execution rather than
inferring a request from a busy session, a denial, or a running tool. This
observation grants no permission and promises no response capability. Its latest
bounded value supersedes an older unconsumed value, including when narration
overflows, so an obsolete ask cannot outlive an observed reply.

One runtime-model observation is provider-neutral and typed: the model an
attempt's own native evidence proves it is actually running. An adapter reports
the effective model its startup selected, the model named on a native response,
and an explicit switch or reroute when the native surface identifies the
replacement; a change whose replacement is unnamed reports that the attempt's
selection is no longer confirmed. Requested options, configured defaults, free
text, and any surface without a model identity are never treated as
confirmation. An adapter whose installed native protocol reports no model
identity leaves the runtime model unknown, and that unsupported reporting is a
precise limitation rather than a guess. Adapters only produce that observation:
Body admits it through Heart, where only the exact latest running Body may move
the Soul's one current model that every later Turn, resume, and fork reads. The
observation is never retained as activity and never becomes a second model
record. Bounded narration retention never displaces it, and a newer unconsumed
observation supersedes the obsolete one. An unnamed observation clears the
confirmation it replaces.

The optional Paseo mirror has no shared model catalog or inferred default. A
new or recreated mirror persists the exact model observed at creation time for
ordinary presentation. If that observation is missing or unreadable, the mirror
remains unknown and never borrows another model. Old persisted placeholders are
not retroactively repaired, and later observation makes no promise of live
model-change refresh.

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

Known structural tool normalization additionally preserves what the native
surface actually observed when a call finished: its result text and the patch
content of each file change it reported. That observation is narration, never
execution authority. It carries no raw native envelope and no delta stream, and
nothing reconstructs it from the working tree, from Git, or from proposed old and
new text; a native field without verified producer evidence stays absent and is
never synthesized. Observed content that exceeds the narration bound keeps an
explicit visible truncation fact cut at a complete code-point boundary, so a cut
diff cannot render as a complete one, and a value that was observed empty remains
distinguishable from one the native surface never supplied. Observed result text
is never the diagnostic clause a settled tool reports, and never enters the
compact board presentation that clause feeds.

Native extension load failures remain visible even when the native runtime can
continue without the failed extension. The adapter reports the native cause to
its diagnostic output and, once a Session is admitted, as bounded narration.
That diagnostic neither invents a failed Turn nor claims that the extension
loaded successfully; native setup and execution still own their outcomes.

Provider context compaction is retained as bounded narration when the native
adapter reports it. Compaction is execution housekeeping, not a Turn failure,
retry, or lifecycle transition; a compaction error may be narrated separately
when the provider supplies an error detail.

Native filesystem policy and configuration precedence belong to the selected
provider. Codex leaves authored configuration to the native loader; the
execution actor adds only the pair's forwarding names to already-configured
local stdio targets, leaving explicit environment entries authoritative.
Keiyaku adds no shared root admission, additive grant mapping, or pre-birth
sandbox probe.
Native execution judges configuration validity and enforcement, so setup may
fail after birth under ordinary execution semantics. The retained
recipe preserves explicit configuration, including previously retained policy,
without discovering or freezing external native defaults or files.

Configuration admission is owned by the selected adapter as one executable
declaration, not a shared provider configuration language. A refused
configuration is an invalid caller input whose diagnostic is the declaration's
own structured schema failure; that phrasing and the order of independent
checks are presentation, never a continuity promise. Admission neither trims
supplied values nor fabricates absent ones, and the admitted result stays
immutable. Admitting a mapping is not native acceptance: the adapter confirms
the native selection before the first prompt.

Option admission happens once before identity allocation. Prompt and
structured-answer changes apply only when the provider begins a new Turn,
never as live-tell mutation. Persisted records are not rewritten during option
admission. An adapter whose protocol has no separate structured-answer channel
carries the admitted schema in the Turn prompt instead of discarding it, while
an adapter that cannot honor an admitted option refuses explicitly.
Where an agent offers session configuration selectors, the adapter applies
admitted model and effort choices before the first prompt of each new or
resumed native session. Missing choices and unconfirmed selections fail that
attempt rather than silently running with the agent's default.

Each drive receives the Body's exact execution actor and World independently of
the host process environment. The pair identifies the canonical World and full
Akuma identity, never the execution directory, an Alias, a native session, or a
Turn recipient. A shared Pi host exposes the pair through a synchronous request
on the invoking session's own bus, before native tools run and only until that
session is disposed. No responder leaves the native caller unchanged. A private
single-actor launcher supplies the complete pair through its native environment
forwarding to its already configured local tool process; it does not install or
enable an MCP server. A shared native MCP server
needs positive correlation to the exact call, and a nested Claude agent
without its own proof never inherits the outer actor. No adapter records this
transport context as a Turn initiator or mutates process-global identity or
working directory. Native services and extension runtimes remain attempt-scoped;
arbitrary extensions that consult or mutate globals are not isolated by
in-process hosting. New provider
behavior must fit an existing provider-neutral capability or receive a new owner
ruling; there is no dialect passthrough, generic extension bag, or second
provider protocol.
