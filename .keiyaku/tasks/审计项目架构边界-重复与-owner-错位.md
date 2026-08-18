---
id: task/审计项目架构边界-重复与-owner-错位
title: 审计项目架构边界、重复与 owner 错位
state: open
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-17T03:25:45.037Z
updatedAt: 2026-08-18T03:55:24.954Z
---
本任务是当前代码的模块级事实账本与交付拆分，不是架构权威。六个互不重叠的 Akuma lane 负责 Contract/Protocol、Akuma runtime、Task/Kanshi/CLI、Git/storage、Core/Body/Verification/Settlement 和当前测试的调用证据；以下成立性、边界、删除项和依赖由主 agent 对照 owner law 裁决。

## 已确认的模块疾病

1. Architecture policy 以 1071 行、200 个 source rule、547 个逐文件/逐 symbol allowance 镜像当前源码拓扑。几乎每个功能提交都要同步改 policy；绿色结果只能证明代码符合现有白名单，不能证明 owner 边界正确。应保留 capability ownership、forbidden patterns 和跨 owner 方向，删除 owner 内部拓扑镜像。
2. protocol/operations.ts 混合 read、amend、deliver/review、audit、reconcile 等独立变化原因；run、fenced placement、amend、deliver、review 又重复 attempt lifecycle。admitDecidedOffer 仍是唯一 admission judge。先收敛 retry orchestration，再按变化原因拆 operation modules。
3. git/repository.ts 是 26 个文件依赖的 primitive hub，同时承载 repository/worktree discovery、process execution、refs、trees/blobs/commits、atomic ref update 与 diff codec。它不是一个 lifecycle transaction，应在 Git owner 内按 primitive 变化轴拆。git/reconcile.ts 与 git/target-placement.ts 各自仍是完整 effect/lifecycle owner，不因体量拆散。
4. Akuma requests.ts 同时承载 request wire codec、文件 transport、caller admission、server-side call/wait/tell/kill execution、pump/recovery/settlement；body.ts 同时承载 lease/supervision、provider turn state machine 和 request integration。应先拆 Request 内部变化轴，再把 Body supervision 与 turn execution分离，不新增第二 Heart 或 lifecycle judge。
5. Heart transaction/schema authority保持单一，但 heart/rows.ts 把 lifecycle、session/turn/activity、request、control/kill 全部 table mechanics 暴露为一个 51-export internal hub。可按 fact family 分成 coherent row modules，index/storage 继续拥有 transaction 与裁决。
6. Workspace Place 的真实生产路径是批量 allocation/release；firstFreePlace、单项 appoint/release 只被测试维持。contract-worktree 的 Managed projection 又保留一个自行重读 Place register 的 fallback，而全部生产调用者都已传入同一 snapshot。删除假单项 surface，并让 Place snapshot 只由 owner 读取后向下传递。Here appointment 的 repair tolerance 是 workspace.md 明定语义，保留。
7. src/index.ts 手工重复 src/library/keiyaku.ts 已经策展过的 package-root export 清单，二者在最近相关变化中 25/27 次共同修改。package public surface 仍需精确测试，但策展清单只保留一份。
8. Contract 与 Arc decoder 各自实现相同顶层 Markdown envelope 判定，差异仅是专属 section 集合。共享 envelope primitive，各产品 decoder保留自己的 section law。Body render/amend 的 preserved-byte职责不因此合并。
9. Protocol delivery input 把当前所有生产调用都提供的 document derivation建模为 optional，制造 active delivery 中无生产状态的 unavailable 分支。收紧内部 input 并删除该分支，不改变 public refusal。
10. Task 普通 mutation 与 compose 双写 updatedAt 单调推进规则；共享纯 advancement，保留不同 clock capture。projectReady 无生产或测试读者。
11. 内部 production module 存在一批仅由测试维持或完全无读者的 exports/wrappers。当前 knip gate只检查 files/dependencies，不检查 production exports。先清理真实 public/internal边界，再让 reachability gate 阻止 test-only production surface 回流。
12. 测试删除以“同一生产路径、同一输入状态、同一 outcome”为准。当前确认 show/history 的假 --json invoke 断言，以及两组重复 Workspace Place 状态测试；不同 recovery、birth、corruption状态不合并。

## 已否定的伪问题

Kanshi read 是合法 composition root；CLI invoke 与 Library Contract handle 是 public composition boundaries；Git reconcile、target placement、Settlement holder、Dispatch、Verification execution各自仍是单 owner lifecycle。Akuma 单成员不可读时静默 skip 正确。Task Markdown不是数据库投影。文件长度、240 行或跨目录 import 数量本身都不是架构结论。

## 交付约束

保留 120-column max-len signal，不通过压行满足 max-lines。owner 单一不等于所有能力必须塞在一个文件。模块拆分不得新增 barrel、registry、wrapper 或第二 adjudicator；每个切片必须减少一个同步修改点或删除一个无生产状态。durable law只写回唯一 owner 文档，Task 和测试不复制 law。
