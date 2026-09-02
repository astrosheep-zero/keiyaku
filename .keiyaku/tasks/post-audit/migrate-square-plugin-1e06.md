---
id: task/post-audit/migrate-square-plugin-1e06
title: Migrate Square plugin implementation to TypeScript
state: done
priority: 2
needs:
  - task/post-audit/strict-typecheck-square-plugin-db66
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-09-01T13:57:33.396Z
updatedAt: 2026-09-01T15:04:33.689Z
---
Rewrite the local Square plugin implementation from plugins/square/index.js to TypeScript, following the typed plugin pattern used by Pi coding-agent plugins while preserving the existing Keiyaku plugin contract and runtime behavior. Keep signal names, activation behavior, environment handling, writable capability usage, failure isolation, and package semantics unchanged. Make the build emit the runtime entry and declaration from one TypeScript source, publish the resulting type entry through the plugin package exports/files, and remove the duplicate handwritten declaration once the source owns the types. Extend the maintained strict typecheck and focused plugin tests to cover the migrated entry. Do not change Square signal semantics, add compatibility loaders, or widen this task into the remaining historical test migration.