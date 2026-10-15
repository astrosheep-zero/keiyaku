import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
export const attachRpc = defineRpc({ name: "attach",
  input: z.object({ world: z.string(), akuId: z.string(), caller: z.union([
    z.object({ kind: z.literal("akuma"), world: z.string(), akuId: z.string() }),
    z.object({ kind: z.literal("external"), integration: z.string(), id: z.string() }),
    z.object({ kind: z.literal("unknown") }),
  ]).optional() }),
  output: z.object({ attached: z.boolean() }),
});
