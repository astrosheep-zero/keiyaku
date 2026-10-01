---
id: task/修复-opencode-sse-取消缺失导致-akuma-41be
title: 修复 OpenCode SSE 取消缺失导致 Akuma body 进程残留
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates:
  - task/清理-akuma-body-进程残留与-wake-kill-6678
  - task/akuma-长时间等待时持续消耗-cpu-并出现-gb-9984
note: "Accepted 2026-10-01: complete real-SDK event custody repair landed main12fc4c2; independent whole5Criteria+Objective review and fresh declared Verification satisfied. Historical attribution and Heart-absent core reentry remain separate."
createdAt: 2026-09-30T17:06:36.482Z
updatedAt: 2026-10-01T02:06:03.569Z
---
## 目标
OpenCode provider 的终态关闭必须真实收回事件订阅及其读取/重试活动，不能仅关闭服务端便宣称 closed，留下已结束的 Akuma body 常驻。

## 已确认根因
检查基线 main 80e590b0a，src/akuma/providers/opencode-sdk/index.ts:487 的 event.subscribe({ query }) 未传 attempt 的取消信号。SDK 缺省使用独立且从未取消的 AbortSignal；服务端关闭后，事件流无限重连，引用计时器的退避间隔上限为 30 秒。
src/akuma/providers/opencode-sdk/session.ts 中 runtime.close 终止的是 owned server，不是 SSE pump；index.ts:153 的 stopIterator 仅 fire-and-forget iterator.return，不能打断正在等待的 next。于是 Heart 已终态、leash 已释放，OS 进程仍活着；后续 wake 可再启动新 body，形成同一身份的多份残留。

## 现场证据与范围
取证时间 2026-09-30 16:38-16:51 UTC（本地 2026-10-01 00:38-00:51 +0800）。快照 181 个 body / 115 个身份：143 个进程对应终态 OpenCode 身份（117 put-down、18 exited、8 broke-off），36 个测试/probe 已无 Heart，另 2 个为活跃 Pi。最新 Heart 描述身份而非逐 PID 的 Body-sequence 映射。
旧进程 PID781（intern-6c4f1775）已无业务句柄，只剩一个 referenced 30,000ms Timeout；现场 async_hooks 捕获下一次 timer 创建栈：@opencode-ai/sdk/dist/gen/core/serverSentEvents.gen.js:4 sleep -> :111 createStream。143 个的 provider/终态已逐身份核对，但只对样本完成此现场栈归因，不得声称全部逐个验证。该问题与另案长等待 CPU/GB 内存增长、Square watcher CPU、测试残留不是同一已证根因。

## 当前版本受控复现
使用真实编译后的 createOpencodeProvider 和已安装 SDK createSseClient，仅注入 session/runtime loader 与必失败 fetch；不启动真实模型、不访问公网、不触碰生产 Heart。将 SDK retry delay/cap 缩短为 10ms 以有界复现；start 后等待 result，再 await attempt.abort() 与 attempt.closed，继续观察 100ms。
实测：adapterReportedClosed=true，runtimeCloseCalls=1，subscribeReceivedSignal=false，fetchCallsAtClosed=1，100ms 后 fetchCalls=9，证明 closed 后仍在重试。诊断进程最后用其自有 cleanup signal 中止流、归还 iterator，并自然退出。单独 import 当前 body entrypoint 正常退出，不是一般 import keepalive。

## 验收条件
- 订阅采用 attempt 生命周期所属取消信号；正常完成、错误、interrupt/abort、forceDispose、setup 失败均收回该次执行所拥有的 SSE fetch/reader/pump 及重试活动。
- closed/终态关闭证明包含事件流退休，而不只证明服务端退出；不得造成关闭互等、自等待、未处理 rejection 或重复结算。
- 关闭发生于断连/退避期间时也及时完成。仅补传 signal 不够：当前 SDK sleep 本身不可取消，仍可能拖住进程长达 30 秒；须处理实际等待的退休，而不是只 unref 掩盖。
- 保留真实 SDK 的关键回归，覆盖终态后无重试、无引用计时器/流句柄，隔离诊断子进程可自然退出；保留正常回答路径。不以立即完成的假 generator 代替该缺陷的回归，不扩成无关测试矩阵。
- 维持既有 provider custody、Heart/leash、Tell/wake 语义；按 owning docs 审查，如结算新 durable law 则在同一变更更新唯一 owner chapter。

## 非目标与安全边界
不通过 process.exit、批量杀进程、后台收割器或新增 daemon 掩盖泄漏；不以持久化 PID 重建 signaling authority。既有宿主残留清理需另行批准，本任务不授权清理。测试 barrier/Atomics.wait 残留在关联任务独立调查。禁止重启/停止 Paseo daemon；不把其他任务的 CPU/内存归因移植到本任务。

