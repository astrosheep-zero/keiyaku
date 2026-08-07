---
id: 让-region-编译值携带原始-source
title: 让 Region 编译值携带原始 source
state: done
pri: 1
needs: []
parent: null
from: []
createdAt: 2026-08-07T00:42:46.990Z
updatedAt: 2026-08-07T00:46:02.856Z
creator: thekoc
---
在 src/body/region.ts 引入私有 CompiledRegionPattern { source, segments }。compileRegionPattern() 返回完整编译值，regionsOverlap() 从匹配对象读取 source，删除原始数组与编译数组按 index 对齐。保留当前迭代匹配算法，禁止换成会在长模式栈溢出的递归实现。
