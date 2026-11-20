import assert from "node:assert/strict";
import test from "node:test";
import type { AttemptContext } from "../src/core/decide.js";
import { entryUlid } from "../src/core/facts/types.js";
import { runBoundedAttempts, spentPreparation } from "../src/protocol/run.js";

type Final = Readonly<{ kind: "accepted" }>;
const contexts = (count: number): AttemptContext[] =>
  Array.from({ length: count }, (_, index) => ({
    entryUlids: [entryUlid(`01ARZ3NDEKTSV4RRFFQ69G5FA${index + 1}`)],
  }));
const prepared = async () => ({ kind: "prepared" as const, prepared: undefined });
test("each spent premise consumes only its own fresh context", async () => {
  const budget = contexts(3);
  const preparedSeen: AttemptContext[] = [];
  const admittedSeen: AttemptContext[] = [];
  const result = await runBoundedAttempts<undefined, Final, string>(
    budget,
    async (context) => {
      preparedSeen.push(context);
      return context === budget[0] ? spentPreparation : prepared();
    },
    async (_prepared, context) => {
      admittedSeen.push(context);
      return context === budget[1] ? { kind: "spent" } : { kind: "accepted" };
    },
  );
  assert.deepEqual(result, { kind: "accepted" });
  assert.deepEqual(preparedSeen, budget, "every attempt prepares in its own fresh context");
  assert.deepEqual(admittedSeen, budget.slice(1), "a spent preparation never reaches admission");
  assert.ok(
    admittedSeen.every((context, index) => context === budget[index + 1]),
    "admission sees its preparing context",
  );
});

test("spent preparation and identity collision have distinct budget terminals", async () => {
  let spent = 0;
  const exhausted = await runBoundedAttempts<undefined, Final, never>(
    contexts(2),
    async () => {
      spent += 1;
      return spentPreparation;
    },
    async () => assert.fail("a spent preparation never reaches admission"),
  );
  assert.deepEqual(exhausted, { kind: "exhausted" });
  assert.equal(spent, 2);

  let collisions = 0;
  const collision = await runBoundedAttempts<undefined, Final, never>(contexts(2), prepared, async () => {
    collisions += 1;
    return { kind: "collision" };
  });
  assert.deepEqual(collision, { kind: "collision" });
  assert.equal(collisions, 2, "a collision asks for a fresh attempt until the budget is spent");

});