## 辅助证据
本机 /tmp/akuma-body-debug-20261001/REPORT.md、inventory.json、inspector-781.json、repro-opencode-cancel.mjs。/tmp 只是辅助路径，以上根因、实测结果与复现场景已经内嵌，不以临时文件永久存在作为任务前提。实施时先固定当前 revision 再重新复现，不将旧 PID 当作可操作对象。

## 结构性诊断与验收收紧（用户要求补充）
这不是只漏传一个signal的一行修复：已有docs/akuma-provider.md与ProviderAttempt.closed契约要求全部资源退休，问题是adapter资源归属不完整。createProviderAttempt只能等待已登记资源；OpenCode ownRuntime登记了服务端关闭，SSE fetch/reader/pump/retry在登记范围外，局部关闭被当成整体关闭证明。AsyncIterable外形掩盖其后台资源，iterator.return不能打断正在等待的next。

修复应在OpenCode adapter内集中管理同次执行的服务端、订阅、读取循环与退避等待；创建时即归入owner，所有终态共用完整退休路径，closed由真实活动全部结束派生，不由服务端关闭回执单独兑现。正常完成也必须取消订阅，断连/退避也必须及时退出。既有AttemptCustody可承接，不以本案未经证明地新增全局资源框架或推翻Provider架构。

验收须证明终态后没有SSE重试和引用活动，隔离诊断进程自然退出；检查真实SDK关键取消场景，而不是只断言mock.close调用过。不能以补signal、unref、process.exit或宿主杀进程替代修复。测试注入barrier在supervisor前的残留仍属关联任务独立调查，不能将所有测试样本归为同一根因。

用户另行授权本轮宿主清理已结束OpenCode残留：仅对重新核实的现场对象执行，不是产品自动回收设计，不改变本修复Task的open状态或验收要求；活跃worker与Paseo daemon不得因该清理受影响。
## 用户另行授权的宿主清理回执（不是修复完成）
已重新核实现场命令、启动身份、Heart终态、打开的数据库句柄及子进程关系，并用SIGTERM终止143个终态OpenCode body。最后3个body仍各带一个专属OpenCode服务端；再次确认各自/session/status为空、/permission为空且无额外子进程后，一并终止这3个服务端。总计146个进程全部退出，未使用批量名称匹配或进程组杀法。最终扫描无OpenCode body或opencode命令进程；活跃Pi worker、测试残留、Paseo daemon和系统服务未动。
本次宿主清理仅解除旧进程占用，本轮没有修改生产代码；不改变由实施流程维护的任务状态（清理回执写入时frontmatter已为in_progress/P1），不得把一次宿主清理计作SSE生命周期缺陷已修复。证据：/tmp/akuma-body-debug-20261001/cleanup-apply-1790788907.json（140个body）、cleanup-idle-pairs-receipt.json（3个body与3个server）、post-cleanup-resource-summary.json（清理后的其他占用）。后续复现不可复用这些已退出PID。
User authorized repair Oct1. Started; fresh intern aku/intern/e6e6c7c1 (@repair-sse-prebind) commissioned read-only current-version reproduction and settled adapter resource-custody design before binding. Outputs /tmp/kei-repair-sse-prebind-20261001; no implementation or acceptance claimed.
Prebind report completed on80e590; actual adapter/REALSDK closed-after-retry and normal-reader cancellation defects reproduced. Managed interruption retired analyst's own defective unbounded probe; no matching probe process observed, not a passing natural-closure proof. Whole settled repair ACTUALLY bound kei/retire-opencode-event-activity-434b with reviewedgate, associated this Task; sole fresh intern writer aku/intern/0d1c1dd0 in /Users/astrosheep/Developer/keiyaku-v4/.keiyaku/wt/dumpling. Whole5Criteria+Objective commission /tmp/kei-repair-sse-writer-commission-20261001.md. No implementation/acceptance claimed.
Acceptance 2026-10-01 09:59:07 +0800: kei/retire-opencode-event-activity-434b actually accepted. Corrected source64449a26/tree17a289f8 equals integration12fc4c2. Delivered01M3TJ1B41PQTQ3VTX619GQ59P, verified01M3TJ5PD7GQ4WM7AHTNYMBJ7P (all3declarations exit0/fulltests74170status0), independent whole review01M3TJZMEB2EGVD8QM5KMYCCPQ, claim01M3TJZN0HZTH05F09NP2K3CKA. One adapter-private owner retires real subscription/fetch/reader/retry waiting before closed; terminal narration remains open until whole closure so actual control/Heart observation reaches bounded custody handling. First f2925b1 completion-first deadlock was reproduced and corrected, not waived. Main followed; dumpling physically removed; Task settlement done. No blanket claim over every historical PID/CPU/GB or absent-Heart core reentry; broader related Tasks remain in progress.