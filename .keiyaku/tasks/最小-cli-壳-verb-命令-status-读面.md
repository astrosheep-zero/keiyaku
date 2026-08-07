---
id: task/最小-cli-壳-verb-命令-status-读面
title: 最小 CLI 壳：verb 命令 + status 读面
state: drop
priority: 1
needs:
  - task/第二切片-petition-claim-pure-owners-672d9b8d
  - task/approve-review-纯-owner-测试
  - task/reconcile-owner-open-建-renew-移-clai-3a031187
  - task/actor-来源-keiyaku-projection-id-注-9d9b432c
parent: null
supersedes: []
relates: []
contractId: null
---
无任何可执行入口（package.json 无 bin/main，无 src/cli）。补最薄的一层壳：解析输入 → 生成 actor/at/ULID attempts → 调 runProtocol → 成功后调 reconcile → typed 输出。命令面：bind / amend / open / seal / renew / petition / review --approve|--changes-requested / claim / forfeit / status（observe 读面的 CLI 化）。壳不含语义：所有判定在 core，壳只做 envelope。不加 v3 的任何兼容面。