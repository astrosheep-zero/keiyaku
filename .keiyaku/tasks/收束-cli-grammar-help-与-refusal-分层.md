---
id: task/收束-cli-grammar-help-与-refusal-分层
title: 收束 CLI grammar help 与 refusal 分层
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
note: ""
createdAt: 2026-08-09T02:04:30.156Z
updatedAt: 2026-08-09T02:39:51.693Z
contractId: null
---
依据 docs/cli.md 与 Faye act_83：保持 Contract/Task/Akuma grammar ownership，以 owner spec row 驱动 validation、usage refusal 和 help；实现 parse-terminal --help、精确 refusal 坐标、stdout/0 且不 invoke，并删除手写 usage 与无坐标 fail 旁路。