---
id: 删除subject-currentness双重json解析
title: 删除subject-currentness双重JSON解析
state: open
pri: 1
needs: []
parent: null
from: []
createdAt: 2026-08-06T17:21:59.478Z
updatedAt: 2026-08-06T17:22:11.248Z
creator: thekoc
---
subjectIsCurrent currently JSON-parses canonical subject bytes inside parseDependencyKeySet and then JSON-parses the returned string again. Refactor one internal decode/canonicalization path to return both the branded canonical value and encoded dependency keys; parseDependencyKeySet and subjectIsCurrent share it. Preserve exact persisted grammar/errors and the sole currentness result.