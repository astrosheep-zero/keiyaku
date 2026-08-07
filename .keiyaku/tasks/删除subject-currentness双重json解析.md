---
id: task/删除subject-currentness双重json解析
title: 删除subject-currentness双重JSON解析
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-07T04:47:56.375Z
updatedAt: 2026-08-07T11:29:07.446Z
contractId: null
---
subjectIsCurrent currently JSON-parses canonical subject bytes inside parseDependencyKeySet and then JSON-parses the returned string again. Refactor one internal decode/canonicalization path to return both the branded canonical value and encoded dependency keys; parseDependencyKeySet and subjectIsCurrent share it. Preserve exact persisted grammar/errors and the sole currentness result.