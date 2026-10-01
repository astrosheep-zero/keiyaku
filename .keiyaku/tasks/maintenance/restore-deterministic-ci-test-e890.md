---
id: task/maintenance/restore-deterministic-ci-test-e890
title: Restore deterministic CI test authority
state: done
priority: 1
needs: []
parent: task/maintenance/repository-wide-simplification-adad
supersedes: []
relates: []
note: ""
createdAt: 2026-09-29T13:38:26.583Z
updatedAt: 2026-09-29T14:39:31.521Z
---
Restore the deterministic repository checks exposed by the census: compiled tests must receive every repository input they intentionally read, packaged end-to-end assertions must match the current lawful output, and test manifests must name current files. Preserve the observed `attempt 10the answer` stream until separately proved defective. Do not hide failures with retries, skips, or broader ignores. This outcome excludes the separately scheduled expansion of TypeScript test coverage and the existing runtime-process investigation.