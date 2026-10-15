import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
export const refreshRpc = defineRpc({ name: "refresh",
  input: z.object({ world: z.string(), akuId: z.string() }),
  output: z.object({ woken: z.number().int().nonnegative() }),
});
