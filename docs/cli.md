# CLI

`keiyaku` is the process edge. It turns an invocation and acquired caller input
into public product operations, then gives their typed result to the shared
renderer. It owns neither document interpretation, lifecycle judgment, Git
adjudication, verification, reconciliation, nor Task or Akuma authority.

## Invocation and scope

The edge owns literal command usage, input acquisition, and the distinction
between an omitted selector and an explicit one. Leaf help and the executable
parser are the only owners of that grammar. Before an operation begins, the
edge resolves caller-supplied filesystem coordinates once, preserves their
meaning for the receiving public surface, and rejects malformed, repeated,
ambiguous, or unused invocation input. A parse or acquisition refusal performs
no product operation and does not create runtime state.

The invocation World remains the scope for Task, Settings, and composite
observation. A caller may separately nominate a Contract repository for a
Contract operation; that choice cannot silently retarget the invocation World
or splice facts from two Worlds into one report. The edge supplies environment
or current-directory facts only as explicit process inputs. Libraries do not
rediscover them.

Help is dependency-light, read-only, and available without an existing World.
It explains a command's purpose and its literal usage, never guesses missing
input or prompts for authority-bearing facts. User-facing text is a projection
of public results; it never becomes a second decision layer.

## Public command adaptation

Each root verb has one public purpose. The CLI adapts it without recreating its
owner's judgment, and returns the owner result or an edge-level usage refusal.

| Verb | Purpose and refusal boundary | Result boundary |
| --- | --- | --- |
| bind, amend, arc | Present Contract material for the Contract owner's admission judgment; refuse an impossible or contradictory invocation. | Return the Contract admission result. |
| deliver, review, abandon, audit, reconcile | Request the named lifecycle, evidence, inspection, or repair judgment; refuse an absent or ambiguous Contract selector. | Return the owning lifecycle, audit, or reconciliation result unchanged. |
| show, status, ls | Read one requested Contract, catalogue, Akuma, Task, or World projection; refuse a selector that does not name one allowed read. | Render the owner observation without manufacturing facts. |
| settings | Read the shared Settings resource for the invocation World. | Return its read-only observation, including scoped failure or absence. |
| install | Ask the integration owner to install bundled harness support. | Render its native receipt; no product authority is created by rendering it. |
| nuke | Ask the World owner to perform its deliberately confirmed reset. | A missing or mismatched confirmation is refused before deletion; success is the World-owned receipt. |
| task | Delegate to the separate Task command surface. | Task owns Task judgment and result semantics. |
| call, fork, wait, tell, history, kill | Delegate to the package-root Akuma facet. | Akuma owns identity, life, requests, answers, and recovery. |

In a declared direct-parent request channel, the CLI forwards only the
caller-selected operation and the information needed to execute it locally.
The parent reconstructs local custody and returns the ordinary public result;
forwarding does not create another delivery, review, audit, or Task workflow.

## Boundaries

The CLI may choose text or JSON projection through [cli-output.md](cli-output.md),
but both describe the same result. It preserves explicit absence, refusal,
retry, and unavailable observation rather than recasting any of them as an
empty success. Task command intent and Task presentation are owned by
[cli-task.md](cli-task.md). Literal help rows, flags, positional forms, stdin
rules, and parser recovery are executable interface detail, not CLI law.

Mutable catalogue commands adapt their owner's bounded recent observation;
they do not offer an edge-level route to an exhaustive SDK board.
