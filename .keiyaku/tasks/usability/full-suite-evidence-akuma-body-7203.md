---
id: task/usability/full-suite-evidence-akuma-body-7203
title: "Full-suite evidence: akuma-body-requests wait payload assertion on c91e8b5"
state: open
priority: 2
needs: []
parent: null
supersedes: []
relates:
  - task/usability/investigate-inconsistent-full-6096
note: "2026-09-15: full npm test on c91e8b5 failed 'transport rejects malformed target sets and foreign World coordinates before Heart' (12ms) with 'registered request action akuma.wait rejected its payload' from request-serve. Passes in isolation and in a 3x combined rerun with plugin-runtime. Matches the task's documented 'akuma.wait assertion in akuma-body-requests during broad concurrent run' contrary evidence. Unrelated to the frames landing (candidate's focused Verification green; files outside its Region)."
createdAt: 2026-09-15T08:08:03.609Z
updatedAt: 2026-09-15T08:08:03.609Z
---
