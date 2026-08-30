# Akuma Allowed Actions

This chapter owns the closed public vocabulary of forwarded mutable actions, its
birth-time reduction, and keyed Body Request admission. It is not a general
authorization system; exact member names belong to public declarations and help.

## Frozen Permission

An Archetype may declare a complete default set. Its omission means the current
complete vocabulary, while an explicit empty set means none. Call-time additions
can add to that default but never clear it. A nested birth clips the resulting
set to its authenticated direct parent only; it never walks an ancestor chain.

Every Soul freezes its effective set. Wake and restart retain it, and fork copies
it exactly without an override. Historical Soul without an explicit set means
the complete current vocabulary. Forwarded observation remains unkeyed; each
mutable Task or Contract operation is independently keyed, so one permission
does not imply another or require a Contract association.

## Admission Boundary

The selected operation descriptor applies the authenticated Soul's frozen
permission before the owner executes. Heart records that one generic admission
or refusal after authenticating the requester, but never interprets action
vocabulary or payload. Dispatch lookup grants nothing. The child performs no
duplicate precheck, transport remains one hop, and each operation owner remains
the sole judge of its result. There is no inherited authorization, generic
capability registry, or second authorization store.
