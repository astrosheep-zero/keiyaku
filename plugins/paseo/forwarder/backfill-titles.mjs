#!/usr/bin/env node
import { backfillMirrorTitles } from "./index.js";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  console.log("Usage: node plugins/paseo/forwarder/backfill-titles.mjs <world> [akuId]\nUses the local PASEO_HOME daemon and its stored credential; renames existing mirrors only.");
} else if (args.length < 1 || args.length > 2 || args.some((arg) => arg.startsWith("-")) ||
  (args[1] !== undefined && !/^aku\/[^/]+\/[^/]+$/u.test(args[1]))) {
  console.error("Usage: node plugins/paseo/forwarder/backfill-titles.mjs <world> [akuId]");
  process.exitCode = 2;
} else {
  try {
    const renamed = await backfillMirrorTitles(args[0], args[1]);
    console.log(JSON.stringify({ renamed }));
  } catch (error) {
    console.error(`Mirror title backfill failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
