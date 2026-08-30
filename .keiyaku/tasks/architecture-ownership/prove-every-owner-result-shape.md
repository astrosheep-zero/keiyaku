---
id: task/architecture-ownership/prove-every-owner-result-shape
title: Prove every owner result shape
state: done
priority: 0
needs: []
parent: task/architecture-ownership/close-heart-ownership-policy-and
supersedes: []
relates: []
note: ""
createdAt: 2026-08-28T09:57:25.187Z
updatedAt: 2026-08-28T10:33:04.778Z
---
Replace generic recursive-JSON result guards with complete runtime codecs for TaskMutationResult and TaskView, Contract delivery/review receipts and their required facts, and Fleet AkumaStatus/timeline projections. Every malformed cross-process result must become transport-integrity failure. Reproduce and close review journal 01M13WNMN16RM1H5VQK2YMWMY3 finding 1.
2026-08-28: Task, Contract, and Fleet runtime result decoders now reject malformed cross-process shapes; facts are validated through the journal codec, Contract receipts validate required delivery/review evidence, and Fleet validates status timelines. Evidence: npm run test:typecheck (pass); npm run test:architecture (pass); timeout 120s node --test --test-reporter=spec --import tsx tests/akuma-body-requests.test.ts (30 pass, 0 fail).
2026-08-28 follow-up: Task live-result codec is now owned by src/task/mutation-result.ts, with closed TaskView, refusal, batch, update, and composition variants; no recursive JSON guard remains. Evidence: typecheck and architecture pass; focused akuma-body-requests suite 30/30 passes.
2026-08-28 final codec-owner evidence: Contract forwarding, Fleet result, and Fleet status codecs are now isolated in coherent owner modules with named strict variant decoders. Evidence: npm run test:typecheck (pass); npm run test:architecture (pass); npm run test:maintainability (0 errors, 22 existing warnings); env -u AKUMA_REQUESTS timeout 180s node --test --test-reporter=spec --import tsx tests/akuma-body-requests.test.ts (30 pass); tests/facade-fleet.test.ts (29 pass); tests/akuma-requests.test.ts (15 pass); tests/library-contract-operations.test.ts (39 pass).