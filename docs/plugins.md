# Plugins

This chapter owns plugin package selection, process-local activation, declared
World-path capabilities, signal delivery, and failure isolation. Plugins are
optional observers of named Keiyaku semantics; they own neither the product
facts that cause a signal nor any public result.

## Contract And Selection

Keiyaku owns the closed signal vocabulary and the stable public plugin contract.
A plugin receives a complete signal and only the semantic identities that
signal carries. The contract does not reveal whether a CLI, a detached Body, or
another process produced it, and it supplies neither a continuation channel nor
cross-process instance identity.

Settings remains the sole owner of configuration scope, shadowing, provenance,
and read failure. The `plugins` namespace selects named packages explicitly;
Settings never loads code. A producing process observes its World Settings once
after dependency-light help selection and keeps that selection and its activated
instances for the rest of the process. A later process may ordinarily observe a
different configuration or installed package byte. Runtime loading neither
acquires packages nor promises content identity, and it never discovers plugins
by scanning dependencies or process directories.

Plugin identity is declared by the activated package and must agree with the
selected name. In one process it is unique and activation follows that identity's
lexicographic order. Compatibility is explicit: an unsupported plugin contract
is not adapted or partially activated.

## Activation And Capabilities

An activated plugin is trusted same-process code, not a separate operating-
system security principal. It may receive only the World coordinate,
configuration selected for it, and the named writable capabilities it declared.
Those capabilities name World-relative plugin custody. Keiyaku validates their
coordinates by spelling and physical location, refuses management custody,
traversal, aliasing, and ambiguous declarations, and creates only the validated
directories. A plugin cannot ask the host to resolve an undeclared coordinate.
This validation is a trusted coordinate grant, not an OS sandbox.

Plugin-owned paths are outside Keiyaku management custody unless an owner later
adopts them. They are not Heart facts, Git facts, Settlement facts, Contract
worktree material, or reset targets merely because a plugin uses them.

Activation is all-or-nothing for each plugin. The host validates a package and
its declarations, then activates it before retaining any handlers. Import,
validation, activation, or handler failure is attributed to that plugin through
the producing process's diagnostic channel, is bounded, and does not prevent
other selected plugins from proceeding.

## Signals And Boundaries

A process emits a complete owned signal at most once for that occurrence. It
starts each applicable handler independently and waits only for their settled
attempts. Handler failure is non-authoritative silence apart from its diagnostic:
it changes neither Heart truth, lifecycle, leash, public result, nor later Tell
semantics. Keiyaku creates no retry queue, persistence record, compensating
action, or generic event bus for plugins.

An admitted Akuma call emits `akuma.called` after admission and before any
outcome observation. It identifies the called Akuma, its calling Akuma when
there is one, and any Contract association already known at admission. It
carries no call contents or provider detail.
The call-admission producer owns this signal's delivery.

Every committed terminal Akuma Turn emits `akuma.turn-outcome` after its outcome
is durable, including Turns driven by later Tells. The signal identifies the
Akuma and Turn sequence and carries the committed answered or failed outcome;
it does not expose provider or continuation custody. Plugins cannot participate
in providers, generic lifecycle verbs, operation inputs, or Settlement. In
particular, plugin delivery does not make birth reversible, add a pre-Body
listener, or create rollback or cross-process continuation behavior.
