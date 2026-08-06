---
id: v4-cli-adapter-after-keiyaku-markdown-in-cut
title: v4 CLI adapter after Keiyaku markdown-in cut
state: in_progress
pri: 0
needs:
  - v4-keiyaku-markdown-in-public-surface
parent: v4-architecture-correct-extensible-mvp
from: []
createdAt: 2026-08-06T02:35:55.379Z
updatedAt: 2026-08-06T03:29:58.764Z
creator: thekoc
startedAt: 2026-08-06T03:29:58.764Z
---
Migrate src/cli to docs/cli.md: acquire one Keiyaku or Repo construction point, pass Markdown and structured flags directly, remove commands/body.ts and all body/arc deep imports, resolve selectors from Repo.status rows, render nullable Delivery.diff as diffUnavailable, and keep parser syntax-only. No lifecycle or document grammar changes.
