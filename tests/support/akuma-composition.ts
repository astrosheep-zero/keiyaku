import { createAkumaProduct, type AkumaBornCall } from "../../src/akuma/akuma-product.js";
import type {
  AkumaCallContext,
  AkumaConfiguration,
  AkumaCompleteList,
  AkumaList,
  AkumaListInput,
} from "../../src/akuma/akuma.js";
import { AkumaHandle, akumaCallExecution, type LastAnswer } from "../../src/akuma/akuma-handle.js";
import type { WorldRoot } from "../../src/world.js";

export class AkumaComposition {
  private constructor(private readonly product: ReturnType<typeof createAkumaProduct>) {}

  static of(root: WorldRoot, input: AkumaConfiguration = {}): AkumaComposition {
    return new AkumaComposition(createAkumaProduct(root, input));
  }

  of(input: Readonly<{ id: string }>): AkumaHandle {
    return this.product.selectHandle(input);
  }

  async call(input: Parameters<ReturnType<typeof createAkumaProduct>["invoke"]>[0]): Promise<AkumaHandle> {
    return await this.product.invoke(input);
  }

  async beginCall(
    input: Parameters<ReturnType<typeof createAkumaProduct>["invoke"]>[0],
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
