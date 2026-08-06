---
id: 迁移-library-方言与-verification-aca216f8
title: 迁移 library 方言与 verification 业主准入
state: open
pri: 0
needs:
  - 硬切-core-document-terms-与-key-set-d85bf6bb
parent: null
from: []
createdAt: 2026-08-06T10:46:37.377Z
updatedAt: 2026-08-06T10:46:37.377Z
creator: thekoc
---
把五 section 模板、分段、amend 操作、reviewed/verified 名称及生产者最小依赖集留在 library/verification 方言；verification 指令退出 core，verified 无指令在 bind/amend 外围 typed refusal。公开接口删除 ContractBody 结构和 render，CLI diff 直接使用文档文本。
