---
id: task/删除无生产读者的-keiyaku-worktreepath
title: 删除无生产读者的 Keiyaku worktreePath
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
contractId: null
---
依据 docs/public-api.md 的最小 package-root surface 与 existence razor，删除 Keiyaku.worktreePath public getter。生产 CLI selector 已从一次 repo.status() 的 ContractStatus.worktreePath 读取，仓库内无其他 production reader；当前 getter 只驱动测试，并额外触发 protocol/repository discovery。

删除 getter、worktreePathOperation 及 package-root export/docs/tests 中只为它存在的路径；保留 StatusReport.worktreePath，因为 selector 与 status board 有真实读者。不得新增替代 getter、别名或兼容层。