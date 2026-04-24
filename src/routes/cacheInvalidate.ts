import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { isAddress, labelhash, namehash } from "viem";
import type { Env } from "../env";
import { requireBearerToken } from "../lib/auth";
import { badRequest, HttpError } from "../lib/errors";
import { nameTag, tokenTag } from "../lib/cacheTags";
import { getNetwork } from "../lib/networks";
import { tokenIdToHex } from "../services/domain";
import { TOKEN_CONTRACTS } from "../constants";
import { deleteResolved } from "../storage/kvCache";
import { deleteGeneratedForToken } from "../storage/r2Cache";
import { ErrorSchema } from "../schemas";

export const cacheInvalidateRoutes = new OpenAPIHono<{ Bindings: Env }>();

const Item = z
  .object({
    network: z.string().min(1),
    name: z.string().min(1).optional(),
    contract: z.string().min(1).optional(),
    tokenId: z.string().min(1).optional(),
  })
  .refine((d) => d.name || d.tokenId, {
    message: "each item requires 'name' or 'tokenId'",
  })
  .refine((d) => !d.contract || d.tokenId, {
    message: "'contract' requires 'tokenId'",
  });

const RequestBody = z.object({
  items: z.array(Item).min(1).max(100),
});

const ItemResult = z.object({
  network: z.string(),
  name: z.string().optional(),
  contract: z.string().optional(),
  tokenId: z.string().optional(),
  kv_deleted: z.number().int().nonnegative(),
  r2_deleted: z.number().int().nonnegative(),
  tags: z.array(z.string()),
});

const ResponseBody = z.object({
  ok: z.boolean(),
  tags_purged: z.number().int().nonnegative(),
  kv_deleted: z.number().int().nonnegative(),
  r2_deleted: z.number().int().nonnegative(),
  items: z.array(ItemResult),
});

const route = createRoute({
  method: "post",
  path: "/cache/invalidate",
  tags: ["cache"],
  summary: "Invalidate cached name image, avatar, and header for ENS names",
  description:
    "Deletes KV resolver entries and R2 generated-image entries, then purges the Cloudflare edge cache by tag. Each item needs `name` or `tokenId` (or both). When `contract` is omitted, every contract in the service's `TOKEN_CONTRACTS` list is invalidated against the given token — the indexer doesn't need to know which contract a given tokenId belongs to. Requires `Authorization: Bearer <CACHE_INVALIDATION_TOKEN>`.",
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: RequestBody } } },
  },
  responses: {
    200: {
      description: "Invalidation summary",
      content: { "application/json": { schema: ResponseBody } },
    },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorSchema } } },
    502: { description: "Cloudflare purge API failed", content: { "application/json": { schema: ErrorSchema } } },
    503: {
      description: "Endpoint not configured (missing CACHE_INVALIDATION_TOKEN / CF_API_TOKEN / CF_ZONE_ID)",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

type Item = z.infer<typeof Item>;

type PerItem = {
  network: string;
  name?: string;
  contract?: string;
  tokenId?: string;
  kv_deleted: number;
  r2_deleted: number;
  tags: string[];
};

/**
 * Yield every (contract, tokenHex) pair the service should invalidate for
 * this item, given whichever of {name, tokenId, contract} were supplied.
 * Extra pairs against contracts that don't actually hold this token are
 * harmless — the R2 deletes and tag purges are no-ops on missing entries.
 */
function contractsToInvalidate(item: Item): Array<{ contract: string; tokenHex: `0x${string}` }> {
  const out: Array<{ contract: string; tokenHex: `0x${string}` }> = [];

  if (item.contract && item.tokenId) {
    if (!isAddress(item.contract)) {
      throw badRequest(`invalid contract address: ${item.contract}`);
    }
    out.push({ contract: item.contract, tokenHex: tokenIdToHex(item.tokenId) });
    return out;
  }

  if (item.tokenId) {
    const tokenHex = tokenIdToHex(item.tokenId);
    for (const c of TOKEN_CONTRACTS) out.push({ contract: c.address, tokenHex });
    return out;
  }

  // name-only: derive tokenHex per contract using its `derivation` kind.
  if (item.name) {
    for (const c of TOKEN_CONTRACTS) {
      if (c.derivation === "label") {
        const label = item.name.split(".")[0];
        if (!label) continue;
        out.push({ contract: c.address, tokenHex: labelhash(label) });
      } else {
        out.push({ contract: c.address, tokenHex: namehash(item.name) });
      }
    }
  }
  return out;
}

async function invalidateItem(env: Env, item: Item): Promise<PerItem> {
  if (!getNetwork(env, item.network)) {
    throw badRequest(`unknown network: ${item.network}`);
  }

  const tags = new Set<string>();
  let kvDeleted = 0;
  let r2Deleted = 0;

  const tasks: Promise<void>[] = [];

  if (item.name) {
    tags.add(nameTag(item.network, item.name));
    tasks.push(
      deleteResolved(env, "avatar", item.network, item.name).then(() => {
        kvDeleted++;
      }),
    );
    tasks.push(
      deleteResolved(env, "header", item.network, item.name).then(() => {
        kvDeleted++;
      }),
    );
  }

  for (const { contract, tokenHex } of contractsToInvalidate(item)) {
    tags.add(tokenTag(item.network, contract, tokenHex));
    tasks.push(
      deleteGeneratedForToken(env, item.network, contract, tokenHex).then((n) => {
        r2Deleted += n;
      }),
    );
  }

  await Promise.all(tasks);

  return {
    network: item.network,
    name: item.name,
    contract: item.contract,
    tokenId: item.tokenId,
    kv_deleted: kvDeleted,
    r2_deleted: r2Deleted,
    tags: [...tags],
  };
}

async function purgeTags(
  apiToken: string,
  zoneId: string,
  tags: string[],
): Promise<number> {
  if (tags.length === 0) return 0;
  let purged = 0;
  // Cloudflare caps a single purge call at 100 tags (per plan docs).
  for (let i = 0; i < tags.length; i += 100) {
    const chunk = tags.slice(i, i + 100);
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ tags: chunk }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new HttpError(
        502,
        `cloudflare purge failed (${res.status}): ${body.slice(0, 300)}`,
        "purge_failed",
      );
    }
    purged += chunk.length;
  }
  return purged;
}

cacheInvalidateRoutes.openapi(route, async (c) => {
  requireBearerToken(c, c.env.CACHE_INVALIDATION_TOKEN, "CACHE_INVALIDATION_TOKEN");
  if (!c.env.CF_API_TOKEN) {
    throw new HttpError(503, "CF_API_TOKEN not configured", "not_configured");
  }
  if (!c.env.CF_ZONE_ID) {
    throw new HttpError(503, "CF_ZONE_ID not configured", "not_configured");
  }

  const { items } = c.req.valid("json");

  const results = await Promise.all(items.map((item) => invalidateItem(c.env, item)));

  const allTags = new Set<string>();
  for (const r of results) for (const t of r.tags) allTags.add(t);

  const tagsPurged = await purgeTags(c.env.CF_API_TOKEN, c.env.CF_ZONE_ID, [...allTags]);

  const kvTotal = results.reduce((n, r) => n + r.kv_deleted, 0);
  const r2Total = results.reduce((n, r) => n + r.r2_deleted, 0);

  return c.json(
    { ok: true, tags_purged: tagsPurged, kv_deleted: kvTotal, r2_deleted: r2Total, items: results },
    200,
  );
});
