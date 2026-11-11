# CLI

`keiyaku` is the process edge. It turns an invocation and acquired caller input
into public product operations, then gives their typed result to the shared
renderer. It owns neither document interpretation, lifecycle judgment, Git
adjudication, verification, reconciliation, nor Debt or Akuma authority.

A standalone transport is another invocation edge, not another product surface.
It publishes the facet's operations except for an edge-owned exclusion of
administration, ledger diagnosis, and raw-document import, which remain available
through the CLI. Discovery observes or establishes no World,
and each call supplies explicit coordinates independently. Protocol validation,
connection lifetime, and cancellation remain at that edge; the facet and product
owners retain their native admission, result, and retirement semantics. Text and
outcome classification are shared with the CLI rather than re-decided by the
transport. Where a transport publishes a structured owner-result contract, it
describes normal answers, including unsatisfied verdicts, rather than thrown
failures; failure evidence remains available without claiming it is an
owner result. A disconnected caller cannot be promised a late receipt, even when
an owner has admitted facts that remain available through ordinary reads.

## Invocation and scope

The edge owns literal command usage, input acquisition, and the distinction
between an omitted selector and an explicit one. Leaf help and the executable
parser are the only owners of that grammar. A parse or acquisition refusal
performs no product operation and does not create runtime state. The edge
supplies explicit invocation inputs to [public-keiyaku.md](public-keiyaku.md),
which owns coordinate discovery, selection, and caller attribution. When draft
preservation fails, the edge presents that failure's diagnostic without
replacing the original operation outcome or claiming the draft was saved.

Help is dependency-light, read-only, and available without an existing World.
Package identification likewise reads the running package's own metadata before
any World or product runtime is initialized. Help explains a command's purpose
and its literal usage, never guesses missing input or prompts for
authority-bearing facts. User-facing text is a projection of public results; it
never becomes a second decision layer.

An operation may retire the very worktree the running CLI executes from. The
process acquires every ability its receipt needs before mutable product work can
remove that tree, and reports its native result and process classification
afterward without importing a retired path, restoring or copying the tree, or
suppressing the cleanup that removed it.

## Public command adaptation

Each root verb has one public purpose. The CLI adapts it without recreating its
owner's judgment, and returns the owner result or an edge-level usage refusal.

| Verb | Purpose and refusal boundary | Result boundary |
| --- | --- | --- |
| bind, amend, arc | Present Contract material for the Contract owner's admission judgment; refuse an impossible or contradictory invocation. | Return the Contract admission result. |
| deliver, review, verify, abandon, reconcile | Request lifecycle, evidence production, or repair judgment, or delivery preview; refuse an absent or ambiguous Contract selector. | Return the owning operation result unchanged. |
| status, ls | Read one requested Contract, Akuma, archetype, Debt, or World projection; `ls` routes to the owning product and refuses a selector that does not name one allowed read. | Render the owner observation without manufacturing facts. |
| show | Route explicitly addressed Debts to their owner or read one explicitly or contextually selected Contract's guidance; refuse mixed families and plural Contract selection before reading. | Return the selected owner's native value without an envelope. |
| region | Read declared Contract file patterns, optionally for selected paths. | Return the owner region observation or an edge refusal. |
| settings | Read the shared Settings resource for the invocation World. | Return its read-only observation, including scoped failure or absence. |
| report | Record the invoking Akuma's explicit progress on its current execution; refused when not executing; no recipient selection or inferred caller fallback. | Return native report admission; recorded never claims notification receipt. |
| whoami | Observe the invoking process's own identity and contextual Contract; for an Akuma, also observe its current Turn initiator and birth profile. | Report absence, invalid declarations, and unavailable observations explicitly without refusing the remaining facts. |
| install | Ask the integration owner to install bundled harness support. | Render its native receipt; no product authority is created by rendering it. |
| nuke | Call the named root `nuke` operation for the invocation World. | A missing or mismatched confirmation is refused before deletion; success is the World-owned receipt. |
| debt | Delegate to the separate Debt command surface. | Debt owns Debt judgment and result semantics. |
| wait | Route Contract journal change waits and Akuma completion waits to their respective owners; refuse mixed families before observation. | Return the selected owner's native observation. |
| spawn, fork, tell, ask, history, kill | Delegate selection and plural operations to `Akumas`; a resolved single-Akuma lifecycle handle remains `Akuma`. | Akuma owns identity, life, answers, and recovery. |

Bind target selection, including the omitted-target default and fork
inheritance, is owned by [public-api.md](public-api.md); the edge only adapts
its literal option grammar onto those intents and inspects no Git state itself.
The edge resolves the invocation worktree coordinate once and hands that same
resolved coordinate to the operation, so the Contract owner reads it rather
than any ambient directory.

