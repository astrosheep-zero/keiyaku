import assert from "node:assert/strict";
import test from "node:test";
import { validateExemptions } from "../scripts/check-maintainability.js";

test("maintainability exemptions require exact live paths but may outlive the violation", () => {
  assert.deepEqual(validateExemptions([{
    file: "scripts/check-maintainability.js",
    max: 501,
    reason: "Fixture uses an existing file that is already below the default limit.",
  }]), []);

  const invalid = validateExemptions([
    { file: "src/**/*.ts", max: 600, reason: "Too broad." },
    { file: "src/missing.ts", max: 600, reason: "Missing." },
  ]);
  assert.match(invalid[0] ?? "", /exact normalized relative file path/);
  assert.match(invalid[1] ?? "", /targets missing file/);
});
