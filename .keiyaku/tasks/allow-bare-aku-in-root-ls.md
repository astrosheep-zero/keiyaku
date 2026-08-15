---
id: task/allow-bare-aku-in-root-ls
title: Allow bare aku in root ls
state: open
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-15T01:31:31.903Z
updatedAt: 2026-08-15T01:31:31.903Z
---
The root ls identity selector should accept `aku` directly. Users must not be forced to write the storage-shaped trailing slash form `aku/` merely to list the Archetype catalog.

Current evidence: `keiyaku ls aku --json` is rejected with "ls requires an identity directory with a trailing slash", while `keiyaku ls aku/ --json` succeeds. Settle the canonical grammar and update parser, help, typed behavior, owner docs, and focused CLI tests without adding a second alias implementation.