Delivery's dry-run form selects the read-only mode of the same invocation verb,
which calls the dedicated native preview owner. Unused or mutation-only options
are refused before any product observation. Preview and submission retain their
native answers and share transport presentation and outcome classification.
Explicit verify alone requests Verification execution and
uses the same contextual Contract selection as delivery. The edge validates a
selected declaration position as a positive integer; the owner refuses a
position outside the current declarations before execution or admission. Dirty
capture is explicit and never inferred from a prior delivery or review. Delivery,
review, and preview remain non-executing consumers of adjudicated evidence.
Standalone audit is retired, not an effectful alias.

## Boundaries

The CLI may choose text or JSON projection through [cli-output.md](cli-output.md),
but both describe the same result. It preserves explicit absence, refusal,
retry, and unavailable observation rather than recasting any of them as an
empty success. Debt command intent and Debt presentation are owned by
[cli-debt.md](cli-debt.md). Literal help rows, flags, positional forms, stdin
rules, and parser recovery are executable interface detail, not CLI law.

`whoami` is a read-only edge composition: it acquires process declarations once,
uses the existing identity and contextual selection authorities, and never
establishes a World, reads Square, or emits a plugin signal. An Akuma's current initiator comes only from the open Turn of its
open current Body; an ended Body or Turn contributes no initiator. This is
independent of its birth caller and of the identity used for future submissions.
Its Dispatch association is independent of the contextual Contract. Independent
facts remain visible when another is absent, invalid, ambiguous, or unavailable;
the Akuma profile is descriptive, not live execution status.

`show` reads addressed Debts through their owner or one selected Contract's
guidance, using the existing exact Contract selection context when selection
is omitted. Debt selection may be plural; mixed Debt and Contract selection,
Akuma, category, and plural Contract selection refuse before reading. The
returned text and JSON are the selected owner's own value. Status observes the
fixed World report or one complete Contract or Akuma identity without guidance.
Plural and category status requests refuse before authority observation. Named
addresses are resolved once during asynchronous input acquisition through the
existing address authority, then invoke the resolved family's exact operation;
parsing remains synchronous and free of authority reads.

`ls` routes Contract rows through the Repo-bound Contract collection, Akuma instances
through `Akumas.of(world).list`, archetypes through their definition owner, and
Debts through the native World-wide Debt list with its default open-work selection.
Contract-only selection, including region lookup, delegates to the public
Contract resolver owned by [public-api.md](public-api.md). The edge renders its
typed refusal evidence as invocation diagnostics without owning candidate
matching; a bounded display never narrows selector meaning. Complete identities
retain the requested operation's missing-Contract refusal. Parsing selects each
catalogue's described owner operation directly.

An Akuma-instance `ls` may additionally select one caller: `--mine` uses the
invocation's own caller identity, and `--caller` names an external
`<integration>:<id>` or an `aku/<name>/<suffix>` coordinate in this World. Both
select the same caller-scoped roster and stay World-local. Absent or ambiguous
identity, a conflicting or invalid selector, and any Contract, Debt, or
Akuma-name catalogue query refuse at the usage boundary rather than returning a
misleading empty list.

The ask edge acquires a required JSON Schema from a caller-selected file and
passes its document to the public Akuma surface. Schema acquisition failures are
usage or input failures. Ask returns parsed JSON; tell and spawn admit text only.
Tell normally returns admission and may explicitly observe its exact text
answer. Deadlines bound observation only, preserving the owner's interruption
and cancellation semantics.

Spawn, fork, tell, and ask select the submitting process's opaque host Owner at
the invocation facet and pass it unchanged as optional initiator attribution.
A nonblank explicit integration Owner wins; otherwise one unambiguous native
host coordinate supplies attribution, with the external host fallback used only
when no native coordinate exists. Ambiguous, absent, or child-only host identity
selects nothing and never refuses native operation. Selection is synchronous and
reads no notification artifact or membership. The Body uses frozen input and
Turn recipients, never its environment to reconstruct the submitting Owner.
Caller lineage remains independent from notification attribution.

Direct spawn and fork derive optional declared caller attribution at the invocation facet:
a complete Akuma-and-World environment pair wins over external integration
attribution, and an incomplete pair refuses rather than inventing a World.
The supplied World is canonicalized here. Without Akuma custody, the enclosing
native host session supplies external attribution. Conflicting native host
identities refuse rather than select an arbitrary parent. Only when no native
host identity is declared does the edge use the explicit external-integration
fallback. These declarations remain attribution, not authentication or authority;
the underlying product surfaces do not infer them from an environment.
