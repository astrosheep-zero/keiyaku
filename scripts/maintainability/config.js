export const FILE_LINES = Object.freeze({ warning: 400, error: 500 });
export const MARKDOWN_CHARACTERS = Object.freeze({ warning: 20_000, error: 30_000 });

const owner = (file, reason, maxEffectiveLines, functions = []) => ({
  file,
  reason,
  ...(maxEffectiveLines === undefined ? {} : { maxEffectiveLines }),
  ...(functions.length === 0 ? {} : { functions }),
});

const functionOwner = (name, reason, maxEffectiveLines) => ({ name, reason, maxEffectiveLines });

export const FILE_LINE_EXEMPTIONS = Object.freeze([
  owner("src/akuma/body-turn.ts", "One concrete live Turn owner keeps provider custody, receipt and tell pumping, bounded control, and hung retirement coherent.", 600),
  owner("src/akuma/request-serve.ts", "Admission, reservation/spawn, owner dispatch, durable receipt projection, live pump, and predecessor recovery share one parent Heart lease, serial admission boundary, and cancellation fence.", 604),
  owner("src/akuma/akuma.ts", "The low-level Akuma owner keeps birth, handles, lifecycle controls, and fleet reads coherent; splitting those operations would obscure that boundary.", 633),
  owner("src/library/contract.ts", "The package-root Contract handle remains one operations owner.", 786, [functionOwner("bindKeiyaku", "Contract binding keeps fork and ordinary admission under one package-root operation owner.", 93)]),
  owner("src/akuma/projection.ts", "The Akuma projection owns the one pure translation from retained Heart facts to public turn values; splitting it would duplicate projection ordering knowledge.", 538, [functionOwner("projectTurns", "Turn projection and its ordering and filtering rules are one read-time projection owner.", 86)]),
  owner("src/akuma/provider.ts", "The provider-neutral vocabulary and adapter contract are one change-axis owner shared by every built-in provider.", 501),
  owner("src/akuma/request-wire.ts", "Request wire encoding and decoding preserve one byte boundary between requester and serving sides; splitting it would duplicate the wire authority.", 501),
  owner("src/cli/commands/task-invoke.ts", "Task invocation owns command admission through execution handoff as one task-command lifecycle boundary.", 501),
  owner("src/cli/render/akuma.ts", "Akuma rendering owns the public text projection for one command family; splitting sections would repeat shared output and selection rules.", 585),
  owner("src/cli/render/contract.ts", "Contract rendering owns the public text projection for Contract results and history as one output reader.", 560),
  owner("src/cli/render/kanshi.ts", "Kanshi rendering owns one report text projection whose sections share the same selection and availability semantics.", 538),
  owner("src/git/hooks.ts", "Git hook execution owns worktree hook effects and their lag evidence as one effect boundary.", 501),
  owner("src/git/integration.ts", "Git integration owns observation of external Git state for protocol callers as one integration change axis.", 501),
  owner("src/git/observe.ts", "Git observation owns the shared read epoch and snapshot semantics consumed by protocol and settlement readers.", 501),
  owner("src/git/repository.ts", "Git repository primitives keep ref, object, worktree, and format decoding under one repository capability owner.", 501),
  owner("src/git/target-placement.ts", "Target placement owns appointment and physical placement decisions across the existing delivery lifecycle.", 532),
  owner("src/kanshi/read.ts", "Kanshi read owns composite observation and its section associations as one public read lifecycle.", 501, [functionOwner("observeKanshi", "Composite observation establishes one read epoch before projecting every Kanshi section.", 83)]),
  owner("src/library/fleet.ts", "The package-root fleet handle owns Akuma fleet operations and their public result adaptation as one fleet boundary.", 501),
  owner("src/protocol/deliver.ts", "Delivery preparation owns the admission-to-placement protocol boundary and its shared facts.", 501, [functionOwner("prepareDelivery", "Delivery preparation keeps the one admission and placement decision together.", 84)]),
  owner("src/task/operations.ts", "Task operations own the task verb vocabulary and result decisions across CLI, library, and settlement readers.", 501),
  owner("src/workspace-place.ts", "Workspace placement owns appointment, release, and terminal cleanup around one managed-place lifecycle.", 501),
  owner("src/akuma/providers/claude/index.ts", "The Claude adapter owns native query observation and drive custody for one provider lifecycle.", undefined, [
    functionOwner("observeClaudeQuery", "Claude event observation translates one native query lifecycle into provider-neutral evidence.", 97),
    functionOwner("driveClaude", "Claude drive owns session setup, event pumping, and terminal disposal for one native session.", 93),
  ]),
  owner("src/akuma/providers/codex-app-server/index.ts", "The Codex app-server adapter owns native session start and custody for one provider lifecycle.", undefined, [functionOwner("startCodex", "Codex startup owns initialization and session admission across one native process boundary.", 85)]),
  owner("src/akuma/providers/opencode-sdk/index.ts", "The OpenCode adapter owns native session drive, observation, and disposal for one provider lifecycle.", undefined, [functionOwner("drive", "OpenCode drive keeps SDK observation and disposal in the one native session owner.", 98)]),
  owner("src/akuma/providers/pi/index.ts", "The Pi adapter owns native session creation, event drive, and disposal for one provider lifecycle.", undefined, [functionOwner("drivePi", "Pi drive keeps session creation, event forwarding, and forced disposal under one adapter owner.", 98)]),
  owner("src/cli/render/refusal.ts", "Refusal rendering owns the complete public refusal-fact projection and its shared identity and detail rules.", undefined, [functionOwner("renderRefusalFacts", "Refusal facts are rendered through one complete result-shape owner.", 98)]),
  owner("src/git/read-observation.ts", "Git read observation owns batch object decoding and the shared read channel consumed by every Git reader.", undefined, [functionOwner("batchObjectReader", "Batch decoding keeps one repository observation channel and its cursor lifecycle together.", 88)]),
]);
