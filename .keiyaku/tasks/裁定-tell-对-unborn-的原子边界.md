---
id: task/裁定-tell-对-unborn-的原子边界
title: 裁定 tell 对 unborn 的原子边界
state: done
priority: 1
needs: []
parent: task/complete-the-provider-core-capability-model
supersedes: []
relates: []
note: ""
createdAt: 2026-08-08T19:14:47.569Z
updatedAt: 2026-08-12T16:59:32.105Z
---
依据 docs/akuma.md 的 birth、Tell 与 one-judge law，处理 Faye act 66 发现的 ghost effect：当前 AkumaHandle.tell() 先 recordTell 落账，再在 readSoul() 为 null 时抛异常，caller 观察失败但 tell 已持久化且未来 body 可消费。先裁定 pre-birth tell 是 typed refused-unborn 还是合法输入；随后在唯一 heart transaction judge 中实现，不做 capability 层事后 born pre-check，并覆盖持久化/返回值一致性测试。不要混入 status/wait 或 interrupt cut。
