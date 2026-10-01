import { entryUlid } from "../../src/core/facts/types.js";

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A deterministic, distinct journal entry ULID for one fixture index. */
export function uniqueEntryUlid(index: number) {
  let value = index;
  let suffix = "";
  do {
    suffix = `${ULID_ALPHABET[value % ULID_ALPHABET.length]}${suffix}`;
    value = Math.floor(value / ULID_ALPHABET.length);
  } while (value > 0);
  return entryUlid(`01ARZ3NDEKTSV4RRFFQ69G5${suffix.padStart(3, "0")}`);
}
