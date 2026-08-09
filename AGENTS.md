# Keiyaku v4 Repository Guide

Before any change or review in this repository, read [`SOUL.md`](SOUL.md),
[`docs/README.md`](docs/README.md), and every owner chapter it names for the
requested surface. `SOUL.md` defines the product stance; the documents under
`docs/` are the sole product and architecture authority.

| First | Then |
| --- | --- |
| [`SOUL.md`](SOUL.md) | [`docs/README.md`](docs/README.md), then the single owner chapter for each affected surface. |

The index is the authority registry. It directs public API, document, model,
lifecycle, verification, transport, and CLI questions to their one law home.

Keiyaku v4 is a clean implementation; `../keiyaku` is read-only source
evidence, not architecture authority. Skills are operating guides and never a
second law source.

Use ASCII unless a persisted fact requires otherwise. Keep coherent owner
modules rather than directories of tiny wrappers.

Update the owning root document in the same coherent change as any newly
settled law and its implementation.

## Package Manager

This repository uses **npm only**. `package-lock.json` is the sole dependency
lockfile and must remain authoritative.

- Install the locked dependency tree with
  `npm ci --ignore-scripts --prefer-offline`.
- Run verification with `npm test`, `npm run test:typecheck`, and
  `npm run build`.
- Use `npm install <package>` only when intentionally changing dependencies,
  and commit the resulting `package.json` and `package-lock.json` changes
  together.
- Do not run `pnpm install`, `pnpm test`, `yarn`, or another package manager.
  Do not create `pnpm-lock.yaml`, `yarn.lock`, `.pnpm-store`, or otherwise move
  npm-managed packages into `node_modules/.ignored`.
- Akuma workers and reviewers follow the same npm-only rule. A read-only review
  must not reinstall or rewrite dependencies merely to inspect the repository.
