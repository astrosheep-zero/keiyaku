# Settlement

Settlement is the sole owner of Contract-to-Task coordination. Contract journals
and Task documents retain their own lifecycle authority; TaskHolder is the one
durable cross-product association. Forking creates no holder, lineage, sibling
registry, or comparison outcome.

No other module joins Contract write-side facts to Task writes. Library composes
holder changes with Contract admission and invokes settlement after Git
reconciliation. CLI never settles directly, and Kanshi may only consume the
read projection.

## TaskHolder

Each Task has one canonical current holder record naming the Contract that holds
it or its released disposition. Settlement alone owns its storage, decoding,
currentness, and mutation. Binding a Task supersedes its prior holder; abandonment
releases a holder only when that Contract is still current. An older Contract
therefore cannot release or settle a Task taken by a later Contract.

Holder mutation and its associated Contract admission publish together. Holder
records are not copied into Tasks, deleted, reverse-indexed, or written by a
second owner. Git carries their opaque companion bytes without interpreting
them. Holder claim and release serialize per Task, while the Task store alone
adjudicates its own concurrent document writes; neither product borrows the
other's concurrency authority.

## Settlement Rules And Replay

When a claimed Contract remains a Task's matching held holder, Settlement moves
that Task to its settled completion state and releases the holder as its final
action. An already settled Task remains settled. A dropped Task, missing Task,
Task refusal, concurrent Task movement, or failed holder publication is visible
lag; the holder remains when release did not publish and a later replay
re-evaluates it. A terminal Contract without its matching held holder is
strictly inert: it does not create, repair, or inspect unrelated Task, World, or
context state.

Contract-derived namespace context belongs to the active managed worktree
projection. Settlement never installs or repairs it, and terminal Contracts
never receive an active context projection. Kanshi uses the same Contract-derived
namespace only as a read-time matching coordinate. Settlement has no Akuma rule,
configurable lifecycle hook, event bus, or generic cross-product registry.

Admission is irreversible. The public sequence is admission, Git reconciliation,
active workspace projection, Settlement, then result projection. Git, workspace,
or Settlement lag cannot reject an accepted fact, manufacture abandonment, or
hide the Contract. Terminal managed worktree removal waits until this
invocation's settlement opportunity ends.

Settlement derives desired work anew from current Contract, holder, Task, and
Git observations on every invocation. It stores no completion bit, replay queue,
or secondary receipt. The per-Task holder boundary and Task's own predecessor
comparison preserve concurrent correctness; a failed Task settlement or holder
publication leaves the matching holder held for a later replay. Settlement
reports completed actions and independent lags, without inventing a second
lifecycle state or nested receipt.

## Boundary

Settlement is not a hook. Hooks are external commands attached to physical
effects and remain owned by those effects. Adding another settlement behavior
requires an explicit rule in this chapter rather than a plugin point or
configurable Contract, Task, or Akuma event.
