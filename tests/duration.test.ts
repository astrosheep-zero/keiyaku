import assert from "node:assert/strict";
import test from "node:test";
import { formatDuration, parseDuration } from "../src/duration.js";

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

test("parseDuration converts each supported unit into exact milliseconds", () => {
  assert.deepEqual(parseDuration("1ms"), { kind: "parsed", milliseconds: 1 });
  assert.deepEqual(parseDuration("1s"), { kind: "parsed", milliseconds: 1_000 });
  assert.deepEqual(parseDuration("1m"), { kind: "parsed", milliseconds: 60_000 });
  assert.deepEqual(parseDuration("1h"), { kind: "parsed", milliseconds: 3_600_000 });
  assert.deepEqual(parseDuration("7ms"), { kind: "parsed", milliseconds: 7 });
  assert.deepEqual(parseDuration("7s"), { kind: "parsed", milliseconds: 7_000 });
  assert.deepEqual(parseDuration("7m"), { kind: "parsed", milliseconds: 420_000 });
  assert.deepEqual(parseDuration("7h"), { kind: "parsed", milliseconds: 25_200_000 });
});

test("parseDuration admits zero in every unit and refuses other leading zeros", () => {
  for (const unit of ["ms", "s", "m", "h"]) {
    assert.deepEqual(parseDuration(`0${unit}`), { kind: "parsed", milliseconds: 0 });
  }
  assert.deepEqual(parseDuration("0"), { kind: "invalid" });
  assert.deepEqual(parseDuration("000"), { kind: "invalid" });
  assert.deepEqual(parseDuration("00ms"), { kind: "invalid" });
  assert.deepEqual(parseDuration("01s"), { kind: "invalid" });
  assert.deepEqual(parseDuration("00s"), { kind: "invalid" });
});

test("parseDuration refuses text that is not an exact non-negative integer with a supported unit", () => {
  const malformed = [
    "",
    "1",
    "ms",
    "s",
    "1 s",
    " 1s",
    "1s ",
    "1S",
    "1MS",
    "-1s",
    "+1s",
    "1.5s",
    "0.5s",
    "1,000ms",
    "1_000ms",
    "1e3s",
    "0x10ms",
    "NaNms",
    "Infinityms",
    "1d",
    "1w",
    "1y",
    "1ss",
    "1sms",
    "1s2",
    "s1",
    "1ms2s",
    "\uFF11s",
    "\u0661s",
  ];
  for (const value of malformed) {
    assert.deepEqual(parseDuration(value), { kind: "invalid" }, JSON.stringify(value));
  }
});

test("parseDuration admits the largest exact value per unit and overflows on the next step", () => {
  assert.deepEqual(parseDuration(`${MAX_SAFE}ms`), { kind: "parsed", milliseconds: MAX_SAFE });
  assert.deepEqual(parseDuration("9007199254740991ms"), { kind: "parsed", milliseconds: MAX_SAFE });
  assert.deepEqual(parseDuration("9007199254740992ms"), { kind: "overflow" });

  assert.deepEqual(parseDuration("9007199254740s"), { kind: "parsed", milliseconds: 9_007_199_254_740_000 });
  assert.deepEqual(parseDuration("9007199254741s"), { kind: "overflow" });

  assert.deepEqual(parseDuration("150119987579m"), { kind: "parsed", milliseconds: 9_007_199_254_740_000 });
  assert.deepEqual(parseDuration("150119987580m"), { kind: "overflow" });

  assert.deepEqual(parseDuration("2501999792h"), { kind: "parsed", milliseconds: 9_007_199_251_200_000 });
  assert.deepEqual(parseDuration("2501999793h"), { kind: "overflow" });
});

test("parseDuration distinguishes overflow from invalid and keeps the widest integer precision", () => {
  assert.deepEqual(parseDuration("99999999999999999999s"), { kind: "overflow" });
  assert.deepEqual(parseDuration("99999999999999999999x"), { kind: "invalid" });
  assert.deepEqual(parseDuration(`${"9".repeat(100)}ms`), { kind: "overflow" });

  const boundary = parseDuration(`${MAX_SAFE}ms`);
  assert.equal(boundary.kind, "parsed");
  if (boundary.kind === "parsed") assert.ok(Number.isSafeInteger(boundary.milliseconds));
});

test("formatDuration selects the coarsest unit that divides the value exactly", () => {
  assert.equal(formatDuration(1_000), "1s");
  assert.equal(formatDuration(60_000), "1m");
  assert.equal(formatDuration(90_000), "90s");
  assert.equal(formatDuration(61_000), "61s");
  assert.equal(formatDuration(3_600_000), "1h");
  assert.equal(formatDuration(5_400_000), "90m");
  assert.equal(formatDuration(7_200_000), "2h");
  assert.equal(formatDuration(86_400_000), "24h");
});

test("formatDuration falls back to raw milliseconds when no unit divides exactly", () => {
  assert.equal(formatDuration(0), "0ms");
  assert.equal(formatDuration(1), "1ms");
  assert.equal(formatDuration(999), "999ms");
  assert.equal(formatDuration(1_500), "1500ms");
  assert.equal(formatDuration(59_999), "59999ms");
  assert.equal(formatDuration(3_599_999), "3599999ms");
  assert.equal(formatDuration(3_600_001), "3600001ms");
  assert.equal(formatDuration(MAX_SAFE), "9007199254740991ms");
});

test("canonical durations format back to the same text and every value survives a parse-format round trip", () => {
  for (const text of ["0ms", "1ms", "500ms", "1s", "45s", "1m", "90m", "1h", "24h"]) {
    const parsed = parseDuration(text);
    assert.equal(parsed.kind, "parsed", text);
    if (parsed.kind === "parsed") assert.equal(formatDuration(parsed.milliseconds), text);
  }

  for (const milliseconds of [
    0,
    1,
    999,
    1_000,
    1_500,
    59_999,
    60_000,
    61_000,
    90_000,
    3_599_999,
    3_600_000,
    3_600_001,
    5_400_000,
    7_200_000,
    86_400_000,
    MAX_SAFE,
  ]) {
    assert.deepEqual(parseDuration(formatDuration(milliseconds)), { kind: "parsed", milliseconds });
  }
});

test("every zero spelling normalizes to 0ms", () => {
  for (const unit of ["ms", "s", "m", "h"]) {
    const parsed = parseDuration(`0${unit}`);
    assert.equal(parsed.kind, "parsed");
    if (parsed.kind === "parsed") assert.equal(formatDuration(parsed.milliseconds), "0ms");
  }
});
