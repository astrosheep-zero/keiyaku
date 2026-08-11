---
id: task/删除-carrier-admission-的重复-tree-读取
title: 删除 carrier admission 的重复 tree 读取
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-06T20:26:05.944Z
updatedAt: 2026-08-07T11:29:07.445Z
---
CarrierSnapshot.paths 已来自同一 immutable tree；publish 构树不得再次 ls-tree 同一 baseTree。让 buildTree 复用已观察 entries，保持 tree bytes、排序和 admission CAS 不变，并用精准测试证明一次 admission 不发生第二次 ls-tree。