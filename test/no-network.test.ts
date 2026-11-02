// Guard self-check: the setup file must block fetch and outbound sockets.
import net from "node:net";
import { describe, expect, it } from "vitest";

describe("no-network guard", () => {
  it("blocks fetch", async () => {
    await expect(fetch("https://rpc.mainnet.near.org")).rejects.toThrow(/network disabled/);
  });
  it("blocks outbound TCP", () => {
    expect(() => net.connect({ host: "dynamodb.us-east-1.amazonaws.com", port: 443 })).toThrow(/network disabled/);
  });
});

describe("no-network guard reports the real target", () => {
  it("names the host it blocked", () => {
    expect(() => net.connect({ host: "s3.amazonaws.com", port: 443 })).toThrow("connect s3.amazonaws.com");
  });
});
