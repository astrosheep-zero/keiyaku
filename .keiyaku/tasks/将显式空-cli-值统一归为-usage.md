---
id: 将显式空-cli-值统一归为-usage
title: 将显式空 CLI 值统一归为 usage
state: open
pri: 1
needs: []
parent: null
from: []
createdAt: 2026-08-06T21:45:30.596Z
updatedAt: 2026-08-06T21:45:30.596Z
creator: thekoc
---
依据 docs/cli.md 的 adapter syntax/usage ownership，显式 --target ""、--message ""、--note ""、--summary "" 以及空白 review stdin 必须在 CLI adaptation 边界成为 typed usage exit 1；不得漏到 package-root TypeError exit 3。library 直调仍保留 programmer value validation。

收束一个 CLI nonblank adaptation helper，避免每个 verb 复制判断；不要把 parser 变成 Git/lifecycle 语义层，不改变省略值的默认行为。添加参数化的小型 invoke 边界测试，不为每个 flag 复制整套 E2E。
