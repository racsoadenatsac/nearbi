export interface VerifyFields {
  accountId: string;
  publicKey: string;
  signature: string;
}
export function meteorSignedToPayload(out: unknown): VerifyFields;
