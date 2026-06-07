import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const BASE = "http://example.com";

describe("admin endpoints surface", () => {
  it("exposes both indexer endpoints in the OpenAPI document", async () => {
    const res = await SELF.fetch(`${BASE}/openapi.json`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { paths: Record<string, unknown> };
    expect(doc.paths["/cache/invalidate"]).toBeDefined();
    expect(doc.paths["/cache/preload"]).toBeDefined();
  });

  it("documents /cache/preload in llms.txt", async () => {
    const res = await SELF.fetch(`${BASE}/llms.txt`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("/cache/preload");
  });

  it("/cache/preload requires a bearer token", async () => {
    const res = await SELF.fetch(`${BASE}/cache/preload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [{ cid: "QmPChd2hVbrJ6bfo3WBcTW4iZnpHm8TEzWkLHmLpXhF68A" }] }),
    });
    // 503 (token unset in the test env) or 401 (token set, missing bearer) —
    // never 200/500.
    expect([401, 503]).toContain(res.status);
  });
});
