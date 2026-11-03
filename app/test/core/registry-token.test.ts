import { describe, expect, it } from "vitest";
import { dockerInstructions, generateRegistryToken, hashToken, looksLikeRegistryToken, tokenAccount } from "../../src/core/registry-token";

describe("registry tokens (core)", () => {
  it("generates prefixed 32-byte base64url tokens, unique each time", () => {
    const a = generateRegistryToken();
    expect(a).toMatch(/^nbr_[A-Za-z0-9_-]{43}$/);
    expect(looksLikeRegistryToken(a)).toBe(true);
    expect(generateRegistryToken()).not.toBe(a);
    expect(looksLikeRegistryToken("nbr_short")).toBe(false);
    expect(looksLikeRegistryToken("ghp_" + a.slice(4))).toBe(false);
  });

  it("hashes to hex sha256", async () => {
    expect(await hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("tokenAccount honours revocation and expiry", () => {
    const rec = { tokenHash: "h", accountId: "a.near", expiresAt: 100, revoked: false, createdAt: 1 };
    expect(tokenAccount(rec, 99)).toBe("a.near");
    expect(tokenAccount(rec, 100)).toBeNull();
    expect(tokenAccount({ ...rec, revoked: true }, 50)).toBeNull();
    expect(tokenAccount(null, 50)).toBeNull();
  });

  it("builds docker login/pull instructions", () => {
    const i = dockerInstructions("registry.nearbi.ai", "a.near", "nbr_x");
    expect(i[0]).toBe("echo 'nbr_x' | docker login registry.nearbi.ai -u a.near --password-stdin");
    expect(i[1]).toContain("registry.nearbi.ai/nearbi/");
  });
});
