import { z } from "zod";
import { verbs, type VerbName, type VerbOutput } from "../library/keiyaku-verbs.js";
import { snapshotChangeSchema } from "../protocol/result-leaves.js";

const bind = verbs.bind.normal.unwrap();
const verify = verbs.verify.normal.unwrap();
const contract = verbs.status.normal.options[0].unwrap();
const akuma = verbs.status.normal.options[1].unwrap();
const contracts = verbs.ls.normal.options[0].unwrap();
const akumas = verbs.ls.normal.options[1].unwrap();
const contractRow = contracts.shape.rows.unwrap().unwrap().element.unwrap();
const akumaRow = akumas.shape.rows.unwrap().unwrap().element.unwrap();
const associated = akuma.shape.contract.unwrap().options[0];
const work = akuma.shape.work.unwrap().omit({ turn: true, activeTools: true, latestActivity: true });
const spawn = verbs.spawn.normal.unwrap();
const gateProblem = z.strictObject({
  gate: z.string(),
  requirement: z.string(),
  state: z.enum(["missing", "stale", "unsatisfied"]),
  summary: z.string().exactOptional(),
  reason: snapshotChangeSchema.exactOptional(),
});
const stops = [
  z.strictObject({ kind: z.literal("delivery-missing") }),
  z.strictObject({
    kind: z.literal("prerequisites-unsatisfied"),
    unmet: z.array(z.strictObject({ contractId: z.string(), state: z.enum(["missing", "active", "abandoned"]) })),
  }),
  z.strictObject({ kind: z.literal("gates-unsatisfied"), unmet: z.array(gateProblem) }),
] as const;
const placement = z.union([
  z.strictObject({
    kind: z.literal("placed"),
    integration: z.string(),
    target: z.string().exactOptional(),
    predecessor: z.string().exactOptional(),
  }),
  ...stops,
]);
const continuation = z.strictObject({
  claimed: z.array(z.string()).exactOptional(),
  stopped: z
    .array(
      z.strictObject({
        contractId: z.string(),
        stop: z.union([...stops, z.strictObject({ kind: z.literal("physical-lag") })]),
      }),
    )
    .exactOptional(),
});

/** Transport declarations describe routing facts, independently of complete native answers. */
export const mcpOutputSchemas = {
  bind: bind.omit({ issues: true, recoverySnapshots: true, overlapError: true }),
  verify: verify
    .omit({ issues: true, recoverySnapshots: true, checks: true, placement: true, continuation: true })
    .extend({
      checks: z.array(
        z.strictObject({
          index: z.number(),
          requirement: z.string(),
          verdict: z.enum(["satisfied", "unsatisfied"]),
          admission: z.enum(["admitted", "reused", "unrecorded"]),
          summary: z.string().exactOptional(),
          retainedPath: z.string().exactOptional(),
        }),
      ),
      placement: placement.exactOptional(),
      continuation: continuation.exactOptional(),
    }),
  spawn: spawn.omit({ dispatchWarning: true, alias: true, wake: true, input: true }),
  fork: verbs.fork.normal.unwrap().omit({ dispatchWarning: true }),
  ask: z.union([
    verbs.ask.normal.options[0]
      .unwrap()
      .omit({ interrupt: true, wake: true, completedAt: true })
      .extend({ answer: z.unknown() }),
    verbs.ask.normal.options[1].unwrap().omit({ interrupt: true, wake: true }),
    verbs.ask.normal.options[2].unwrap().omit({ interrupt: true, wake: true }),
  ]),
  wait: verbs.wait.normal,
  status: z.union([
    contract.omit({ targetObservation: true, issue: true, holder: true, roster: true }).extend({
      holder: contract.shape.holder.unwrap().options[0].exactOptional(),
      roster: z.array(z.strictObject({ id: z.string(), aliases: z.array(z.string()).exactOptional() })).exactOptional(),
    }),
    akuma.omit({ changes: true, moreChanges: true, outsideChanges: true, contract: true, work: true }).extend({
      contract: associated.exactOptional(),
      work,
    }),
  ]),
  ls: z.union([
    contracts.omit({ rows: true }).extend({
      rows: z
        .array(contractRow.omit({ attention: true }).extend({ hasAttention: z.literal(true).exactOptional() }))
        .exactOptional(),
    }),
    akumas.omit({ aliasesError: true, rows: true }).extend({
      rows: z.array(akumaRow.omit({ contract: true }).extend({ contract: associated.exactOptional() })).exactOptional(),
    }),
    verbs.ls.normal.options[2],
    verbs.ls.normal.options[3],
  ]),
  "debt.add": verbs["debt.add"].normal,
} as const;
type McpOutputName = keyof typeof mcpOutputSchemas;

