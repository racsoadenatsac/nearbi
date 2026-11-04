// Map Meteor Connect's near::sign_in_and_sign_message output to the /auth/verify payload.
// Meteor returns a near-js SignedMessage { accountId, publicKey: PublicKey, signature: Uint8Array };
// the server expects strings: publicKey "ed25519:<base58>", signature base64 (as wallet-selector sends).
// Pure (no DOM) so it is unit-tested against the real server verifier.

const bytesToB64 = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

export function meteorSignedToPayload(out) {
  const sm = out?.signedMessage;
  if (!sm) throw new Error("Meteor did not return a signed message");
  const accountId = sm.accountId || out.identifier?.accountId;
  const publicKey = typeof sm.publicKey === "string" ? sm.publicKey : sm.publicKey?.toString();
  const signature = typeof sm.signature === "string" ? sm.signature : sm.signature ? bytesToB64(new Uint8Array(sm.signature)) : "";
  if (!accountId || !publicKey || !signature) throw new Error("Meteor returned an incomplete signature");
  if (out.identifier?.accountId && out.identifier.accountId !== accountId) throw new Error("Meteor returned mismatched accounts");
  return { accountId, publicKey, signature };
}
