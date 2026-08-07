---
id: task/实现region闭合方言与精确相交
title: 实现Region闭合方言与精确相交
state: done
priority: 0
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-07T04:48:13.239Z
updatedAt: 2026-08-07T11:29:07.449Z
contractId: null
---
Round-trip hole: Region grammar currently permits repository path bytes containing ``` or ~~~, but renderContractBody hardcodes a triple-backtick fence. A legal Region pattern such as ``` becomes a premature closing fence after amend render/decode. Reuse one body-level safe fence renderer (the Verification renderer already computes delimiter/length) for both Verification and Region; add one precise legal-delimiter-pattern round-trip test, without banning valid path characters merely to protect rendering.