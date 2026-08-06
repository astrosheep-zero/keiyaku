---
id: 迁移-library-方言与-verification-aca216f8
title: 迁移 library 方言与 verification 业主准入
state: in_progress
pri: 0
needs:
  - 硬切-core-document-terms-与-key-set-d85bf6bb
parent: null
from: []
notes:
  - actor: thekoc
    timestamp: 2026-08-06T23:05:50.290Z
    text: "Audit correction after staged-decide: do not restore a library preflight, but protocol must also not reimplement dialect law as declarationFailure(terms.gates.includes(verified) && verification === null). The dialect/document owner should produce a typed prepared/refused derivation once; the completed core decision receives that staged result so lifecycle/document precedence remains singular. Remove the hard-coded gate/declaration legality formula from protocol."
createdAt: 2026-08-06T10:46:37.377Z
updatedAt: 2026-08-06T23:05:50.290Z
creator: thekoc
startedAt: 2026-08-06T12:06:35.934Z
---
把五 section 模板、分段、amend 操作、reviewed/verified 名称及生产者最小依赖集留在 library/verification 方言；verification 指令退出 core，verified 无指令在 bind/amend 外围 typed refusal。公开接口删除 ContractBody 结构和 render，CLI diff 直接使用文档文本。
