---
id: task/architecture-convergence/make-body-schemas-statically
title: Make Body schemas statically authoritative
state: done
priority: 0
needs: []
parent: task/architecture-convergence/converge-the-full-post-audit
supersedes: []
relates: []
note: Revised candidate f26b887b; zero type-silencing casts; full host npm test green.
createdAt: 2026-08-29T13:19:20.796Z
updatedAt: 2026-08-29T13:48:40.212Z
---
Same active Result Contract. Remove every `as unknown as z.ZodType` silencing assertion; use schema-inferred boundary structural types and compiler-checked bindings for domain-owned values. Preserve the net deletion and all green gates.