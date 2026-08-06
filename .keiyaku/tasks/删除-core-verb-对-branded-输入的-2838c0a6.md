---
id: 删除-core-verb-对-branded-输入的-2838c0a6
title: 删除 core verb 对 branded 输入的重复验证
state: open
pri: 1
needs: []
parent: null
from: []
createdAt: 2026-08-06T18:57:38.600Z
updatedAt: 2026-08-06T18:57:38.600Z
creator: thekoc
---
Core DecideInput 已要求 ContractId 与 AttemptContext.entryUlids 的 branded 类型，生产者是 protocol；codec/admission 仍在持久化边界验证字节。删除各 decide verb 对 input.contractId 与 attempt.entryUlids 的 contractId()/entryUlid() 二次验证，保留 typed domain refusal 与 fold/codec corruption validation，不扩大 public deep import。
