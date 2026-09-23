import { join } from "node:path";
import { createAkumaProduct, type AkumaBornCall } from "../../src/akuma/akuma-product.js";
import type { AkumaCallInput } from "../../src/akuma/akuma.js";
import { Akumas } from "../../src/index.js";
import type {
  AkumaCallContext,
  AkumaConfiguration,
  AkumaCompleteList,
  AkumaList,
  AkumaListInput,
} from "../../src/akuma/akuma.js";
import { AkumaHandle, akumaCallExecution, type LastAnswer } from "../../src/akuma/akuma-handle.js";
import { admitCallInitialTell } from "../../src/akuma/call-initial-tell.js";
import { projectTell } from "../../src/akuma/heart/index.js";
import type { WorldRoot } from "../../src/world.js";
export function recordCallInitialTell(world: WorldRoot, now: () => string = () => new Date().toISOString()) {
  return async (input: Omit<Parameters<typeof admitCallInitialTell>[0], "world" | "now" | "wake">) =>
    await admitCallInitialTell({
      world,
      ...input,
      now,
      wake: async (tell) => ({
        admission: { tellId: tell.id, fact: "recorded" },
        row: projectTell(tell),
        wake: { kind: "held" },
      }),
    });
}

export function isolateSquareFixtureLedger(root: string): () => void {
  const previousLocal = process.env.SQUARE_HOST_LEDGER_LOCAL;
  const previousUser = process.env.SQUARE_HOST_LEDGER_USER;
  process.env.SQUARE_HOST_LEDGER_LOCAL = join(root, "local-ledger");
  process.env.SQUARE_HOST_LEDGER_USER = join(root, "user-ledger");
  return () => {
    if (previousLocal === undefined) delete process.env.SQUARE_HOST_LEDGER_LOCAL;
    else process.env.SQUARE_HOST_LEDGER_LOCAL = previousLocal;
    if (previousUser === undefined) delete process.env.SQUARE_HOST_LEDGER_USER;
    else process.env.SQUARE_HOST_LEDGER_USER = previousUser;
  };
}

export class AkumaComposition {
  private constructor(
    private readonly root: WorldRoot,
    private readonly configuration: AkumaConfiguration,
    private readonly product: ReturnType<typeof createAkumaProduct>,
  ) {}

  static of(root: WorldRoot, input: AkumaConfiguration = {}): AkumaComposition {
    return new AkumaComposition(root, input, createAkumaProduct(root, input));
  }

  of(input: Readonly<{ id: string }>): AkumaHandle {
    return this.product.selectHandle(input);
  }

  async call(input: AkumaCallInput): Promise<AkumaHandle> {
    const execution = this.configuration.execution;
    const caller = Akumas.of(this.root, execution === undefined ? {} : { execution });
    const cwd = input.cwd ?? (execution?.channel.kind === "body-request" ? undefined : process.cwd());
    const result = await caller.call({
      ...input,
      ...(cwd === undefined ? {} : { cwd }),
      ...(this.configuration.home === undefined ? {} : { home: this.configuration.home }),
      ...(this.configuration.settings === undefined ? {} : { settings: this.configuration.settings }),
      mode: "detach",
    });
    if (result.observation.kind === "failed") throw new Error(result.observation.failure.diagnostic);
    return this.product.selectHandle({ id: result.akuma });
  }

  async beginCall(
    input: Parameters<ReturnType<typeof createAkumaProduct>["admit"]>[0],
    context: AkumaCallContext,
  ): Promise<AkumaBornCall> {
    return await this.product.admit(input, context);
  }

  async finishCall(born: AkumaBornCall, completion: Readonly<{ contractId?: string }> = {}): Promise<AkumaHandle> {
    return await this.product.publish(born, completion);
  }

  async listArchetypes(): Promise<readonly string[]> {
    return await this.product.listArchetypes();
  }

  async listComplete(input: AkumaListInput = {}): Promise<AkumaCompleteList> {
    return await this.product.listComplete(input);
  }

  async list(input: AkumaListInput = {}): Promise<AkumaList> {
    return await this.product.list(input);
  }
}

export { AkumaHandle, akumaCallExecution };
export type { LastAnswer };
