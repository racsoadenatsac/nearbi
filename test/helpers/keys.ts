// Local ed25519 keypairs for tests (never touches a real wallet or network).

import { base58Encode, base64Encode } from "../../src/lib/encoding";
import { nep413Hash, type Nep413Payload } from "../../src/auth/nep413";

export interface TestKey {
  publicKey: string; // "ed25519:<base58>"
  sign(p: Nep413Payload): Promise<string>; // base64 signature, as wallet-selector returns it
}

export async function generateTestKey(): Promise<TestKey> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return {
    publicKey: `ed25519:${base58Encode(raw)}`,
    async sign(p) {
      const sig = await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, await nep413Hash(p));
      return base64Encode(new Uint8Array(sig));
    },
  };
}
