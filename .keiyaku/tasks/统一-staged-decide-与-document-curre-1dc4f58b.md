---
id: 统一-staged-decide-与-document-curre-1dc4f58b
title: 统一 staged decide 与 document currency 单一裁决
state: in_progress
pri: 0
needs:
  - 收束-core-decision-observation-为唯-5ab4af33
parent: null
from: []
notes:
  - actor: thekoc
    timestamp: 2026-08-06T23:07:32.383Z
    text: "Remaining concrete precedence bug: Keiyaku.amend still read/decode/applies caller Markdown before amendOperation takes its immutable decision observation. A terminal contract with malformed amend input throws dialect error before the legally prior terminal refusal. Move amend dialect transformation into coordinate-only staging after the decision observation, pass a discriminated prepared/refused result into the one decide, and keep dialect refusal ownership outside core. Add one precise terminal-vs-malformed-amend test; do not restore a preflight."
createdAt: 2026-08-06T21:41:47.998Z
updatedAt: 2026-08-06T23:07:32.383Z
creator: thekoc
startedAt: 2026-08-06T22:39:01.320Z
---
依据 docs/lifecycle.md 的 every attempt one legal decide 和 docs/document.md 的 key-stamped derivation law，删除 deliver/audit/review 的拼装裁决漂移：

- deliver 保留一个生产级 decide 入口；state-only stage 与 offer construction 共享同一 document currency 判断，删除仅测试使用的 decide wrapper 或让生产真正使用唯一入口。
- audit 不在 protocol 内联重写 document key equality；复用同一 core currency adjudicator，但不得把 audit 伪装成 deliver fact。
- attestation/review 保留一条生产 admission 形态；删除仅测试 reader 的 admitReview/重复 wrapper，subject 由唯一 reviewed producer 构造。
- reviewed producer token 只在一个外围 owner 处定义；audit 计数复用该值或按事实 producer identity 判断，不保留三份字面量。
- 不创建 generic lifecycle runner，不让 core 认识 reviewed/verified producer 词汇，不改变 persisted facts 或 public behavior。

精准测试证明 document-moved 优先级、review before deliver、audit/review 计数和唯一 production call graph。

同一刀还要清除两个已证实的旁路：library `amend` 不得用 stale edge read 直接返回 contract-missing；Verification declaration validity 必须在 stamped document currency 与 terminal 判断之后由 owning completed decision 裁定。`abandonOperation` 的 target/finalHead mechanical capture 也必须从该 attempt 的 observation state 派生，不能先 observeContract 再让 admitIntent 另读一份世界。若 owner law 尚不足以给出无 preflight 的局部接口，停在精确 gap，不自由设计。
