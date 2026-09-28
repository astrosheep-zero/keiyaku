---
id: task/akuma/strip-inherited-parent-harness-cbd5
title: Strip inherited parent harness identity from Akuma execution environments
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-09-15T04:03:52.768Z
updatedAt: 2026-09-15T07:17:43.471Z
---
User confirmed that parent harness session environment must be removed from child Akuma execution. Current evidence: src/akuma/body.ts bodyProcessInput copies process.env and only replaces KEIYAKU_ACTOR_ID; Claude and Codex adapters also inherit ambient environment. Pi native Bash replaces its own PI_SESSION_ID, but does not establish cross-harness isolation. No dedicated live Task was found. Implement child-environment isolation without mutating parent process.env. Inventory supported harness session/thread identity and session-scoped routing markers, including PI_SESSION_ID, CODEX_THREAD_ID, CLAUDE_CODE_SESSION_ID, OPENCODE_SESSION_ID and related native markers; assess explicit participant identity overrides and nested-harness markers so parent attribution cannot leak. Preserve ordinary host configuration, credentials, PATH, explicit initiating-caller facts and child-owned request transport. Cover call, wake/resume, fork setup and provider execution paths, including in-process Pi and direct adapter entry where applicable; establish child native identity through its own harness. Add focused regression tests for same-harness and cross-harness inheritance, unchanged parent environment, child request routing and caller attribution. Read SOUL.md and registered execution/provider/plugin owners before implementation; update the one owning chapter with the settled isolation intent in the same coherent change. Run npm test, npm run test:typecheck and npm run build. This Task records required work, not a completed fix.