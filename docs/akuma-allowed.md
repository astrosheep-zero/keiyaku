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
contract.review
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
the Archetype or call additions. Valid lists are stored in lexical order.

Call-time `allowed` values are additions to the Archetype base. One birth's
requested set is the union of that base and the additions; an omitted call set
therefore leaves the base unchanged. A nested call clips that union to the
authenticated direct caller Soul. The direct-parent clip is complete: no birth
reads or walks earlier ancestors.

Every new Soul freezes its effective list. Reading a pre-feature Soul with no
list means the complete current vocabulary. Wake and restart retain the Soul;
fork copies the source Soul's effective list exactly and accepts no override.

## Admission

Dispatch lookup never admits an action. The selected operation descriptor applies
this Soul-owned vocabulary to the authenticated caller's frozen list, including
the unkeyed `akuma.wait` rule, before its owner executes. It supplies that one
decision to Heart; Heart authenticates the requester and durably records the
generic admission or `not-allowed: <action>` refusal without importing or
interpreting this vocabulary. The child performs no duplicate precheck. Request
transport remains one hop, and Contract, Task, and Akuma owners remain the sole
authorities for their operation outcomes.

Every `task.*` member is independently keyed. Permission for one Task mutation
does not imply another Task action or any Contract action; Task requires no
Contract association or permission.
