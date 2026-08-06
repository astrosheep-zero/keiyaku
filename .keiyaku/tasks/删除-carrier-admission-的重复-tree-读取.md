---
id: 删除-carrier-admission-的重复-tree-读取
title: 删除 carrier admission 的重复 tree 读取
state: open
pri: 1
needs: []
parent: null
from: []
createdAt: 2026-08-06T18:54:54.867Z
updatedAt: 2026-08-06T18:54:54.867Z
creator: thekoc
---
CarrierSnapshot.paths 已来自同一 immutable tree；publish 构树不得再次 ls-tree 同一 baseTree。让 buildTree 复用已观察 entries，保持 tree bytes、排序和 admission CAS 不变，并用精准测试证明一次 admission 不发生第二次 ls-tree。
