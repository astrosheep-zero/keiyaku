---
id: 删除-document-parser-的测试专用-71262661
title: 删除 document parser 的测试专用错误 code
state: open
pri: 1
needs: []
parent: null
from: []
createdAt: 2026-08-06T19:09:00.129Z
updatedAt: 2026-08-06T19:09:00.129Z
creator: thekoc
---
ContractDocumentError.code 与 ArcDocumentError.code/类身份没有生产 reader，只有 tests deep-import；package/CLI 只承诺 TypeError 诊断。删除测试专用 code 与无读者 subclass，保留现有精确 message；VerificationDocumentError 因 decode/amend 有生产 catch 必须保留。
