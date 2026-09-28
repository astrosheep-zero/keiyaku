---
id: task/tighten-live-activity-9b88
title: Tighten live activity observation and tests
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: "Verification: npm run build, npm run test:typecheck, npm run format:check, npm run test:maintainability, and git diff --check passed. Initial npm test failed only in library-akuma-creation.test.ts: local schema Keiyaku.call starts its zero observation budget after birth — process survived during cleanup. One direct rerun passed all 8 cases; one subsequent npm test passed fully."
createdAt: 2026-09-20T02:21:00.346Z
updatedAt: 2026-09-20T02:44:51.278Z
---
