---
id: task/统一-cli-命令规格为单一私有表
title: 统一 CLI 命令规格为单一私有表
state: done
priority: 1
needs: []
parent: null
supersedes: []
relates: []
contractId: null
---
将 src/cli/parse.ts 的 COMMANDS、FLAG_SPECS、acceptsStdin() 与通用 usage 收束为一张私有 COMMAND_SPECS。每条命令声明 positional、stdin、flags 与精确 usage，Command 从表键派生。保留现有 typed ParsedCommand 和各命令专用 parser；只参考 v4b 的规格表形状，不引入 generic Map parser。