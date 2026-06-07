import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import { MAX_IMAGE_BYTES } from "../../src/constants";
import app from "../../src/index";
import { getIpfs } from "../../src/storage/r2Cache";

const TOKEN = "preload-secret";
const CID = "QmPChd2hVbrJ6bfo3WBcTW4iZnpHm8TEzWkLHmLpXhF68A";
// Distinct path per test → distinct R2 key, so cached writes from one test
// don't satisfy another test's fetch.
const cidUri = (tag: string) => `ipfs://${CID}/${tag}.png`;

function makeEnv(over: Partial<Env> = {}): Env {
  return {
    ...(env as unknown as Env),
    IPFS_GATEWAYS: "https://gw.example",
    ETH_RPC_URL: "https://rpc.example/mainnet",
    SEPOLIA_RPC_URL: "https://rpc.example/sepolia",
    HOLESKY_RPC_URL: "https://rpc.example/holesky",
    SUBGRAPH_URL_MAINNET: "https://subgraph.example/mainnet",
    SUBGRAPH_URL_SEPOLIA: "https://subgraph.example/sepolia",
    SUBGRAPH_URL_HOLESKY: "https://subgraph.example/holesky",
    CACHE_PRELOAD_TOKEN: TOKEN,
    ...over,
  } as Env;
}

