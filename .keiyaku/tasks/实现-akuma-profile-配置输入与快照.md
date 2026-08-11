---
id: task/实现-akuma-profile-配置输入与快照
title: 实现 Akuma Persona 配置输入与快照
state: done
priority: 0
needs:
  - task/收束-akuma-heart-存储机械与领域法律
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-08T17:32:14.610Z
updatedAt: 2026-08-08T18:43:25.761Z
contractId: null
---
依据 docs/akuma.md owner law 与 Faye act_57/act_60，在同一 coherent change 中成文并实现 ~/.keiyaku/akuma/<name>.md Persona 文法：frontmatter provider/model/access/network/effort/description，正文为 system prompt。akuma.ts 负责边界解析与 provider literal map 校验；恢复 ProviderOptions 与 SessionFact.options 的 producer/reader 链；description 在 birth 时写入 soul 快照，list/status 不回读 home 文件；缺失 persona typed 拒绝并返回搜索路径。Soul.profile、call({profile})、identity/目录投影与 owner law 全部硬切为 persona，不保留 alias，更新 focused tests、CLI rendering、typecheck/build/full verification，不建立新配置层或第二权威。
