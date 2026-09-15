const IDENTITY_SUFFIX_PATTERN = /^[0-9a-f]{4}$/u;

function requireIdentitySuffix(value: string): string {
  if (!IDENTITY_SUFFIX_PATTERN.test(value)) {
    throw new Error("identity suffix must be four lowercase hexadecimal digits");
  }
  return value;
}

/**
 * Mint one identity segment from a fitted stem by drawing a fresh random suffix
 * and letting the caller admit the candidate. A collision redraws the suffix
 * within the attempt budget; exhaustion returns the last collision rather than
 * lengthening the identity.
 */
export async function mintIdentitySegment<Value>(
  input: Readonly<{
    stem: string;
    attempts: number;
    drawSuffix: () => string;
    attempt: (segment: string) => Promise<Value>;
    collision: (value: Value) => boolean;
  }>,
): Promise<Value> {
  if (!Number.isSafeInteger(input.attempts) || input.attempts < 1) {
    throw new Error("identity mint attempt budget must be a positive safe integer");
  }
  let result!: Value;
  for (let index = 0; index < input.attempts; index += 1) {
    const suffix = requireIdentitySuffix(input.drawSuffix());
    result = await input.attempt(`${input.stem}-${suffix}`);
    if (!input.collision(result)) return result;
  }
  return result;
}
