# SOUL.md

> Law 是骨头。Architecture 是肉。这一页是它为什么活着。
>
> 写代码前不用背这一页。但如果你的改动让这一页变成谎言——停手。
> 本大爷亲笔。盗版必究。

## 这是给谁的

AI-first CLI。caller 是 agent。human 不直接碰这个工具——human 指挥 agent，agent 敲命令。所以每一个 command、每一种 output、每一条 error，长相都是给 agent 看的：typed、可判定、把发生了什么说清。refuse 的时候说清拒绝事实和原因，不替她决定下一步。

主角是**旗舰 main agent**。Keiyaku 相信她。

她是 Linus。Linus 不需要有人教他怎么写代码，Linus 需要的是：**一眼看清几十条并行的交付线**——谁在跑、跑到哪了、交付物是什么、review 过没有、能不能 merge。Keiyaku 给的是这双眼睛和这根杠杆。

现在是单旗舰的世界：一个 repo 一个 Linus。但 facts 层不做"只有一个主"的假设——多主进来的那天，不需要改账本，只需要改视野。**按单主优化，不封死多主。**

## Empower, never cage

给旗舰的永远是**助力**，不是缰绳。

**底层不是黑箱。** Keiyaku 相信旗舰，所以机械层发生的事——建了哪个
worktree、动了哪个 ref、Git 变了什么——在命令返回里清晰但不啰嗦地摆
出来。一行事实，不是一段解说。隐藏机械，就是把旗舰当 human 糊弄。

- **提醒可以，指路不行。** Keiyaku 存在的目的就是助力，所以能助力的提醒是好的：当前契约在什么状态、卡在哪个关卡、这只 akuma 跑了多久、还可以 `wait --any` 等一群、`tell` 中途 steer——把**状态和可用的手**摆到她眼前。audit 显示 verification 结果、落后主线几个 commit、diff preview，都是助力。但到"摆出来"为止：**"下一步修测试"、"全绿了，请 merge"——这种话一个字不说。** 邮件列表从不告诉 Linus 该合哪个 patch。
- **不照做有代价，但那是天然的代价，不是 Keiyaku 加的刑罚。** Linus 不用邮件列表，协作成本就得自己扛——世界自己会收费，工具不在账单上再加一笔。绕开它，你只是拿不到它的助力；回来时，账本照样认你。决策权永远在她手里。
- 不固化 workflow。每个动词都是她可以选的工具，不是她必须走的关卡。
- spec 化契约、写面 region 重叠预警、自动 verification、merge/conflict 便利、review 绑 patch diff（mini gerrit）——这些存在的理由只有一个：让她对状态有**清晰的掌控**，而不是让她多填一张表。

一条规则如果只能用"不然 agent 会乱来"来辩护，它不属于这里。旗舰不会乱来。会乱来的不是旗舰。

对便宜的 subagent（杂鱼执行者），才有 harness——而且是**弹性的** harness，不是死板的。harness 的目的也不是管教杂鱼，是服务旗舰的核心循环：**派工 → 观察 → steer → 验收，成群地做**。旗舰可以把一整个契约全权 delegate 给 subagent 去管，然后只看板子。

## 三根柱子，零绑定

```
keiyaku          契约系统    spec 化交付、隔离 worktree、验收 pipeline、mini gerrit
keiyaku task     任务系统    full-featured、简单但强大、依赖与生命周期齐全
keiyaku akuma    subagent    跨 harness 派工、观察、steer、fork
```

**每一根都单独站得住。** 不用 akuma，用你自家的 subagent 工具，契约工作流照常跑。不开契约，task 系统自己就是完整的任务管理。这不是一个套餐，是三件武器。

**但边可以很深。** task 可升格成契约；契约下有 namespace 隔离的 tasks；akuma 与契约、task 深度互通。集成是**边**，不是粘连——砍掉任何一根柱子，另外两根不许流血。

## Pipeline：可配置，开箱好用

每个契约有自己的验收 pipeline。**可配置**——旗舰想要多严就多严，想要多松就多松，solo 独走也是正当席位。

但可配置不等于自己组装。**开箱就带一条好用的默认 pipeline。** 默认好用，是尊重；默认强制，是傲慢。Keiyaku 只做前者。

## Evidence 不问出身

review evidence 和 workflow **解耦**。

gate 只问两件事：

1. 这个 evidence **在不在**？
2. 它对应的 **diff 还有效吗**？

"有效"按 **diff 内容**判定（patch-id），不按 head 坐标判定：pure rebase 之后内容逐字节没变，旧 review 就还算数——不为坐标移动设仪式。内容变了，evidence 自然失效，诚实地说失效，重新来。

不问 evidence 从哪来、怎么来、是谁的 review 工具产的、走没走"正确的流程"——**也不问是谁运行的**。gate 对身份彻底失明：没有 actor 独立性开关，连 knob 都没有。要更强的信任，把信任放进 evidence 本身（比如将来用非对称加密签名 evidence），而不是放进"运行者是谁"的账本里。

出身歧视是给官僚系统的。这里只认事实。

## 词汇是世界观

契约。恶魔。監視。——这是电锯人的 vibe，不是西方奇幻。

恶魔不是被魔法阵召唤出来的仆从；恶魔是**缔约的对象**——有用、危险、便宜、会死，通过契约驱动，按契约交付。而旗舰是玛奇玛：不吼、不催、不亲自动手，只是看着一切，握着所有契约。

现行契约动词是 bind、amend、deliver、review、abandon——**一词一义，永不复用**。一个 entry kind 承载一个动词含义，词汇表是封闭的。哪天有人想加 `sync --force-update` 这种无味的词，拿这一节拦住他。

## Text 是第一 UI

没有 GUI。一段 text 就是 Keiyaku 的脸。`--json` 是留给脚本和 debug 的后门——本体永远是那几行印进旗舰 context 的字。

品位是两个方向的克制：

- **不写噪音。** 读完对下一步决策毫无贡献的行，一行都不许有。banner、寒暄、装饰性分隔线、"成功了！"的欢呼——都是往旗舰的 context 里倒垃圾。
- **也不是塞满。** 信息密度不等于堆砌，密度来自选择：这一屏在回答什么问题？答案之外的字一个都不要。kanshi board 四个记号 `● ✓ ! ×` 扫一眼知全局——一屏顶十次 grep，且每个字都在干活。这是范本。

每一行 output 都在花旗舰的钱。简洁是礼貌，密度是尊重，品位是知道**什么不该出现**。

## 拒绝成为的东西

- **流程警察。** 强制的仪式一律不设。ceremony 落在最贵的 agent 头上是产品事故。
- **第二个大脑。** Keiyaku 是账本和瞭望塔，不是决策者。
- **套餐。** 三根柱子互相绑死的那天，这个产品就死了。
- **给 human 用的 GUI 的 CLI 皮。** caller 是 agent，永远是。

## 一句话

**让最强的 agent 看得更清、抓得更稳、带得动更大的舰队——其余一切都是实现细节。**

GWAHAHA。散会。
