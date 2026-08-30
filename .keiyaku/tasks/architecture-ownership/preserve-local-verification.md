---
id: task/architecture-ownership/preserve-local-verification
title: Preserve local Verification through captured channel
state: done
priority: 0
needs: []
parent: task/architecture-ownership/inject-one-per-drive-execution
supersedes: []
relates: []
note: Claimed execution-channel delivery 2b25f730 is on main; current library-verification passes 12/12.
createdAt: 2026-08-28T13:59:06.988Z
updatedAt: 2026-08-30T07:02:53.437Z
---
Routing candidate regression: 
> @astrosheep/keiyaku@4.5.7 test:focused
> node scripts/run-tests.mjs tests/library-verification.test.ts

......XX.XX.

Failed tests:

✖ Verification provisions only the candidate Settings environment and destroys it afterward (793.949916ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected
  
    [
      'bound',
      'deliver',
  -   'attestation',
  -   'claimed'
    ]
  
      at TestContext.<anonymous> (/Users/astrosheep/Developer/keiyaku-v4/tests/library-verification.test.ts:281:10)
      at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
      at async Test.run (node:internal/test_runner/test:1389:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:960:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: [ 'bound', 'deliver' ],
    expected: [ 'bound', 'deliver', 'attestation', 'claimed' ],
    operator: 'deepStrictEqual',
    diff: 'simple'
  }
✖ candidate create failure stops Verification with no attestation and still runs destroy (752.74375ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  
  false !== true
  
      at TestContext.<anonymous> (/Users/astrosheep/Developer/keiyaku-v4/tests/library-verification.test.ts:313:10)
      at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
      at async Test.run (node:internal/test_runner/test:1389:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:960:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: false,
    expected: true,
    operator: 'strictEqual',
    diff: 'simple'
  }
✖ caller cancellation admits no attestation and still destroys scratch (2628.548083ms)
  Error: timed out waiting for /private/var/folders/xd/ln7zbjqx4xsdgd6n98ln_wb80000gn/T/keiyaku-v4-snapshot-aiiIVl/repository/.keiyaku/wt/bathtub/verification-started
      at waitForFile (/Users/astrosheep/Developer/keiyaku-v4/tests/library-verification.test.ts:247:46)
      at async TestContext.<anonymous> (/Users/astrosheep/Developer/keiyaku-v4/tests/library-verification.test.ts:365:3)
      at async Test.run (node:internal/test_runner/test:1389:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:960:7)
✖ destroy failure is cleanup evidence, not a leak after successful removal (750.7165ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected
  
  + undefined
  - {
  -   command: 0,
  -   detail: {
  -     code: 19,
  -     kind: 'exit',
  -     stderr: '',
  -     stdout: '',
  -     truncated: false
  -   },
  -   phase: 'destroy'
  - }
  
      at TestContext.<anonymous> (/Users/astrosheep/Developer/keiyaku-v4/tests/library-verification.test.ts:389:10)
      at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
      at async Test.run (node:internal/test_runner/test:1389:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:960:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: undefined,
    expected: { phase: 'destroy', command: 0, detail: { kind: 'exit', code: 19, stdout: '', stderr: '', truncated: false } },
    operator: 'deepStrictEqual',
    diff: 'simple'
  } deterministically fails four cases even with AKUMA_REQUESTS unset. Local deliver loses attestation/claim, candidate-create failure and cancellation cleanup evidence, and destroy failure projection. Diagnose the captured-channel path and restore the exact pre-Routing local Verification/cleanup semantics without weakening one-hop forwarding. Add or adjust focused regression coverage, rerun the full file plus Arc routing suites and gates, then leave only intended changes.