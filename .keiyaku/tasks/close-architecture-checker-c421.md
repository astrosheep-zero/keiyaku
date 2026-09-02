---
id: task/close-architecture-checker-c421
title: Close architecture checker coverage and const mutation blind spot
state: done
priority: 3
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-09-02T04:42:34.466Z
updatedAt: 2026-09-02T07:40:02.987Z
---
Implement Faye P3 items 11+12: ensure architecture analysis covers executable JS/MJS/CJS scripts with child process/filesystem/environment capability checks, preferably by migrating scripts to TypeScript where coherent; and extend engine-parser module-mutable-state detection to catch top-level const Map/Set/array/object containers that are mutated internally, without full alias/data-flow analysis. Preserve existing policy semantics and diagnostics; add focused fixtures and architecture tests. Do not broaden unrelated owners or change law.