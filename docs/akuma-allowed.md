# Akuma Allowed Actions

This chapter owns the public `allowed` vocabulary, its birth-time reduction,
and keyed Body Request admission. It is not a general authorization system.

## Vocabulary

`AllowedAction` is the closed set of mutable operations currently forwarded by
an Akuma:

```text
akuma.call
akuma.kill
akuma.tell
contract.deliver
task.add
task.addDocument
task.compose
task.done
task.drop
task.hold
task.resume
task.start
task.stop
task.update
```

An operation joins this set only when its forwarding ships and it changes
persistent facts outside the provider. When `akuma.wait` is forwarded, it
remains observation and is never permission-keyed.

## Birth

Archetype Markdown may declare `allowed` as a flat list. Omission means the
complete current vocabulary; a present list is the complete default, including
the empty list. Unknown values, non-string entries, and duplicates invalidate
the Archetype. Valid lists are stored in lexical order.

One direct call may replace the Archetype default with another complete list.
That replacement may contain actions absent from the Archetype because the
Archetype is configuration, not an authority ceiling. A nested call instead
clips its requested child list to the authenticated direct caller Soul. The
direct-parent clip is complete: no birth reads or walks earlier ancestors.

Every new Soul freezes its effective list. Reading a pre-feature Soul with no
list means the complete current vocabulary. Wake and restart retain the Soul;
fork copies the source Soul's effective list exactly and accepts no override.

## Admission

The hosting Heart is the sole judge for keyed actions. In the transaction that
admits a request, it reads the authenticated caller Soul and either records the
action coordinate or refuses `not-allowed: <action>` before the operation owner
runs. The child performs no duplicate precheck. Request transport remains one
hop, and Contract, Task, and Akuma owners remain the sole authorities for their
operation outcomes.
