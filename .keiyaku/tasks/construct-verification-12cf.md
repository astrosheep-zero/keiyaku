---
id: task/construct-verification-12cf
title: Construct Verification environment from snapshot inputs
state: drop
priority: 1
needs: []
parent: null
supersedes:
  - task/post-audit/allow-verification-ambient
relates: []
note: "Faye dissolution: Verification testimony intentionally identifies subject snapshot+verification segment, not runner environment; current policy already owns process-environment under verification/**. No implementation or law change."
createdAt: 2026-09-02T04:39:42.070Z
updatedAt: 2026-09-02T05:27:16.502Z
---
Implement Faye P1-B (act/1203, act/1205): Verification execution must construct child process environment from the immutable integration snapshot and stop forwarding ambient caller process.env as execution input. Preserve reuse keyed by snapshot plus verification segment; do not persist full environment in attestation subject. Update docs/verification.md to state constructed environment and remove the stale protocol process-environment capability exception. Add environment variance/reuse regressions. Scope src/verification/execution.ts, protocol call plumbing, docs/verification.md, scripts/architecture/policy-capabilities.ts, focused tests. Do not touch P1-A, Fleet, architecture parser, or forwarding codec.