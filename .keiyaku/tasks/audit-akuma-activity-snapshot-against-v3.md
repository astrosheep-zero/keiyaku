---
id: task/audit-akuma-activity-snapshot-against-v3
title: Audit Akuma activity snapshot against v3
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: "Audit complete. v4 implements native adapter -> typed AgentEvent codec -> 5,000-event Heart ledger -> pure fold -> pure 8-settled + 2 latest said/thought + all in-flight selector -> AkumaStatus/wait -> pure tool/text render; history is a separate cursor page and full answers remain TurnFacts. Cleaner intentional cuts versus v3: usage/cost telemetry, structured plan, warning taxonomy, update/delta streams, terminal file ledger, and projection-generation retention machinery. Confirmed bug: answered rows render provider historyId as the Akuma selector in 'keiyaku history <historyId> --last'. Product regressions: no terminal-width/multiline bound for up-to-16,384-char rows; plural wait has no v3-style global detail budget. Decisions needed before implementation: whether status should expose pruned-retention truth and whether body/turn boundaries merit visible rows. Existing time suppression, spine, tool repr, in-flight pinning, said/thought retention, pending tells, diffstat, duration, and history cursors are implemented."
createdAt: 2026-08-12T04:57:39.863Z
updatedAt: 2026-08-12T05:03:18.448Z
---
Read-only architecture and product audit of v4 Akuma snapshot behavior against v3 evidence. Separate launch configuration snapshots from status/wait ActivitySnapshot and persistent history pages; trace native provider event -> normalized activity -> heart retention -> pure snapshot selection -> public facade -> CLI rendering. Compare retained categories, pinning, budgets, tool representation, timestamps, history cursors, final outcome, pending tells, failure isolation, and stdout density. Report concrete implemented behavior, missing behavior, intentional cuts, and any owner-law/implementation mismatch before proposing changes.