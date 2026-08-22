---
id: task/repair-git-shim-capability
title: Repair Git shim capability injection
state: done
priority: 0
needs: []
parent: task/restore-full-test-green-after-architecture-polic
supersedes: []
relates: []
note: ""
createdAt: 2026-08-21T09:26:46.809Z
updatedAt: 2026-08-21T09:52:44.597Z
---
Update affected test callbacks to consume withGitShim returned gitPath and construct tested Repo/Git capabilities inside the callback. Preserve explicit capability injection; do not restore global PATH mutation.