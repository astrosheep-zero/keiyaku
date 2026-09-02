---
id: task/post-audit/strict-typecheck-task-cli-and-9c9d
title: Strict-typecheck Task CLI and invocation tests
state: done
priority: 2
needs: []
parent: task/migrate-remaining-historical
supersedes: []
relates: []
note: ""
createdAt: 2026-09-01T15:53:17.820Z
updatedAt: 2026-09-01T16:43:41.675Z
---
Bring tests/task-cli.test.ts and tests/cli-invoke.test.ts into the maintained strict typecheck subset without changing product behavior. Resolve their shared ParsedInvocation, Task/Contract invocation result-union, and branded-ID fixture drift using the current public types and existing runtime behavior. Keep one type authority, remove obsolete casts or fixture fields where they are no longer meaningful, and do not widen into other historical test files. Verify the focused behavior tests and strict typecheck; leave unrelated format, architecture, and maintainability baseline diagnostics untouched.