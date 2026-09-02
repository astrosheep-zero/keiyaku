---
id: task/post-audit/separate-task-logical-identity
title: Separate Task logical identity from Windows-unsafe paths
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-09-01T08:38:53.943Z
updatedAt: 2026-09-01T12:45:53.299Z
---
Ensure Task physical locators obey cross-platform length, reserved-device-name, and filename rules without making logical IDs hash-only. Cover long stems, collision suffix fitting, CON/NUL and equivalent Windows cases.