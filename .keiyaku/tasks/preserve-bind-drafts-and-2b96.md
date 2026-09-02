---
id: task/preserve-bind-drafts-and-2b96
title: Preserve bind drafts and aggregate syntax errors
state: done
priority: 2
needs: []
parent: null
supersedes: []
relates:
  - task/close-architecture-checker-c421
note: "Bind already reads stdin before admission and preserves invalid input through BindDraftError/preserveBindDraft; src/markdown/lex.ts currently throws only parsed.errors[0]. Implement exact draft preservation plus all deterministic syntax diagnostics in source order, with no Contract/Task effects on syntax failure. Keep valid binds, typed refusals, and draft retention policy unchanged. Scope: src/markdown/lex.ts, src/cli/commands/contract-invoke.ts, src/cli/draft.ts, relevant parser/CLI tests. Acceptance: multi-error bind returns one typed aggregate failure; exact stdin remains content-addressed and readable; no observation or journal/Task mutation; focused tests, typecheck, build pass."
createdAt: 2026-09-02T05:33:15.202Z
updatedAt: 2026-09-02T08:03:38.393Z
---
