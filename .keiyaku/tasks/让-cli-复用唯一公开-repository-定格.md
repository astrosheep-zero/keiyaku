---
id: 让-cli-复用唯一公开-repository-定格
title: 让 CLI 复用唯一公开 repository 定格
state: open
pri: 0
needs: []
parent: null
from: []
createdAt: 2026-08-06T22:21:39.067Z
updatedAt: 2026-08-06T22:21:39.067Z
creator: thekoc
---
docs/cli.md 要求一次 invocation 只取得一个 pinned public handle。当前 @/cwd selector 必须 Repo.at().status() 后再 Keiyaku.of()，bind 为 settings 先 Repo.at() 后再 Keiyaku.bind()，带 gates 的 amend 还会再次 Repo.at()；每次构造都会重新发现同一 Git world。现有 package-root 没有从已定格 Repo 构造 Keiyaku/bind 的能力。先封闭 public capability flow，再让 CLI 一次 scope acquisition；不得用模块缓存、裸 GitRepository、CLI deep import 或双权威 registry。
