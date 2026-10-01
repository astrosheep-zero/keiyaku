---
id: task/akuma-长时间等待时持续消耗-cpu-并出现-gb-9984
title: Akuma 长时间等待时持续消耗 CPU，并出现 GB 级内存增长
state: in_progress
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-09-30T16:18:51.341Z
updatedAt: 2026-10-01T03:19:15.452Z
---
## 问题
Akuma 在工具权限等待等长期无进展状态下，仍持续消耗 CPU，body 进程出现 GB 级内存占用；状态显示 running，无法直接辨认实际在等待授权。

## 现场证据（2026-10-01，macOS 16GB）
- bio aku/intern/6c4f1775：body PID 5559，运行约 5 天 10 小时，top MEM 约 3.85GB；最后活动 2026-09-25 14:24（本地时间），裸 bash/文件读取后记录 permission.asked，随后无进展。OpenCode 本地 permission/session-status 查询返回 HTTP 500。
- bio aku/intern/7b61dfa8：body PID 73884，运行约 2 天 9 小时，top MEM 约 1.7GB；最后活动 2026-09-28 15:00。OpenCode permission 接口确认 external_directory 请求仍待批准，路径 /Volumes/Data/bio/chase-review-20260928/*，session 状态 busy。
- 两个 body 在无新工作活动时 ps CPU 各约 3%；MEM 来自 macOS top，并非 ps RSS，后者会低估已压缩/换出的占用。
- 同期全机 CPU 曾 0% idle，15GB 物理内存已用，swap 约 19.9GB；并行 pi 和其他测试遗留进程也在消耗资源，因此不能把全机压力全部归因于这两个 body。

## 代码证据与待确认因果
- src/akuma/body-supervisor.ts：100ms 周期读取 Heart，并发布新快照。
- src/akuma/turn-drive.ts consumeTurnDrive：循环内反复 Promise.race，对可能长期未完成的 provider 事件和失败通知 Promise 注册回调；Heart 分支返回后继续循环。build/src/akuma/ 中也确认存在对应代码。
- Promise.race 不取消未获胜分支；长期未完成 Promise 的回调累积是内存增长的明确嫌疑点。尚未做 heap profile，未量化实际存活对象，不能宣称已证明全部 GB 级占用的来源。

## 影响
停滞 worker 长时间占用宿主资源；用户难以辨认阻塞原因；多个遗留 worker 叠加可能造成严重内存压力和换页。

此 Task 仅记录问题与证据，不规定解法。
User authorized repair Oct1. Started; fresh intern aku/intern/0645764b (@repair-memory-prebind) commissioned bounded pending-provider/control retention diagnosis and prebind design. Outputs /tmp/kei-repair-memory-prebind-20261001. GB/CPU causality remains unproven; no implementation or acceptance claimed.
Read-only real driveTurn probe establishes per-control-tick retained reactions:200kobservations->200kreactions, disposable bounded prototype->1; fieldGB attribution remains inferred, CPU separate. Narrow partial repair ACTUALLY bound kei/bound-stalled-turn-observation-f893, reviewedgate, sole fresh intern aku/intern/95a3b7f0 in wt/minecraft. Unassociated broadTask deliberately remainsinprogress for residualCPU/fieldunknowns; no automaticdoneclaim. Full4Criteria+Objective commission/tmp/kei-repair-memory-writer-commission-20261001.md.
Oct1 11:17 NARROW PARTIAL REPAIR ACTUALLY ACCEPTED kei/bound-stalled-turn-observation-f893: landed5dcba03bfec0297b334548a6910af05cb422683b/tree08f2bd2cbc46eb7219649a593e84d97672791285, verified01M3TQ4R9J7JKTXXCRE20ARRJC all3declaredchecks exit0 exactclean-scratch, redelivered01M3TQ5M3GSFM2RY3AXH8SV5NV, independently whole4Criteria+Objective reviewed01M3TQEA0SEVVGMM24D47VV5CG/claimed01M3TQEAA1XBJNKY4427ZBMDRJ. RealdriveTurn counted stalled-provider source stays at1registration for20k/200kcontrolobservations; baseline hadlinearregistration. Native liveTell/order/session/completion-failure/stop/Heartloss semantics andactualcustody preserved; conceptualownerlaw updated, no newpolling/timer/public/durablepolicy. Minecraft physicallyretired, no pending/holder/settlementlag. Historical6bdc470 laterUNSAT01M3TJTZAKWA9FPPT3QKJT366P andduplicateattestation remain honesthistory, not reused/current. This Task REMAINS IN_PROGRESS: historicalGB attribution lacksfieldheapprofile and residualCPU/permission-waitvisibility remainoutside narrow repair; no allhostclaim. Releaseplan numeric values are elapsedms, not testcasecounts.