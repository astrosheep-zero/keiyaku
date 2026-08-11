---
id: task/v4-cli-adapter-after-keiyaku-markdown-in-cut
title: v4 CLI adapter after Keiyaku markdown-in cut
state: done
priority: 0
needs:
  - task/v4-keiyaku-markdown-in-public-surface
parent: task/v4-architecture-correct-extensible-mvp
supersedes: []
relates: []
note: ""
createdAt: 2026-08-06T03:29:59.440Z
updatedAt: 2026-08-07T11:29:07.432Z
---
Migrate src/cli to docs/cli.md: acquire one Keiyaku or Repo construction point, pass Markdown and structured flags directly, remove commands/body.ts and all body/arc deep imports, resolve selectors from Repo.status rows, render nullable Delivery.diff as diffUnavailable, and keep parser syntax-only. No lifecycle or document grammar changes.