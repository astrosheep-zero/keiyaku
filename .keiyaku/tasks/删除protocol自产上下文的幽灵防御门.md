---
id: task/删除protocol自产上下文的幽灵防御门
title: 删除protocol自产上下文的幽灵防御门
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
contractId: null
---
证明 runProtocol 仅由内部 typed builder 调用后，删除对 attempts/contracts 的 JS 外部输入式重验；保留 receipt 主体识别、offer allocation 与 unknown recovery 真正需要的内部不变量。