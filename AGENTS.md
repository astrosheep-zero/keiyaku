# Keiyaku v4 Repository Rules

Keiyaku v4 is a clean implementation. The v3 repository at
`../keiyaku` is read-only source material, not an architecture authority.

Before changing code, read:

1. `docs/architecture.md`
2. `docs/porting-policy.md`

Hard rules:

- One product fact has one durable home.
- Git durability means reachability from a ref.
- `refs/heads/keiyaku-state` points to the one carrier tree.
- Contract lifecycle authority is the journal blob at
  `contracts/<contract-id>.jsonl`.
- Carrier commit identity and ancestry are transport coordinates only.
- Evidence payloads are ordinary carrier-tree blobs, never detached commits.
- Lifecycle decisions read inline journal facts and perform no evidence I/O.
- Tasks remain ordinary tracked Markdown and never enter lifecycle state.
- Do not add compatibility readers, dual writes, persisted replay queues,
  carrier gates, current-state databases, or generic callback frameworks.
- Copy v3 code only after proving that its invariant belongs in v4.

Use ASCII unless a persisted product fact requires otherwise. Keep modules
large enough to own a coherent mechanism; do not create directories of tiny
wrappers.
