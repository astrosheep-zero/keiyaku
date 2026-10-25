# CLI

`keiyaku` is the process edge. It turns an invocation and acquired caller input
into public product operations, then gives their typed result to the shared
renderer. It owns neither document interpretation, lifecycle judgment, Git
adjudication, verification, reconciliation, nor Debt or Akuma authority.

## Invocation and scope

The edge owns literal command usage, input acquisition, and the distinction
between an omitted selector and an explicit one. Leaf help and the executable
parser are the only owners of that grammar. Before an operation begins, the
edge resolves caller-supplied filesystem coordinates once, preserves their
meaning for the receiving public surface, and rejects malformed, repeated,
ambiguous, or unused invocation input. A parse or acquisition refusal performs
no product operation and does not create runtime state.

The invocation World remains the scope for Debt, Settings, and composite
observation. The edge loads the shared Settings resource once and hands that
immutable value to the private Contract composition; gate bundles, worktree
hooks, and branch freshness are then derived by the Contract operation that
consumes them, not by the edge. A caller may separately nominate a Contract repository for a
Contract operation; that choice cannot silently retarget the invocation World
or splice facts from two Worlds into one report. The edge supplies environment
or current-directory facts only as explicit process inputs. Libraries do not
rediscover them.

Akuma call execution is a separate coordinate from invocation scope. An
explicit call execution directory is the only selection; otherwise the call
uses the effective invocation directory. Contract association never supplies
or displaces an execution directory, and selecting the invocation directory
explicitly is equivalent to omitting that selection.

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
| deliver, review, abandon, reconcile | Request lifecycle, evidence, or repair judgment, or delivery preview; refuse an absent or ambiguous Contract selector. | Return the owning operation result unchanged. |
| status, ls | Read one requested Contract, Akuma, archetype, Debt, or World projection; `ls` routes to the owning product and refuses a selector that does not name one allowed read. | Render the owner observation without manufacturing facts. |
| show | Read one explicitly or contextually selected Contract's guidance; refuse non-Contract and plural selection before reading. | Return the native guidance value without an envelope. |
| region | Read declared Contract file patterns, optionally for selected paths. | Return the owner region observation or an edge refusal. |
| settings | Read the shared Settings resource for the invocation World. | Return its read-only observation, including scoped failure or absence. |
| install | Ask the integration owner to install bundled harness support. | Render its native receipt; no product authority is created by rendering it. |
| nuke | Call the named root `nuke` operation for the invocation World. | A missing or mismatched confirmation is refused before deletion; success is the World-owned receipt. |
| debt | Delegate to the separate Debt command surface. | Debt owns Debt judgment and result semantics. |
| call, fork, wait, tell, ask, history, kill | Delegate selection and plural operations to `Akumas`; a resolved single-Akuma lifecycle handle remains `Akuma`. | Akuma owns identity, life, requests, answers, and recovery. |

Bind target selection, including the omitted-target default and fork
inheritance, is owned by [public-api.md](public-api.md); the edge only adapts
its literal option grammar onto those intents and inspects no Git state itself.
The edge resolves the invocation worktree coordinate once and hands that same
resolved coordinate to the operation, so the Contract owner reads it rather
than any ambient directory.

In a declared direct-parent request channel, the CLI forwards only the
caller-selected operation and the information needed to execute it locally.
A stable request entry is resolved asynchronously once inside the invocation's
failure and cancellation boundary before operations begin; its actual channel
is then pinned for the invocation under [akuma-requests.md](akuma-requests.md).
The parent reconstructs local custody and returns the ordinary public result;
forwarding does not create another delivery, review, preview, or Debt workflow.

Delivery's dry-run form calls the dedicated native preview operation, never the
mutating delivery path. Unused or mutation-only options are refused before any
product observation. Standalone audit is retired, not an effectful alias.

## Boundaries

The CLI may choose text or JSON projection through [cli-output.md](cli-output.md),
but both describe the same result. It preserves explicit absence, refusal,
retry, and unavailable observation rather than recasting any of them as an
empty success. Debt command intent and Debt presentation are owned by
[cli-debt.md](cli-debt.md). Literal help rows, flags, positional forms, stdin
rules, and parser recovery are executable interface detail, not CLI law.

`show` alone reads one selected Contract's guidance, using the existing exact
Contract selection context when selection is omitted. It refuses Akuma, plural,
and world selection before reading. The returned guidance bytes are the owner's
own value, rendered directly in text and serialized directly in JSON. `status`
only observes status: world, Contract, Akuma, category, and plural observations
incur no guidance read and add no guidance output.

`status` can request a bounded recent category independently of the World overview.
The edge selects the category before observation and keeps category bounds out of
exact and plural identity selection. A category reads its selected owner section;
Contract categories require Repo, while Akuma categories remain available in a
World without Repo.

`ls` routes Contract rows through `Keiyaku.with().list`, Akuma instances
through `Akumas.of(world).list`, archetypes through their definition owner, and
Debts through `Debts.of(world).list`. Contract-only selection, including region lookup, delegates to the public
Contract resolver owned by [public-api.md](public-api.md). The edge renders its
typed refusal evidence as invocation diagnostics without owning candidate
matching; a bounded display never narrows selector meaning. Complete identities
retain the requested operation's missing-Contract refusal. The SDK exposes product `list` operations and no mixed `ls`.

The call and ask edges may acquire a JSON Schema from a caller-selected file;
the file is decoded once at the edge and passed to the public Akuma surface.
Schema acquisition failures are usage or input failures, while ordinary call,
ask, tell, wait, history, and kill behavior remains unchanged.

Call, fork, tell, and ask select the submitting process's Square participant name at
the invocation edge and pass it as optional input attribution, including through a
direct-parent request. An explicit Square participant name is authoritative, an
established participant already owned by this session is reused unchanged, and a
session with no identity in the World's local Square derives one stable name from
its own provider session coordinate. An ambiguous or missing session coordinate,
an ambiguous existing binding, or an unavailable registry selects nothing.
Missing or unusable Square identity leaves attribution absent and never refuses
the operation. A generic integration initiator supplied by the caller outranks
that selection and is forwarded unchanged. The Body does not rediscover the caller
from its own environment. Call establishes the already selected World before
preparing the submitting participant's route; a later failed first call may
therefore leave that World marker.

Direct call and fork derive optional declared caller attribution at this edge:
a complete Akuma-and-World environment pair wins over external integration
attribution, and an incomplete pair refuses rather than inventing a World.
The supplied World is canonicalized here. Without Akuma custody, the enclosing
native host session supplies external attribution. Conflicting native host
identities refuse rather than select an arbitrary parent. Only when no native
host identity is declared does the edge use the explicit external-integration
fallback. These declarations remain attribution, not authentication or authority;
the SDK does not infer them from its environment. Request-custody call skips
ambient caller parsing entirely because serving custody supplies the actual
parent, including for older running Bodies without a World declaration.
