import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import type { NetworkConfig } from "../../src/lib/networks";
import {
  queryDomainByLabelhash,
  queryDomainByNamehash,
} from "../../src/services/subgraph";

const NAMEHASH =
  "0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae" as const;
const KEYED = "https://gw.example/api/{API_KEY}/subgraphs/id/abc";
const STUDIO = "https://api.studio.example/query/123/ens/version/latest";

const DOMAIN = {
  id: NAMEHASH,
  name: "x.eth",
  labelName: "x",
  labelhash: "0x01",
  createdAt: "1",
  registration: { registrationDate: "2", expiryDate: "3" },
  owner: { id: "0xowner" },
};

function net(subgraphUrl: string): NetworkConfig {
  return { name: "mainnet", subgraphUrl } as unknown as NetworkConfig;
}
function envWith(key?: string): Env {
  return { THE_GRAPH_API_KEY: key } as unknown as Env;
}
function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function keyOf(url: string): string {
  return url.match(/\/api\/([^/]+)\//)?.[1] ?? "";
}
// graphql-request calls fetch(new URL(url), init) — the first arg is a URL.
function reqUrl(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  return String(input);
}
function spyFetch(
  handler: (n: number) => Response,
): { urls: string[] } {
  const urls: string[] = [];
  let n = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    urls.push(reqUrl(input));
    return handler(++n);
  });
  return { urls };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("subgraph THE_GRAPH_API_KEY rotation", () => {
  it("single key: one request, key substituted, returns data", async () => {
    const { urls } = spyFetch(() => jsonRes({ data: { domain: DOMAIN } }));
    const r = await queryDomainByNamehash(net(KEYED), envWith("k1"), NAMEHASH);
    expect(r?.name).toBe("x.eth");
    expect(urls).toHaveLength(1);
    expect(keyOf(urls[0]!)).toBe("k1");
  });

  it("multi key: a success is exactly one fetch with a key from the list", async () => {
    const { urls } = spyFetch(() => jsonRes({ data: { domains: [DOMAIN] } }));
    const r = await queryDomainByLabelhash(
      net(KEYED),
      envWith(" k1 , k2 ,k3, "),
      "0x01",
    );
    expect(r?.name).toBe("x.eth");
    expect(urls).toHaveLength(1);
    expect(["k1", "k2", "k3"]).toContain(keyOf(urls[0]!));
  });

  it("rotates to a different key on 429, then succeeds", async () => {
    const { urls } = spyFetch((n) =>
      n === 1
        ? jsonRes({ errors: [{ message: "rate limited" }] }, 429)
        : jsonRes({ data: { domain: DOMAIN } }),
    );
    const r = await queryDomainByNamehash(
      net(KEYED),
      envWith("k1,k2,k3"),
      NAMEHASH,
    );
    expect(r?.name).toBe("x.eth");
    expect(urls).toHaveLength(2);
    expect(keyOf(urls[0]!)).not.toBe(keyOf(urls[1]!));
  });

  it("tries every distinct key, then throws, when all fail 5xx", async () => {
    const { urls } = spyFetch(() =>
      jsonRes({ errors: [{ message: "boom" }] }, 500),
    );
    await expect(
      queryDomainByNamehash(net(KEYED), envWith("k1,k2,k3"), NAMEHASH),
    ).rejects.toBeTruthy();
    expect(urls).toHaveLength(3);
    expect(new Set(urls.map(keyOf)).size).toBe(3);
  });

  it("does not rotate on a deterministic GraphQL error (200 + errors)", async () => {
    const { urls } = spyFetch(() =>
      jsonRes({ errors: [{ message: "bad query" }] }, 200),
    );
    await expect(
      queryDomainByNamehash(net(KEYED), envWith("k1,k2,k3"), NAMEHASH),
    ).rejects.toBeTruthy();
    expect(urls).toHaveLength(1);
  });

  it("studio URL needs no key even when THE_GRAPH_API_KEY is unset", async () => {
    const { urls } = spyFetch(() => jsonRes({ data: { domain: DOMAIN } }));
    const r = await queryDomainByNamehash(
      net(STUDIO),
      envWith(undefined),
      NAMEHASH,
    );
    expect(r?.name).toBe("x.eth");
    expect(urls).toEqual([STUDIO]);
  });

  it("{API_KEY} URL with no key set throws 500 and never fetches", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(
      queryDomainByNamehash(net(KEYED), envWith(undefined), NAMEHASH),
    ).rejects.toMatchObject({ status: 500, code: "missing_graph_api_key" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("spreads requests across keys over many calls", async () => {
    const { urls } = spyFetch(() => jsonRes({ data: { domain: DOMAIN } }));
    for (let i = 0; i < 50; i++) {
      await queryDomainByNamehash(net(KEYED), envWith("k1,k2,k3"), NAMEHASH);
    }
    expect(new Set(urls.map(keyOf)).size).toBeGreaterThanOrEqual(2);
  });
});
