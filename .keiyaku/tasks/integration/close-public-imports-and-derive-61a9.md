---
id: task/integration/close-public-imports-and-derive-61a9
title: Close public imports and derive Contract settings internally
state: done
priority: 1
needs:
  - task/integration/consolidate-akuma-single-and-1f86
  - task/integration/reduce-cli-to-argument-7d90
parent: task/integration/deep-implementation-integration-5cf9
supersedes: []
relates: []
note: PUBLIC1760 settles remaining P6 gaps. Public Keiyaku.with/Akumas.of/Tasks.of inputs REMOVE execution; always LOCAL. Same internal construction takes explicit carrier for CLI/Body only, no root/plugin exports or ambient route. Keiyaku.with captures caller-awaited immutable Settings synchronously with ZERO I/O/namespace validation; operation consumption derives lazily without rereading. Omitted Settings = barecore gates[]/literalwords/emptyhooks/freshnessfalse. Provided empty Settings = product bind omitted gates fallback reviewed; named expansion/literal and firstseen dedupe retained. Explicit[] and amend omitted and fork admitted-gates copy never gate namespace lookup. Namespace failure scoped to consuming operation, preadmission KeiyakuError invalid-input native SettingsError; no fallback/refusal. CLI/Body manual gates/hooks/freshness derivation deleted in P6. Real nonCLI/nonBody external body-request consumer evidence triggers stop/report; fixtures migrate internal. All decisions settled; implementation waits BOTH acceptedP4/P5.
createdAt: 2026-09-30T01:39:13.227Z
updatedAt: 2026-10-01T04:19:55.638Z
---
Maps1741.4/5; after CLI and unified Akuma SDK consumers exist. Package entries only root and plugin; root also exports Task/Tasks and kanshi, delete akuma/akumas/task/kanshi subpath promises and migrate integrations/skills/tests/consumer fixtures. Remove internal request routing/receipt/execution/composition/config helper exports, gate/hooks/freshness derive from explicitly supplied Settings in Keiyaku.with rather than callers reconstructing private config. Preserve owner separation, coordinate/provenance/capture-once semantics and explicit settings failures; do not infer actor from ambient process or broaden action authority. No legacy exports/compatibility bridge. Accept npm-pack installed root consumers plus plugin entry, all official integrations migrated, removed names/entry paths fail type/package tests while documented kept symbols work, no generic mixed orchestration facade, full npm test/typecheck/lint/build/architecture/package verification and final measured responsibility+census report. New public changes need reason before edits and owner law same coherent commit. Task tree external approval1742 required before binding.
Task tree APPROVED1744. Final public closure needs BOTH P4 and P5 now they are parallel; same-change public-api/config/entry law and official consumer migration, not root-only doc follow-up.