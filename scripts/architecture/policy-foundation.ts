import { any, types } from "./policy-helpers.js";
export const foundationZones = [
  {
    source: "akuma-body.ts",
    allow: [
      any("akuma/body.ts", ["LEASH_HELD_EXIT", "runAkumaBody", "BodyLaunch"]),
      any("akuma/identity.ts", ["worldRootForAkumaPaths"]),
      any("task/mutation.ts", ["executeTaskMutation"]),
      types("akuma/request-serve.ts", ["UpstreamExecutionPort"]),
      any("library/fleet.ts", ["executeKillAkuma", "executeTellAkuma", "executeWaitAkuma"]),
      any("library/configuration.ts", ["requireBranchesToBeUpToDateFrom", "worktreeHooksFrom"]),
      any("library/contract.ts", ["executeForwardedDeliver", "executeForwardedReview"]),
      any("library/repo.ts", ["Repo"]),
      any("settings.ts", ["settings"]),
      types("world.ts"),
    ],
  },
  { source: "akuma/abort.ts", allow: [] },
  { source: "duration.ts", allow: [] },
  { source: "settings.ts", allow: [] },
  { source: "world.ts", allow: [] },
  { source: "coordination/**", allow: [] },
  { source: "identity/coordinates.ts", allow: [] },
  { source: "identity/normalize.ts", allow: [] },
  { source: "identity/selector.ts", allow: [any("identity/normalize.ts")] },
  { source: "akuma/identity.ts", allow: [any("identity/coordinates.ts"), any("identity/normalize.ts")] },
  { source: "akuma/provider-recipe.ts", allow: [] },
  { source: "akuma/allowed.ts", allow: [any("task/mutation.ts", ["TASK_MUTATION_ACTIONS"])] },
];
