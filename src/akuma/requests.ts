import { isAbsolute, resolve } from "node:path";
import { AKUMA_REQUESTS_ENV } from "./provider.js";
export { AkumaBodyRequestError, requestBodyCommand } from "./request-rendezvous.js";

export function injectedBodyRequests(): string | null {
  const directory = process.env[AKUMA_REQUESTS_ENV];
  if (directory === undefined) return null;
  if (typeof directory !== "string" || !isAbsolute(directory) || resolve(directory) !== directory) {
    throw new Error(`${AKUMA_REQUESTS_ENV} must be an absolute normalized path`);
  }
  return directory;
}
