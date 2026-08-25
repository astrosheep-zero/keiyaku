---
id: task/maintainability-owner-refactor/re-measure-and-remove-obsolete
title: Re-measure and remove obsolete exemptions
state: done
priority: 1
needs:
  - task/maintainability-owner-refactor/delete-stale-maintainability
  - task/maintainability-owner-refactor/split-architecture-policy
  - task/maintainability-owner-refactor/return-cli-parsing-and
  - task/maintainability-owner-refactor/split-projection-and-renderer
  - task/maintainability-owner-refactor/split-contract-facade-operation
  - task/maintainability-owner-refactor/isolate-terminal-git
  - task/maintainability-owner-refactor/separate-akuma-runtime-and
parent: task/maintainability-owner-refactor/return-all-oversized-source
supersedes: []
relates: []
note: ""
createdAt: 2026-08-24T01:49:58.212Z
updatedAt: 2026-08-24T05:12:08.303Z
---
After all structural deliveries, re-run the ordinary 400 and 500 file thresholds and 80-line function threshold. Remove every source exemption made obsolete, retain only the eight audited atomic function caps, and run maintainability, typecheck, architecture, full tests, and build.