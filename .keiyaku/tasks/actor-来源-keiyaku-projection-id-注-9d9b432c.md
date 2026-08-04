---
id: actor-来源-keiyaku-projection-id-注-9d9b432c
title: actor 来源：KEIYAKU_PROJECTION_ID 注入与 --actor fallback
state: open
pri: 1
needs: []
parent: null
from: []
createdAt: 2026-08-04T07:23:56.953Z
updatedAt: 2026-08-04T07:23:56.953Z
creator: thekoc
---
为 v4 建立唯一的 actor 输入边界，不依赖 Akuma dispatch receipt 或 task 推导：

- Akuma 启动的进程显式继承 `KEIYAKU_PROJECTION_ID`，其值必须是完整的 v4 projection identity（例如 `aku/codex/1a2b3c4d`），不是再拼接前缀的局部 id。
- CLI/process boundary 只解析一次：环境变量存在时校验并使用它；环境变量缺失时要求显式 `--actor <identity>`。
- 环境变量和 `--actor` 同时存在但字节不一致时拒绝；两者都缺失时拒绝并给出可执行 usage guidance；环境变量存在但格式非法时不得静默 fallback。
- 解析出的 actor 原样进入 verb input、journal fact 与 deterministic candidate builder；环境变量本身不持久化，不读取 task、receipt、Git 配置、机器名或进程名。
- 覆盖测试：Akuma env、显式 flag fallback、缺失、非法值、同值双输入、冲突双输入，以及 actor exact bytes 贯穿 journal/candidate。

实现应保持 actor 解析在壳/调用边界，core 只接收已验证的 actor；不得新建第二作者字段或 dispatch receipt ledger。
