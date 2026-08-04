---
id: 收窄-refoperation-至-claim-单次-ca-d09b3da2
title: 收窄 RefOperation 至 claim 单次 CAS move；删 candidate-ref/retention 测试宽度
state: open
pri: 1
needs: []
parent: null
from: []
createdAt: 2026-08-04T04:26:17.812Z
updatedAt: 2026-08-04T04:26:17.812Z
creator: thekoc
---
Square #93 已裁（律三）：RefOperation 唯一合法读者是 claim 的单次 CAS move（一个 ref，expectedOid 与 newOid 皆非空）。

- 收窄 RefOperation 类型与 admission/repository 处理到该形状；删 create/delete/GC 宽度（admission.ts:224/425/444、repository.ts:148/199/276/308/335 相关分支）。
- 删 tests/facts-admission.test.ts:155 起的 candidate-ref fixture 与 :162/:204/:207/:214 断言。
- ref 的创建/删除归 reconcile，不归 admission。
- 若有更宽形状的合法读者，先到 square 指名读者再动。

先于 petition/claim slice 落地，让 claim owner 建在窄类型上。验收：faye 亲验 diff。
