import { describe, expect, it } from "vitest";
import { MemoryRepository } from "../../src/adapters/memory-repository";
import { hashToken } from "../../src/core/registry-token";
import { issueRegistryToken, validateRegistryToken } from "../../src/services/registry";

describe("registry token service", () => {
  it("stores only the hash, validates, revokes the previous token and expires", async () => {
    const repo = new MemoryRepository();
    const opts = { accountId: "alice.near", expiresAt: 2000, nowSec: 1000, registryHost: "registry.nearbi.ai" };
    const t1 = await issueRegistryToken(repo, opts);
    expect([...repo.tokens.keys()]).toEqual([await hashToken(t1.token)]);
    expect(JSON.stringify([...repo.tokens.values()])).not.toContain(t1.token);
    expect(await validateRegistryToken(repo, t1.token, 1000)).toBe("alice.near");
    const t2 = await issueRegistryToken(repo, opts);
    expect(await validateRegistryToken(repo, t1.token, 1000)).toBeNull();
    expect(await validateRegistryToken(repo, t2.token, 1999)).toBe("alice.near");
    expect(await validateRegistryToken(repo, t2.token, 2000)).toBeNull();
    expect(await validateRegistryToken(repo, "not-a-token", 1000)).toBeNull();
  });
});
