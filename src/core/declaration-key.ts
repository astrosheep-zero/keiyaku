import { createHash } from "node:crypto";

declare const declarationKeyBrand: unique symbol;

export type DeclarationKey = string & { readonly [declarationKeyBrand]: "DeclarationKey" };

const DECLARATION_KEY = /^[0-9a-f]{64}$/;

export type DeclarationForKey = Readonly<{
  executor: string;
  script: string;
}>;

export function declarationKey(value: string): DeclarationKey {
  if (!DECLARATION_KEY.test(value)) throw new Error("declaration key must be a lowercase SHA-256 content digest");
  return value as DeclarationKey;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Canonical content identity for ordered Verification declarations. */
export function verificationDeclarationKey(declarations: readonly DeclarationForKey[]): DeclarationKey {
  const canonical = `[${declarations.map((declaration) => `{"executor":${JSON.stringify(declaration.executor)},"script":${JSON.stringify(declaration.script)}}`).join(",")}]`;
  return declarationKey(sha256(new TextEncoder().encode(canonical)));
}
