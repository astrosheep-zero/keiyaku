---
id: task/继承-wait-与-kill-的多目标-cli-语法
title: 继承 wait 与 kill 的多目标 CLI 语法
state: drop
priority: 2
needs: []
parent: null
supersedes: []
relates: []
note: Superseded by the approved high-level facade hard-cut slices; retain no stale semantics.
createdAt: 2026-08-10T01:48:51.212Z
updatedAt: 2026-08-11T02:05:05.239Z
---
v4 CLI 继承 v3 wait 的多投影选择：多个 aku 地址必须显式 --any 或 --all，并保留 deadline/timeout 语义；kill 同样接受多个 aku 地址，按稳定输入顺序返回每个 typed receipt。补齐 argv、库调用、文本/JSON 输出、退出码和并发/部分失败测试。