type Normal<K extends McpOutputName> = z.output<(typeof verbs)[K]["normal"]>;
type Verify = Normal<"verify">;

function projectPlacement(
  value: NonNullable<Verify["placement"]> | NonNullable<NonNullable<Verify["continuation"]>["stopped"]>[number]["stop"],
) {
  if (value.kind !== "gates-unsatisfied") return value;
  return {
    kind: value.kind,
    unmet: value.unmet.map((problem) => {
      const { gate, requirement, state } = problem;
      return {
        gate,
        requirement,
        state,
        ...("summary" in problem ? { summary: problem.summary } : {}),
        ...("reason" in problem && problem.reason !== undefined ? { reason: problem.reason } : {}),
      };
    }),
  };
}

function projectStatus(value: Normal<"status">) {
  if (value.kind === "contract") {
    const { targetObservation: _target, issue: _issue, holder, roster, ...routing } = value;
    return {
      ...routing,
      holder: typeof holder === "string" ? holder : undefined,
      roster: Array.isArray(roster) ? roster.map(({ id, aliases }) => ({ id, aliases })) : undefined,
    };
  }
  const {
    changes: _changes,
    moreChanges: _more,
    outsideChanges: _outside,
    contract: association,
    work: frontier,
    ...routing
  } = value;
  const { turn: _turn, activeTools: _tools, latestActivity: _latest, ...work } = frontier;
  return { ...routing, contract: association?.kind === "associated" ? association : undefined, work };
}

function projectList(value: Normal<"ls">) {
  if (value.kind === "contract-catalogue") {
    const { rows, ...catalogue } = value;
    return {
      ...catalogue,
      rows: rows?.map(({ attention, ...row }) => ({ ...row, hasAttention: attention?.length ? true : undefined })),
    };
  }
  if (value.kind === "akuma-catalogue") {
    const { aliasesError: _aliases, rows, ...catalogue } = value;
    return {
      ...catalogue,
      rows: rows?.map(({ contract, ...row }) => ({
        ...row,
        contract: contract?.kind === "associated" ? contract : undefined,
      })),
    };
  }
  return value;
}

const projections = {
  bind(value: Normal<"bind">) {
    const { kind, contractId, worktreePath, target, overlaps } = value;
    return { kind, contractId, worktreePath, target, overlaps };
  },
  verify(value: Verify) {
    const { issues: _issues, recoverySnapshots: _recoveries, checks, placement, continuation, ...routing } = value;
    return {
      ...routing,
      checks: checks.map(({ kind: _kind, ...check }) => check),
      placement: placement === undefined ? undefined : projectPlacement(placement),
      continuation:
        continuation === undefined
          ? undefined
          : {
              ...continuation,
              stopped: continuation.stopped?.map(({ contractId, stop }) => ({
                contractId,
                stop: projectPlacement(stop),
              })),
            },
    };
  },
  spawn(value: Normal<"spawn">) {
    const { dispatchWarning: _dispatch, alias: _alias, wake: _wake, input: _input, ...routing } = value;
    return routing;
  },
  fork(value: Normal<"fork">) {
    const { dispatchWarning: _dispatch, ...routing } = value;
    return routing;
  },
  ask(value: Normal<"ask">) {
    const { interrupt: _interrupt, wake: _wake, ...routing } = value;
    if (routing.kind !== "answered") return routing;
    const { completedAt: _completedAt, ...settled } = routing;
    return settled;
  },
  wait: (value: Normal<"wait">) => value,
  status: projectStatus,
  ls: projectList,
  "debt.add": (value: Normal<"debt.add">) => value,
};

/** Called only after the invocation owner has classified a normal completion. No parsing or I/O. */
export function projectMcpOutput(name: McpOutputName, value: VerbOutput<VerbName>): unknown {
  // The edge preserves the name/value correlation; classification proves the normal subset.
  return (projections[name] as (value: VerbOutput<VerbName>) => unknown)(value);
}
