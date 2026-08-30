# Alias

Alias is the sole authority for movable, world-local human selectors that point
at Akuma identities. It is convenience, not Akuma identity, lineage, Dispatch,
lifecycle, or a durable property of an Akuma. Selector grammar belongs to
[model.md](model.md).

## Durable Mapping

Each Akuma World has one canonical Alias mapping authority. A missing mapping is
empty. Alias alone owns its storage, decoding, reads, and moves. Corrupt,
noncanonical, or unsupported durable data raises `AuthorityCorruptionError`; it
is never partly read, silently repaired, or replaced by a cached registry.

Moving an alias replaces or creates exactly that selector's target and reports
the prior target when present. It does not inspect the Akuma's heart, append an
event log, inherit aliases, maintain a reverse index, probe target existence, or
provide a separate deletion/sweep authority.

## Concurrency And Boundary

Alias writers serialize a fresh complete read, one mapping update, and durable
same-directory replacement under one world-local coordination boundary. Readers
do not take that writer lock and see either a complete previous mapping or a
complete replacement, never a partial write. The coordination mechanism carries
no Alias fact and does not become a second in-memory or SQLite authority.

Only Alias persists Alias state. Akuma, Dispatch, Contract, Task, Git, Settings,
and CLI do not own it. Library may sequence a move after Akuma birth, but a
later Alias failure cannot erase the born Akuma or published Dispatch.
