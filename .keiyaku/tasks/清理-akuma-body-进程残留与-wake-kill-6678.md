---
id: task/清理-akuma-body-进程残留与-wake-kill-6678
title: 清理 Akuma body 进程残留与 wake/kill 生命周期 race
state: in_progress
priority: 2
needs: []
parent: null
supersedes: []
relates:
  - task/修复-opencode-sse-取消缺失导致-akuma-41be
note: 2026-09-28 证据两则。① 孤儿body收割：elite-9cdbc47b (pid 13337)，run目录无journal。② aku/intern/97d28ba0 两次bash wedge (16:33/17:08，run row不落settle且provider下零子进程)；interrupt-steer于17:01 spawn替换body 35992（持live provider opencode:62217）但原body 73928（provider已死、零子进程、无turn所有权）从未被杀——一heart双body实锤，73928已手工收割。规律：interrupt-steer补新body不杀wedged旧body；provider bash wedge不spawn进程。
createdAt: 2026-09-23T05:37:12.382Z
updatedAt: 2026-10-01T03:19:15.891Z
---
已确认症状，不把猜测当成根因：snapshot fixture 清除后仍有 detached Body 存活，Heart/leash 路径已不存在。2026-09-23 追查现存 20 个 snapshot Body：全部 PPID=1；抽样解码 launch 全是 seed 缺失、refuseIfHeld=true 的 wake successor，而非 birth Body。它们继承测试 empty-publication barrier 环境，但该 loader 对无 seed 的 wake 直接跳过，因此 barrier 本身不是已证根因。怀疑 detached wake 在 fixture launch set 关闭后仍 spawn；需追踪具体异步边界和存活句柄并作受控复现。修复真正 custody/lifecycle 边界并留关键回归；不能仅杀现存 PID、让测试强制退出，或在别的 kei 中顺手扩大范围。
## 2026-09-30 UTC 现场补充：区分 SSE 与测试残留
本轮快照181个body：143个对应终态OpenCode身份、36个测试/probe已无Heart、2个活跃Pi。当前版本OpenCode SSE取消缺失已受控复现，单列 task/修复-opencode-sse-取消缺失导致-akuma-41be；不能据此解释全部测试残留或所有wake/kill症状。

新增不同样本：
- PID5115（旧ballpit运行时）保留referenced FSWatcher，监听已删除fixture的empty-publication-barrier目录，且仍有fixture leash FD。tests/support/akuma-body-empty-publication-loader.mjs在BodySupervisor.open之前注入等待，尚不受普通Heart-loss/control监督。它与2026-09-23无seed/wake样本不同，不推翻原先“那些无seed样本跳过barrier”的结论。
- PID2053（旧atlantis/tsx fixture，已存在七天）无active JS handles/timers；native sample显示模块求值时主线程停在Atomics.wait。未定位发起等待的JS帧，不得认定TSX本身有bug。
- 36个缺失Heart的测试/probe中，13个仍保留leash FD。仅对样本作现场句柄/栈取证，未逐个证明全部根因。当前creation tests已有显式cleanup helper，旧残留不证明当前helper修订仍泄漏。

独立调查/验收：固定当前revision，受控复现启动/交接阶段的活跃句柄及拥有者；验证成功与典型失败路径在删fixture前释放barrier并证明自有child退休，无法证明时保留evidence，不把“目录删掉”当“进程结束”。只修仍能复现的缺陷并留关键回归；若当前修订已经解决某类历史残留，记录验证范围和剩余未知。

本轮未杀既有进程、未改生产代码、未触碰Paseo daemon。PID仅为历史取证坐标，不授权从PID重建signaling authority；宿主残留清理另需批准。辅助证据：/tmp/akuma-body-debug-20261001/REPORT.md、inventory.json、inspector-5115.json、inspector-2053.json、sample-2053.txt。关键事实已经内嵌，任务不依赖/tmp永久存在。
User authorized repair Oct1. Started; fresh intern aku/intern/7ac8ed23 (@repair-fixtures-prebind) jointly examines this Task and task/usability/investigate-inconsistent-full-6096 read-only, with DISTINCT root-cause conclusions. P3 correction remains sole P3 writer's work; no duplication or old-PID signaling. Outputs /tmp/kei-repair-fixtures-prebind-20261001; no implementation/acceptance claimed.
## 用户授权清理：可恢复测试/probe body（宿主清理，不是代码修复）
用户确认“第二条清理，他们都是可回复的”中“可回复”为“可恢复，所以可以清掉”。重新按启动身份、Heart缺失及父子残留关系核对36个无Heart body，并逐个SIGTERM；36个全部退出，没有活跃Pi/Paseo受影响。最终无no-heart body；现场残留body只剩4个活跃Pi worker。
证据：/tmp/akuma-body-debug-20261001/cleanup-no-heart-receipt.json。该清理不证明旧的barrier/wake/teardown缺陷已修复；保留本任务继续调查root cause与回归。
Read-only analyst confirmed helperretention defeated by globalGitfixtureafter and deletion alone not childretirement. Narrow PROOF-PRESERVATION partial repair ACTUALLY bound kei/preserve-retained-fixture-1342, reviewedgate, sole fresh intern aku/intern/c2ea6d28 in wt/upsidedown. Does not migrate productionwake/kill, claim ENOTEMPTY solved, or duplicateP3launchcorrection; originalTask remainsinprogress. Full4Criteria+Objective commission/tmp/kei-repair-fixtures-writer-commission-20261001.md.
Oct1 NARROW PROOF-PRESERVATION PARTIAL REPAIR ACTUALLY ACCEPTED kei/preserve-retained-fixture-1342: landed dcf355ad26900bfe2bb9fcdf98af2432a90e0127/treea5ab757f92d0671474785a08ed08bfbe232578a8 overacceptedP5; verified01M3TPCE49BKCJD88JVQVZ8NHS exactintegration all3declaredchecks0, delivered01M3TPHSREDAZTD7JS009GFD4J, independentwhole4Criteria+Objective reviewed01M3TPQXCH3A50P407JDM561PW/claimed01M3TPQXP8QGFK8WF4XS82V7RB. Retainedroot/nestedbytes survive nativechildrunnerexit and everyowningteardown; unexpectedretention defaultfailsbyname, no silentgreen. Prompt-freecallfixture installsBodyreceiptbeforecall, awaitsmanagedkill+physicalexitbeforedelete, restoresinstrumentationfinally; no productlifecycle/PIDauthority/budgetraise. Upsidedown physicallyretired. Historicalschema-call5sreadydeadline expiry beforeseedbirth retainedsnapshotjpi3ky truthfully; startupcauseUNKNOWN/no loadattribution, broader6096OPEN. This Task REMAINS IN_PROGRESS: no claimallhistoricalwake/kill/barrier remnants resolved. Memoryboundedwait separatelyaccepted5dcba03 doesnotsettlethisbroadTask.