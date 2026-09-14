---
id: task/usability/close-schema-call-self-busy-2318
title: Close schema call self-busy birth window
state: done
priority: 1
needs: []
parent: task/usability/investigate-inconsistent-full-6096
supersedes: []
relates: []
note: ""
createdAt: 2026-09-09T23:32:48.468Z
updatedAt: 2026-09-10T00:33:19.331Z
---
REVISION2_FULL_SUITE_BLOCKERS_REPORT.md proves schema Keiyaku.call publishes an empty Body and immediately admits its schema Tell, so Heart can truthfully reject the library’s own next operation as Busy. Close the ordering at body-less publication custody for local and forwarded routes while preserving one public schema Tell, dedicated schema Turn, Busy semantics, and detach behavior. No retry, weakened assertion, or timeout-only concealment.
Claimed/placed integration 7e7b7e8f77d75893ee3dbe471896aaf20761120f over f1717df after revision-2 complete candidate review, exact integration review, and all four Verification declarations satisfied. Real local and parent-served forwarded slow-publication cases discriminate missing propagation; one Tell/no initial Call/dedicated schema Turn preserved. Receipts: evidence/schema-self-busy-delivery.json and schema-self-busy-final-review.json. Prior full-suite contrary evidence is retained independently.