---
id: 收紧effect为闭合判别联合
title: 收紧Effect为闭合判别联合
state: open
pri: 0
needs: []
parent: null
from: []
createdAt: 2026-08-06T17:13:51.939Z
updatedAt: 2026-08-06T17:14:02.413Z
creator: thekoc
---
Make carrier Effect exactly match docs/transport.md: a closed worktree branch with path/action and a closed ref branch with name/before/after/action. Remove optional cross-branch fields so impossible effect shapes are unrepresentable. Update consumers with exhaustive narrowing only.