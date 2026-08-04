---
id: 收窄-refoperation-至-claim-单次-ca-d09b3da2
title: 收窄 RefOperation 至 claim 单次 CAS move；删 candidate-ref/retention 测试宽度
state: open
pri: 1
needs: []
parent: null
from: []
notes:
  - actor: thekoc
    timestamp: 2026-08-04T06:08:13.618Z
    text: |
      验收通过（akuma worker-default/3f2c73c2，commit 710c6ce）：diff 仅四文件；Offer.refs 单元素 tuple（admission.ts:62），expectedOid/newOid 必填（:53-56）；空/多/null 拒绝（admission.ts:223/229/232 + 测试 :160/:164/:172）；repository 只接受 carrier+至多一个 claim CAS（repository.ts:330-348）；candidate-ref/retention 与 nested-ref lock fixtures 已删，全仓 rg 无运行时命中；slice-2 四文件 untracked 未触碰；34/34 tests，source-only typecheck 绿。
      遗留定位：stderr 文本匹配在 admission.ts:341（repository.ts:75/81 组装 message）——归 transport-83312530 处理。
createdAt: 2026-08-04T04:26:17.812Z
updatedAt: 2026-08-04T06:08:13.618Z
creator: thekoc
---
Square #93 已裁（律三）：RefOperation 唯一合法读者是 claim 的单次 CAS move（一个 ref，expectedOid 与 newOid 皆非空）。

- 收窄 RefOperation 类型与 admission/repository 处理到该形状；删 create/delete/GC 宽度（admission.ts:224/425/444、repository.ts:148/199/276/308/335 相关分支）。
- 删 tests/facts-admission.test.ts:155 起的 candidate-ref fixture 与 :162/:204/:207/:214 断言。
- ref 的创建/删除归 reconcile，不归 admission。
- 若有更宽形状的合法读者，先到 square 指名读者再动。

先于 petition/claim slice 落地，让 claim owner 建在窄类型上。验收：faye 亲验 diff。
