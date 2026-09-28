---
id: task/清理-akuma-body-进程残留与-wake-kill-6678
title: 清理 Akuma body 进程残留与 wake/kill 生命周期 race
state: open
priority: 2
needs: []
parent: null
supersedes: []
relates: []
note: 2026-09-28 证据两则。① 孤儿body收割：elite-9cdbc47b (pid 13337)，run目录无journal。② aku/intern/97d28ba0 两次bash wedge (16:33/17:08，run row不落settle且provider下零子进程)；interrupt-steer于17:01 spawn替换body 35992（持live provider opencode:62217）但原body 73928（provider已死、零子进程、无turn所有权）从未被杀——一heart双body实锤，73928已手工收割。规律：interrupt-steer补新body不杀wedged旧body；provider bash wedge不spawn进程。
createdAt: 2026-09-23T05:37:12.382Z
updatedAt: 2026-09-28T09:27:26.893Z
---
已确认症状，不把猜测当成根因：snapshot fixture 清除后仍有 detached Body 存活，Heart/leash 路径已不存在。2026-09-23 追查现存 20 个 snapshot Body：全部 PPID=1；抽样解码 launch 全是 seed 缺失、refuseIfHeld=true 的 wake successor，而非 birth Body。它们继承测试 empty-publication barrier 环境，但该 loader 对无 seed 的 wake 直接跳过，因此 barrier 本身不是已证根因。怀疑 detached wake 在 fixture launch set 关闭后仍 spawn；需追踪具体异步边界和存活句柄并作受控复现。修复真正 custody/lifecycle 边界并留关键回归；不能仅杀现存 PID、让测试强制退出，或在别的 kei 中顺手扩大范围。