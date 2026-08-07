---
id: 迁移-library-方言与-verification-aca216f8
title: 让 document 方言唯一裁定 Verification declaration
state: open
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
updatedAt: 2026-08-07T04:59:19.778Z
creator: thekoc
---
依据 docs/document.md、docs/verification.md 与 docs/lifecycle.md，删除 protocol 对 Verification declaration 合法性的第二裁判。

当前可构造问题：src/protocol/operations.ts 的 declarationFailure 直接用 terms.gates.includes(VERIFIED) 与 verification === null 重写方言规则；amend 的 terminal、document-moved 与 declaration-invalid 因而可能由不同层抢先返回。

完成条件：

- document/verification 边界从同一份 stamped document derivation 产出 typed prepared/refused declaration；bind 与 amend 复用这一产出。
- protocol 只把 preparation 送入现有法定 decide，不再包含 gate 名称与 Verification definition 的合法性公式。
- active/current document 的无效声明返回 verification-declaration-invalid；terminal 与 document-moved 仍按 lifecycle 的唯一 decide 顺序优先。
- invalid terms 不得入账；不得增加 library preflight、generic lifecycle runner、registry、provider 或让 core 认识 reviewed/verified 产品词汇。
- 删除旧 declarationFailure，并用最小行为测试覆盖 bind invalid、active amend invalid、terminal precedence 与 concurrent document movement。
