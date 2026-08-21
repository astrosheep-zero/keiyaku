export type IdentityFamily = "aku" | "kei" | "task" | "resp";

function prefix(family: IdentityFamily): string {
  return `${family}/`;
}

function validSegment(segment: string): boolean {
  return segment.length > 0 && !/[\/\s\p{Cc}]/u.test(segment);
}

export function identityCoordinate(
  input: Readonly<{
    family: IdentityFamily;
    segments: readonly string[];
  }>,
): string {
  if (input.segments.length === 0 || !input.segments.every(validSegment)) {
    throw new TypeError("identity coordinate requires nonempty segments");
  }
  return `${prefix(input.family)}${input.segments.join("/")}`;
}

export function identitySegments(
  input: Readonly<{
    family: IdentityFamily;
    value: string;
  }>,
): readonly string[] {
  const marker = prefix(input.family);
  if (!input.value.startsWith(marker)) throw new TypeError(`identity must use ${marker}`);
  const segments = input.value.slice(marker.length).split("/");
  if (segments.length === 0 || !segments.every(validSegment)) {
    throw new TypeError("identity coordinate contains an invalid segment");
  }
  return segments;
}
