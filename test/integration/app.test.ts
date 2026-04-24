import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const BASE = "http://example.com";

describe("app", () => {
  it("serves Scalar docs at /", async () => {
    const res = await SELF.fetch(`${BASE}/`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.toLowerCase()).toContain("<!doctype html");
  });

  it("serves a valid OpenAPI spec", async () => {
    const res = await SELF.fetch(`${BASE}/openapi.json`);
    expect(res.status).toBe(200);
    const spec = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.paths["/queryNFT"]).toBeDefined();
    expect(spec.paths["/{network}/avatar/{name}"]).toBeDefined();
    expect(spec.paths["/{network}/header/{name}"]).toBeDefined();
    expect(spec.paths["/{network}/{contract}/{tokenId}"]).toBeDefined();
  });

  it("404s unknown paths", async () => {
    const res = await SELF.fetch(`${BASE}/definitely-not-a-route`);
    expect(res.status).toBe(404);
  });
});

describe("validation", () => {
  it("rejects queryNFT without a name", async () => {
    const res = await SELF.fetch(`${BASE}/queryNFT`);
    expect(res.status).toBe(400);
  });

  it("rejects an unknown network", async () => {
    const res = await SELF.fetch(`${BASE}/fakenet/avatar/vitalik.eth`);
    expect(res.status).toBe(400);
  });

  it("rejects a malformed contract address", async () => {
    const res = await SELF.fetch(`${BASE}/mainnet/notanaddress/1`);
    expect(res.status).toBe(400);
  });

  it("rejects an unsupported contract", async () => {
    const res = await SELF.fetch(
      `${BASE}/mainnet/0x0000000000000000000000000000000000000001/1`,
    );
    expect(res.status).toBe(400);
  });
});