function req(
  body: unknown,
  headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` },
  url = "http://preload.test/cache/preload",
): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

// Route through the root app so onError translates HttpError -> status.
async function call(request: Request, e: Env) {
  const ctx = createExecutionContext();
  const res = await app.fetch(request, e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("POST /cache/preload — auth & validation", () => {
  it("503 when CACHE_PRELOAD_TOKEN is unset", async () => {
    const res = await call(
      req({ items: [{ cid: cidUri("a") }] }),
      makeEnv({ CACHE_PRELOAD_TOKEN: undefined }),
    );
    expect(res.status).toBe(503);
  });

  it("401 on missing/incorrect bearer", async () => {
    expect(
      (await call(req({ items: [{ cid: cidUri("b") }] }, {}), makeEnv())).status,
    ).toBe(401);
    expect(
      (
        await call(
          req({ items: [{ cid: cidUri("c") }] }, { authorization: "Bearer nope" }),
          makeEnv(),
        )
      ).status,
    ).toBe(401);
  });

  it("400 on schema violations", async () => {
    expect((await call(req({ items: [] }), makeEnv())).status).toBe(400);
    expect(
      (await call(req({ items: [{ kind: "avatar" }] }), makeEnv())).status,
    ).toBe(400); // neither cid nor network+name
    expect(
      (await call(req({ items: [{ network: "mainnet", name: "a.eth", kind: "x" }] }), makeEnv())).status,
    ).toBe(400); // bad kind enum
    const tooMany = { items: Array.from({ length: 101 }, () => ({ cid: cidUri("z") })) };
    expect((await call(req(tooMany), makeEnv())).status).toBe(400);
  });

  it("400 loop tripwire when x-ens-preload header is present", async () => {
    const res = await call(
      req({ items: [{ cid: cidUri("loop") }] }, {
        authorization: `Bearer ${TOKEN}`,
        "x-ens-preload": "1",
      }),
      makeEnv(),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /cache/preload — cid warms R2", () => {
  it("fetches the CID and stores it in R2", async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(png, { headers: { "content-type": "image/png" } }),
    );

    const res = await call(req({ items: [{ cid: cidUri("store") }] }), makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.warmed).toBe(1);
    expect(body.failed).toBe(0);
    expect(body.items[0].r2_warmed).toBe(true);
    expect(body.items[0].edge_warmed).toBe(false);
    expect(body.items[0].bytes).toBe(png.byteLength);

    const cached = await getIpfs(makeEnv(), { cid: CID, path: "/store.png" });
    expect(cached).not.toBeNull();
  });

  it("records a per-item error for an invalid CID but keeps ok:true", async () => {
    const res = await call(req({ items: [{ cid: "not-a-cid" }] }), makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.warmed).toBe(0);
    expect(body.failed).toBe(1);
    expect(body.items[0].r2_warmed).toBe(false);
    expect(typeof body.items[0].error).toBe("string");
  });

  it("oversize CID is a per-item failure, batch still ok:true", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array(MAX_IMAGE_BYTES + 1), {
        headers: { "content-type": "image/png" },
      }),
    );
    const res = await call(req({ items: [{ cid: cidUri("big") }] }), makeEnv());
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.failed).toBe(1);
    expect(body.items[0].error).toMatch(/too large|exceeds size limit/);
  });
});

describe("POST /cache/preload — network+name warms the edge", () => {
  it("self-fetches the public avatar+header URLs for kind=both", async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      seen.push({ url, init });
      return new Response("ok", { status: 200 });
    });

    const res = await call(
      req({ items: [{ network: "mainnet", name: "vitalik.eth", kind: "both" }] }),
      makeEnv(),
    );
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body.items[0].edge_warmed).toBe(true);
    expect(body.items[0].status).toBe(200);

    const urls = seen.map((s) => s.url);
    expect(urls).toContain("http://preload.test/mainnet/avatar/vitalik.eth");
    expect(urls).toContain("http://preload.test/mainnet/header/vitalik.eth");
    for (const s of seen) {
      const h = s.init?.headers as Record<string, string>;
      expect(h["x-ens-preload"]).toBe("1");
      expect(s.init?.headers).not.toHaveProperty("If-None-Match");
      // Must not ask Cloudflare to cache the subrequest — that would cache a
      // 200 default fallback the route itself never caches.
      expect((s.init as { cf?: { cacheEverything?: boolean } }).cf?.cacheEverything).toBeUndefined();
    }
  });

  it("treats a 200 default-image fallback as not warmed", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/avatar/")) {
        // The route downgrades a missing record / pre-stream upstream
        // failure to a 200 default image, tagged with this header.
        return new Response("<svg/>", {
          status: 200,
          headers: {
            "content-type": "image/svg+xml",
            "x-ens-default-image": "1",
          },
        });
      }
      return new Response("ok", { status: 200 });
    });

    const res = await call(
      req({ items: [{ network: "mainnet", name: "norecord.eth", kind: "avatar" }] }),
      makeEnv(),
    );
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);

    const it0 = body.items[0];
    expect(it0.edge_warmed).toBe(false);
    expect(it0.error).toMatch(/served default image/);
    expect(body.warmed).toBe(0);
    expect(body.failed).toBe(1);
  });

  it("kind=both: a failed kind does not skip the other; partial success is reported", async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      urls.push(url);
      if (url.includes("/avatar/")) {
        // No avatar record → 200 default image (not a real warm).
        return new Response("<svg/>", {
          status: 200,
          headers: { "content-type": "image/svg+xml", "x-ens-default-image": "1" },
        });
      }
      return new Response("ok", { status: 200 }); // header warms fine
    });

    const res = await call(
      req({ items: [{ network: "mainnet", name: "halfok.eth", kind: "both" }] }),
      makeEnv(),
    );
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);

    // Header was still attempted despite the avatar failure (no early break).
    expect(urls).toContain("http://preload.test/mainnet/avatar/halfok.eth");
    expect(urls).toContain("http://preload.test/mainnet/header/halfok.eth");

    const it0 = body.items[0];
    expect(it0.edge_warmed).toBe(true); // header warmed (partial success)
    expect(it0.error).toMatch(/avatar served default image/);
    expect(body.warmed).toBe(1);
    expect(body.failed).toBe(1);
  });

  it("uses PUBLIC_BASE_URL when set, else the request origin", async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      urls.push(typeof input === "string" ? input : (input as Request).url);
      return new Response("ok", { status: 200 });
    });

    await call(
      req({ items: [{ network: "mainnet", name: "a.eth", kind: "avatar" }] }),
      makeEnv({ PUBLIC_BASE_URL: "https://cdn.example" }),
    );
    expect(urls).toContain("https://cdn.example/mainnet/avatar/a.eth");
  });

  it("unknown network is a per-item error", async () => {
    const res = await call(
      req({ items: [{ network: "fakenet", name: "a.eth" }] }),
      makeEnv(),
    );
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.failed).toBe(1);
    expect(body.items[0].error).toMatch(/unknown network/);
  });

  it("bounds self-fetch concurrency to <= 6", async () => {
    let inFlight = 0;
    let peak = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/avatar/")) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 3));
        inFlight--;
      }
      return new Response("ok", { status: 200 });
    });

    const items = Array.from({ length: 12 }, (_, i) => ({
      network: "mainnet",
      name: `n${i}.eth`,
      kind: "avatar" as const,
    }));
    const res = await call(req({ items }), makeEnv());
    expect(res.status).toBe(200);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(6);
  });

  it("a failing cid does not block name-based edge warming on the same item", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("gw.example")) return new Response("nope", { status: 502 });
      return new Response("ok", { status: 200 });
    });

    const res = await call(
      req({
        items: [
          {
            cid: cidUri("blocked"),
            network: "mainnet",
            name: "z.eth",
            kind: "avatar",
          },
        ],
      }),
      makeEnv(),
    );
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);

    const it0 = body.items[0];
    expect(it0.r2_warmed).toBe(false); // cid fetch failed
    expect(it0.edge_warmed).toBe(true); // name path still ran
    expect(it0.status).toBe(200);
    expect(it0.error).toMatch(/cid:/);
    expect(body.warmed).toBe(1);
    expect(body.failed).toBe(1);
  });

  it("a 200 self-fetch whose body fails to drain is an edge error, not warmed", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/avatar/")) {
        return new Response(
          new ReadableStream({
            start(ctrl) {
              ctrl.error(new Error("body aborted"));
            },
          }),
          { status: 200, headers: { "content-type": "image/png" } },
        );
      }
      return new Response("ok", { status: 200 });
    });

    const res = await call(
      req({ items: [{ network: "mainnet", name: "drainfail.eth", kind: "avatar" }] }),
      makeEnv(),
    );
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);

    const it0 = body.items[0];
    expect(it0.edge_warmed).toBe(false);
    expect(it0.error).toMatch(/edge:/);
    expect(body.warmed).toBe(0);
    expect(body.failed).toBe(1);
  });

  it("mixed batch: some warmed, some failed, ok stays true", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("gw.example")) {
        return new Response(Uint8Array.from([1, 2, 3]), {
          headers: { "content-type": "image/png" },
        });
      }
      return new Response("ok", { status: 200 });
    });

    const res = await call(
      req({
        items: [
          { cid: cidUri("mixed") },
          { cid: "bad" },
          { network: "mainnet", name: "ok.eth", kind: "avatar" },
        ],
      }),
      makeEnv(),
    );
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.warmed).toBe(2);
    expect(body.failed).toBe(1);
  });
});
