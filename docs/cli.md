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
| deliver, review, abandon, audit, reconcile | Request the named lifecycle, evidence, inspection, or repair judgment; refuse an absent or ambiguous Contract selector. | Return the owning lifecycle, audit, or reconciliation result unchanged. |
| status, ls | Read one requested Contract, Akuma, archetype, Task, or World projection; `ls` routes to the owning product and refuses a selector that does not name one allowed read. | Render the owner observation without manufacturing facts. |
| region | Read declared Contract file patterns, optionally for selected paths. | Return the owner region observation or an edge refusal. |
| settings | Read the shared Settings resource for the invocation World. | Return its read-only observation, including scoped failure or absence. |
| install | Ask the integration owner to install bundled harness support. | Render its native receipt; no product authority is created by rendering it. |
| nuke | Call the named root `nuke` operation for the invocation World. | A missing or mismatched confirmation is refused before deletion; success is the World-owned receipt. |
| task | Delegate to the separate Task command surface. | Task owns Task judgment and result semantics. |
| call, fork, wait, tell, ask, history, kill | Delegate selection and plural operations to `Akumas`; a resolved single-Akuma lifecycle handle remains `Akuma`. | Akuma owns identity, life, requests, answers, and recovery. |

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

`status` reads a Contract's guidance only when the caller explicitly opts in
for one selected Contract; an ordinary world, Contract, Akuma, or plural status
incurs no guidance read and adds no guidance output, and an Akuma, plural, or
world selection is refused before that read. The returned guidance bytes are the
owner's own value, rendered directly in text and serialized directly in JSON.
There is no separate guidance-reading verb.

`ls` routes Contract rows through `Keiyaku.with().list`, Akuma instances
through `Akumas.of(world).list`, archetypes through their definition owner, and
Tasks through `Tasks.of(world).list`. Contract selector resolution continues
to use a complete read where required; a bounded list never narrows selector
meaning. The SDK exposes product `list` operations and no mixed `ls`.

The call and ask edges may acquire a JSON Schema from a caller-selected file;
the file is decoded once at the edge and passed to the public Akuma surface.
Schema acquisition failures are usage or input failures, while ordinary call,
ask, tell, wait, history, and kill behavior remains unchanged.

Call, tell, and ask capture the submitting process's assigned Square identity at the
invocation edge and pass it as optional input attribution, including through a
direct-parent request. Missing or unusable Square identity leaves attribution
absent and never refuses the operation. The Body does not rediscover the caller
from its own environment.
