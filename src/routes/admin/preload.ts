import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Env } from "../../env";
import { badRequest } from "../../lib/errors";
import { log } from "../../lib/log";
import { runIndexerBatch } from "../../lib/indexerBatch";
import { DEFAULT_IMAGE_HEADER } from "../../constants";
import { getNetwork } from "../../lib/networks";
import { parseIpfs } from "../../services/ipfs";
import { warmIpfsToR2 } from "../../services/image";
import { ErrorSchema } from "../../schemas";

export const cachePreloadRoutes = new OpenAPIHono<{ Bindings: Env }>();

const SELF_FETCH_TIMEOUT_MS = 15_000;
const PRELOAD_MARKER = "x-ens-preload";

const Item = z
  .object({
    cid: z.string().min(1).optional(),
    network: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    kind: z.enum(["avatar", "header", "both"]).default("both"),
  })
  .refine((d) => d.cid || (d.network && d.name), {
    message: "each item requires 'cid' or both 'network' and 'name'",
  });

const RequestBody = z.object({
  items: z.array(Item).min(1).max(100),
});

const ItemResult = z.object({
  cid: z.string().optional(),
  network: z.string().optional(),
  name: z.string().optional(),
  kind: z.string().optional(),
  r2_warmed: z.boolean(),
  edge_warmed: z.boolean(),
  status: z.number().int().optional(),
  bytes: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});

const ResponseBody = z.object({
  ok: z.boolean(),
  warmed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  items: z.array(ItemResult),
});

const route = createRoute({
  method: "post",
  path: "/cache/preload",
  tags: ["cache"],
  summary: "Preload IPFS content into R2 and the Cloudflare edge cache",
  description:
    "Best-effort warm of the caches so the first real user gets a fast response. Each item needs a `cid` (warms R2 keyed by the CID) and/or `network`+`name` (self-fetches the public avatar/header URL so KV, R2, and the per-colo edge cache are primed; `kind` selects avatar/header/both, default both). Per-item failures don't fail the batch (`ok` stays true; see `failed` and per-item `error`). Edge warming is per-colo and best-effort. Requires `Authorization: Bearer <CACHE_PRELOAD_TOKEN>`.",
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: RequestBody } } },
  },
  responses: {
    200: {
      description: "Preload summary",
      content: { "application/json": { schema: ResponseBody } },
    },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    503: {
      description: "Endpoint not configured (missing CACHE_PRELOAD_TOKEN)",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

type Item = z.infer<typeof Item>;

type PerItem = {
  cid?: string;
  network?: string;
  name?: string;
  kind?: string;
  r2_warmed: boolean;
  edge_warmed: boolean;
  status?: number;
  bytes?: number;
  error?: string;
};

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function warmItem(env: Env, base: string, item: Item): Promise<PerItem> {
  const out: PerItem = {
    cid: item.cid,
    network: item.network,
    name: item.name,
    kind: item.network && item.name ? item.kind : undefined,
    r2_warmed: false,
    edge_warmed: false,
  };

  const errors: string[] = [];

  if (item.cid) {
    try {
      const ref = parseIpfs(item.cid);
      if (!ref) throw badRequest(`invalid ipfs CID/URI: ${item.cid}`);
      const r = await warmIpfsToR2(env, ref);
      out.r2_warmed = true;
      out.bytes = r.bytes;
    } catch (err) {
      errors.push(`cid: ${errMessage(err)}`);
    }
  }

  // Independent of the cid outcome: a bad or temporarily unavailable CID
  // must not prevent KV/R2/edge warming for the ENS name. Both signals are
  // best-effort and reported per-item (see docs/cache-preload.md).
  if (item.network && item.name) {
    if (!getNetwork(env, item.network)) {
      errors.push(`unknown network: ${item.network}`);
    } else {
      const kinds: Array<"avatar" | "header"> =
        item.kind === "both" ? ["avatar", "header"] : [item.kind];
      try {
        let lastStatus = 0;
        let anyWarmed = false;
        // Each requested kind is independent and best-effort: a failure on
        // one (e.g. no avatar record) must not skip the others, and an
        // earlier success must not be masked by a later failure. Continue
        // through all kinds, recording per-kind errors and partial success.
        for (const k of kinds) {
          // Self-fetch the public route so its handler warms KV + R2 + the
          // (per-colo) edge cache via its own success-path cache.put. No
          // If-None-Match (we must populate a full response) and no
          // cf.cacheEverything — that would let Cloudflare cache the 200
          // default fallback, which the route deliberately never caches. The
          // marker header lets preload trip a loop.
          const res = await fetch(
            `${base}/${item.network}/${k}/${encodeURIComponent(item.name)}`,
            {
              headers: { [PRELOAD_MARKER]: "1" },
              signal: AbortSignal.timeout(SELF_FETCH_TIMEOUT_MS),
            },
          );
          lastStatus = res.status;
          if (!res.ok && res.status !== 304) {
            errors.push(`edge: ${k} -> ${res.status}`);
            continue;
          }
          // The route turns a missing record / pre-stream upstream failure
          // into a 200 default image. That is NOT a real warm — the intended
          // image/R2 path didn't run — so report it instead of claiming hot.
          if (res.headers.get(DEFAULT_IMAGE_HEADER)) {
            await res.arrayBuffer().catch(() => {}); // release the small body
            errors.push(
              `edge: ${k} served default image (record not set or pre-stream upstream failure)`,
            );
            continue;
          }
          // Drain so the route's waitUntil cache.put can complete. A drain
          // failure means the body aborted / hit the size guard mid-stream,
          // so the edge entry did NOT actually warm — surface it rather than
          // swallow it and falsely report the item hot.
          try {
            await res.arrayBuffer();
          } catch (err) {
            errors.push(`edge: ${k} body incomplete: ${errMessage(err)}`);
            continue;
          }
          anyWarmed = true;
        }
        out.status = lastStatus;
        if (anyWarmed) out.edge_warmed = true;
      } catch (err) {
        errors.push(`edge: ${errMessage(err)}`);
      }
    }
  }

  if (errors.length > 0) out.error = errors.join("; ");
  return out;
}

cachePreloadRoutes.openapi(route, async (c) => {
  // Loop tripwire: a self-fetch must never re-enter preload itself.
  if (c.req.header(PRELOAD_MARKER)) {
    throw badRequest(`${PRELOAD_MARKER} requests must not target /cache/preload`);
  }

  const { items } = c.req.valid("json");
  const base = (c.env.PUBLIC_BASE_URL ?? new URL(c.req.url).origin).replace(
    /\/+$/,
    "",
  );

  // Bounded concurrency: each network+name item fans out to self-fetches that
  // themselves do RPC/subgraph/IPFS work — never an unbounded Promise.all.
  const results = await runIndexerBatch(c, {
    token: c.env.CACHE_PRELOAD_TOKEN,
    tokenLabel: "CACHE_PRELOAD_TOKEN",
    items,
    concurrency: 6,
    handle: (item) => warmItem(c.env, base, item),
  });

  const warmed = results.filter((r) => r.r2_warmed || r.edge_warmed).length;
  const failed = results.filter((r) => r.error).length;

  (c.get("log") ?? log).info("cache_preload", {
    items: items.length,
    warmed,
    failed,
  });

  return c.json({ ok: true, warmed, failed, items: results }, 200);
});
