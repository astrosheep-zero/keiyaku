---
id: task/replace-source-topology-architecture-allowlists
title: Replace source-topology architecture allowlists with owner rules
state: drop
priority: 0
needs: []
parent: task/审计项目架构边界-重复与-owner-错位
supersedes: []
relates: []
note: "Rejected: line count, allowlist count, and co-change frequency do not establish duplicate adjudication. Sampled policy changes each admitted an explicit capability edge, and no ungated divergent judge was constructed; the single conformance guard is designed drift friction."
createdAt: 2026-08-18T03:55:57.451Z
updatedAt: 2026-08-18T04:27:04.787Z
---
保留真正的 architecture invariants：跨 owner 依赖方向、敏感 capability owner、禁止的模型/声明/源码模式，以及 public composition boundary。删除对 owner 内部每个 source file、import symbol 和当前 topology 的逐项镜像。

验收必须用最小 fixture 证明非法跨 owner edge 仍失败、合法 owner 内重组不需要登记每个文件。同步缩小 policy/engine 的 max-lines exemption；不以放开所有 src import 作为简化。