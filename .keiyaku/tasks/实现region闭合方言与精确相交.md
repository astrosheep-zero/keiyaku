---
id: 实现region闭合方言与精确相交
title: 实现Region闭合方言与精确相交
state: done
pri: 0
needs: []
parent: null
from: []
notes:
  - actor: thekoc
    timestamp: 2026-08-06T23:24:37.756Z
    text: "Round-trip hole: Region grammar currently permits repository path bytes containing ``` or ~~~, but renderContractBody hardcodes a triple-backtick fence. A legal Region pattern such as ``` becomes a premature closing fence after amend render/decode. Reuse one body-level safe fence renderer (the Verification renderer already computes delimiter/length) for both Verification and Region; add one precise legal-delimiter-pattern round-trip test, without banning valid path characters merely to protect rendering."
createdAt: 2026-08-06T15:49:00.365Z
updatedAt: 2026-08-07T04:48:13.135Z
creator: thekoc
---
