import assert from "node:assert/strict";
import test from "node:test";
import { validateExemptions } from "../scripts/check-maintainability.js";

test("maintainability max-lines exemptions require exact live paths and reasons", () => {
  assert.deepEqual(validateExemptions([{
    file: "scripts/check-maintainability.js",
    reason: "Fixture uses an existing file.",
  }]), []);

  const invalid = validateExemptions([
    { file: "src/**/*.ts", reason: "Too broad." },
    { file: "src/missing.ts", reason: "Missing." },
    { file: "scripts/check-maintainability.js", reason: "" },
  ]);
  assert.match(invalid[0] ?? "", /exact normalized relative file path/);
  assert.match(invalid[1] ?? "", /targets missing file/);
  assert.match(invalid[2] ?? "", /needs a reason/);
});
