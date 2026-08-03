# Keiyaku v4

Keiyaku v4 is a clean implementation of an agent-facing contract workflow.

The first milestone is intentionally narrow: a Git-backed facts kernel with
per-contract append-only journals, carrier-tree evidence, atomic path-set CAS,
and tests that prove clone and garbage-collection durability.

No v3 runtime code is wired into this repository.
