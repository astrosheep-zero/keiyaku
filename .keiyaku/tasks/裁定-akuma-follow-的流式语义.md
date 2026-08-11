---
id: task/裁定-akuma-follow-的流式语义
title: 裁定 Akuma follow 的流式语义
state: open
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-08T19:58:56.554Z
updatedAt: 2026-08-08T19:58:56.554Z
---
Faye Cut 1 里程碑 review 指出：public 名称 follow 暗示运行中 tail，但现行 docs/cli.md 与实现会等待 public AsyncIterable 结束后一次性返回 collected AgentEvent[]；当前没有活着的 reader 在 running 期间消费事件。依据 docs/akuma.md 与 docs/cli.md，从真实 caller workflow 裁定 follow 应是流式 transport、批次 observation，还是删除；先定唯一 reader 与 CLI 输出/退出/取消语义，再改实现，不让名字和法条各成权威。