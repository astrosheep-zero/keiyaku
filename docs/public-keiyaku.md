# Invocation Facet

`Keiyaku` composes independent product surfaces for a caller that has an
invocation directory and environment rather than resolved product coordinates.
It captures those explicit inputs without observing the filesystem or reading
ambient process state. Each operation resolves its invocation scope anew; the
facet keeps no persistent authority, observation cache, or separate result model.
Its operations return native owner values and preserve owner refusal, retry,
cancellation, and observation semantics. A single described verb surface offers
both typed methods and generic execution over the same caller boundary. The
facet also owns the shared interpretation of returned and thrown outcomes for
adapters; this classification does not replace or alter the native answer.
Structural descriptions expose wire inputs and owner result and progress schemas
without validating trusted owner values as they flow through execution. Every
described verb's output type is its producing owner's schema output; native
process-local capabilities stay outside that wire description. Each result uses
the native owner's single object answer. Invocation context can
accompany text rendering without being echoed in that answer, and adapters
consume the owner's outcome judgment rather than reconstructing authority from
omitted implementation evidence.

MCP publishes the facet's operations subject to the administration and raw-import
exclusion owned by [cli.md](cli.md). It publishes an owner's object-rooted output
schema when a caller reads the result to choose its next call; other tools return
rendered text. An alternative that cannot describe an object is a programmer
error for a tool publishing a schema. Error results are text led by their
classification. An unsatisfied verification verdict is an answered negative,
distinct from an operation failure, and is not a transport error. Published names are safe
for model APIs and are the only callable transport names. Read-only annotations
identify reads; destructive annotations identify destruction alone, not ordinary
writes.

Delivery has one invocation intent, with an explicit read-only observation mode.
The facet validates incompatible observation and mutation intents before resolving
coordinates or observing any product, then selects exactly one native owner.
Observation uses the dedicated Contract preview operation; submission uses native
delivery admission. Both return their existing native answers without an envelope,
and the selected mode supplies presentation context without becoming authority.

The invocation World is distinct from an explicitly selected Contract Repo:
selecting a Repo never retargets the World. The facet adapts caller-supplied
coordinates, Contract selection, and environment-derived actor, caller, and
initiator attribution. These declarations are not authentication. Akuma
execution directories remain independent of Contract association. Product
surfaces neither depend on the facet nor require it to operate.

Ambiguous native harness caller declarations are refused rather than guessed.
The diagnostic names every conflicting environment variable so the caller can
identify the competing declarations without disclosing their values.

Debt invocation resolves the caller's World independently of a selected Repo.
Every Debt catalogue covers that World's flat ledger. Creation alone
derives actor testimony and establishes a missing World.
Debt reads retain native absence and refusal distinctions; listing defaults to
open work.

Each list and status operation selects one producing owner before observation.
World status is a fixed composite observation; an addressed status accepts one
complete identity of its own family and preserves that owner's missing and failed
observations. Catalogues distinguish Contract instances, Akuma instances, and
Archetype definitions; Debt listing invokes its native list owner directly.
Lifecycle selection precedes the bound, preserving the owner's
order and remainder judgment. There is no
cross-family catalogue, category status, or plural status result. A named CLI
address is acquired at the asynchronous process edge, then dispatched as the
resolved family's ordinary exact operation. A Contract wait and an Akuma wait
remain separate and a mixed wait is refused before observation. History selects
one subject. A caller-input error is distinguishable from an owner refusal or
an unexpected failure, and adds no authority to the facet.
