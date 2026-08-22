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
  owner("src/akuma/request-execution.ts", "Admitted upstream request execution keeps provider custody and typed settlement inputs under one execution owner.", undefined, [functionOwner("executeRequest", "Request action dispatch preserves one admitted execution boundary.", 100)]),
  owner("src/kanshi/read.ts", "Kanshi read owns composite observation and its section associations as one public read lifecycle.", undefined, [functionOwner("observeKanshi", "Composite observation establishes one read epoch before projecting every Kanshi section.", 83)]),
  owner("src/akuma/providers/claude/index.ts", "The Claude adapter owns native query observation and drive custody for one provider lifecycle.", undefined, [
    functionOwner("observeClaudeQuery", "Claude event observation translates one native query lifecycle into provider-neutral evidence.", 97),
    functionOwner("driveClaude", "Claude drive owns session setup, event pumping, and terminal disposal for one native session.", 93),
  ]),
  owner("src/akuma/providers/codex-app-server/index.ts", "The Codex app-server adapter owns native session start and custody for one provider lifecycle.", undefined, [functionOwner("startCodex", "Codex startup owns initialization and session admission across one native process boundary.", 85)]),
  owner("src/akuma/providers/opencode-sdk/index.ts", "The OpenCode adapter owns native session drive, observation, and disposal for one provider lifecycle.", undefined, [functionOwner("drive", "OpenCode drive keeps SDK observation and disposal in the one native session owner.", 98)]),
  owner("src/akuma/providers/pi/index.ts", "The Pi adapter owns native session creation, event drive, and disposal for one provider lifecycle.", undefined, [functionOwner("drivePi", "Pi drive keeps session creation, event forwarding, and forced disposal under one adapter owner.", 98)]),
  owner("src/git/read-observation.ts", "Git read observation owns batch object decoding and the shared read channel consumed by every Git reader.", undefined, [functionOwner("batchObjectReader", "Batch decoding keeps one repository observation channel and its cursor lifecycle together.", 88)]),
]);
