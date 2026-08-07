---
id: task/统一core-gate现行证词扫描
title: 统一core-gate现行证词扫描
state: drop
priority: 0
needs: []
parent: null
supersedes: []
relates: []
contractId: null
---
gateSatisfied and gatesSatisfied must share one newest-first current-subject adjudication implementation while gatesSatisfied stays O(attestations + gates), not every(gateSatisfied). Preserve latest same-subject override, stale-subject skipping, opaque gates, and fold/placement semantics.

与已完成的 eligibility/gates 线性化任务重复；当前 latestCurrentAttestations 是 status 与 gatesSatisfied 的唯一现行证词扫描，不新增无读者 gateSatisfied 包装层。