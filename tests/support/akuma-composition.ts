import { join } from "node:path";

export function isolateSquareFixtureLedger(root: string): () => void {
  const previous = process.env.SQUARE_DELIVERY;
  process.env.SQUARE_DELIVERY = join(root, "square-ledger", "delivery.sqlite");
  return () => {
    if (previous === undefined) delete process.env.SQUARE_DELIVERY;
    else process.env.SQUARE_DELIVERY = previous;
  };
}

export { AkumaOwner } from "../../src/akuma/akuma-owner.js";
