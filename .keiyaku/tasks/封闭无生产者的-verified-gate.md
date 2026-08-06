---
id: 封闭无生产者的-verified-gate
title: 封闭无生产者的 verified gate
state: open
pri: 0
needs:
  - attestation-subject-统一证词与-gat-da92658b
parent: null
from: []
createdAt: 2026-08-06T05:42:19.442Z
updatedAt: 2026-08-06T05:42:19.442Z
creator: thekoc
---
当前输入允许 gates 包含 verified 而 Verification 声明为空；producer 因无声明永不运行，契约会进入永久不可满足状态。该问题已在 Square #175 明确列为独立输入侧缺口，但解决方式尚未落 owner law。

先在 lifecycle/public-api owner docs 定案：无 producer 的义务必须在 bind/amend 边界拒绝，或提供另一种明确 producer；不得把永久死锁写进 journal。随后只在唯一输入裁判实现，并增加 bind 与 amend 的精准边界测试。
