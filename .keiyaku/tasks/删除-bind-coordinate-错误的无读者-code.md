---
id: 删除-bind-coordinate-错误的无读者-code
title: 删除 bind coordinate 错误的无读者 code
state: drop
pri: 1
needs: []
parent: null
from: []
notes:
  - actor: thekoc
    timestamp: 2026-08-07T04:49:03.473Z
    text: 错误 subclass/code 已删除；旧任务残留的观察 Git 后抛 TypeError 要求违反 public-api 的 package-edge 输入错误边界，不继续实现。
createdAt: 2026-08-06T19:06:17.147Z
updatedAt: 2026-08-07T04:49:03.473Z
creator: thekoc
---
BindCoordinatesObservationError 与 code 只有测试 deep-import，生产 CLI 只读 Error.message。删除 error code union、subclass 与 export，直接抛 TypeError 保留现有可见诊断；测试改断言 message，不保留兼容别名。
