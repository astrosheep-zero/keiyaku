import { appendFileSync, writeFileSync } from "node:fs";
import { register } from "node:module";

async function waitForStartupBarrier(readyPath) {
  if (typeof readyPath === "string" && readyPath.length > 0) writeFileSync(readyPath, "ready\n", "utf8");
  await new Promise((resolve) => {
    process.stdin.once("data", resolve);
    process.stdin.resume();
  });
}

const receiptPath = process.env.KEIYAKU_TEST_AKUMA_BODY_PID_RECEIPT;
const isAkumaBody = process.argv.some((arg) => /(^|[\\/])akuma-body\.(m?[jt]s)$/u.test(arg));
if (isAkumaBody && typeof process.env.KEIYAKU_TEST_AKUMA_BODY_EMPTY_PUBLICATION_BARRIER === "string") {
  register(new URL("./akuma-body-empty-publication-loader.mjs", import.meta.url));
}
if (typeof receiptPath === "string" && receiptPath.length > 0 && isAkumaBody) {
  const barrierPath = process.env.KEIYAKU_TEST_AKUMA_BODY_PID_RECEIPT_BARRIER;
  if (barrierPath === "stdin") {
    await waitForStartupBarrier(process.env.KEIYAKU_TEST_AKUMA_BODY_PID_RECEIPT_READY);
  }
  appendFileSync(receiptPath, `${process.pid}\n`, "utf8");
}
