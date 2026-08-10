---
id: task/unify-the-git-physical-owner-name
title: Unify the Git physical owner name
state: in_progress
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: Rename the single Git physical law and source owner in one hard cut; do not introduce a backend interface or compatibility aliases.
createdAt: 2026-08-10T11:17:09.045Z
updatedAt: 2026-08-10T11:17:47.271Z
contractId: kei/unify-the-git-physical-owner-name
---
The current law calls one domain transport while source calls it carrier. Both names imply a replaceable generic IO role even though durable facts and physical reconciliation are explicitly Git-shaped.

Rename docs/transport.md to docs/git.md and src/carrier/ to src/git/. Replace carrier/transport terminology throughout authority, source, tests, architecture policy, and user-visible diagnostics where it denotes this owner. Keep protocol dependency direction intact. Do not add VcsBackend, adapter, driver, compatibility re-export, old-path decoder, or behavior changes.
