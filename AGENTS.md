# Keiyaku v4 Law

Before any change or review in this repository, read the entire
`.claude/skills/keiyaku-v4-law/SKILL.md`. It is the sole law authority.

Keiyaku v4 is a clean implementation; `../keiyaku` is read-only source
evidence, not architecture authority. After reading the full skill and before
changes, read `docs/architecture.md` and `docs/porting-policy.md`.

Use ASCII unless a persisted fact requires otherwise. Keep coherent owner
modules rather than directories of tiny wrappers.

Update the law skill in the same commit as any newly settled law and its
implementation.

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
