---
id: 删除-bind-coordinate-错误的无读者-code
title: 删除 bind coordinate 错误的无读者 code
state: open
pri: 1
needs: []
parent: null
from: []
createdAt: 2026-08-06T19:06:17.147Z
updatedAt: 2026-08-06T19:06:17.147Z
creator: thekoc
---
BindCoordinatesObservationError 与 code 只有测试 deep-import，生产 CLI 只读 Error.message。删除 error code union、subclass 与 export，直接抛 TypeError 保留现有可见诊断；测试改断言 message，不保留兼容别名。
