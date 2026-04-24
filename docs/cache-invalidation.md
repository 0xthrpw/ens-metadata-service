# Cache-invalidation endpoint — indexer integration spec

This spec is everything an indexer needs to call
`POST /cache/invalidate` on the ENS-metadata service so image and resolver
caches get purged when an ENS record changes.

The endpoint purges:

1. **KV resolver cache** — avatar + header URI entries for the name.
2. **R2 generated-image cache** — the rendered name-image SVG + PNG for
   the token (all cache versions).
3. **Cloudflare edge cache** — via purge-by-tag, across every variant
   (avatar, header, name image SVG + PNG) in one call.

One call per record change is sufficient. You do not need to pick a
specific asset to invalidate — the endpoint wipes everything tied to the
name.

---

## When to call it

Call the endpoint whenever a record you indexed could affect one of our
cached assets. The pragmatic set:

- `TextChanged` with key ∈ `{avatar, header}` — obvious cache invalidation.
- `AddrChanged` — needed when the name uses an NFT-based avatar whose
  ownership check now resolves differently.
- `NameChanged` / `NameRegistered` / `NameWrapped` / `NameUnwrapped` —
  the name-image renders the label text; a change in the wrapped/
  unwrapped state or the label itself makes the cached tile stale.

If it's cheaper to invalidate on *any* record change for a name than to
filter, do that — the endpoint is idempotent and rate-limit friendly
(see below). Over-invalidation just means one extra re-render on the
next request.

---

## Endpoint

```
POST https://<service-host>/cache/invalidate
Authorization: Bearer <CACHE_INVALIDATION_TOKEN>
Content-Type: application/json
```

Service host depends on the environment you're hitting (workers.dev
subdomain for preview, custom domain for prod). On the workers.dev
preview the KV + R2 deletes still run; only the CF-edge tag purge is a
no-op there (there is no zone), so don't rely on preview for
end-to-end verification of the CDN purge.

### Request body

```jsonc
{
  "items": [
    // Preferred shape when the indexer sees a token event — contract is
    // inferred from the service's known-contract list.
    { "network": "mainnet", "tokenId": "123" },

    // Name-only — useful when you only know the name from the event.
    { "network": "mainnet", "name": "foo.eth" },

    // Name + tokenId — both signals, fully precise.
    { "network": "mainnet", "name": "bar.eth", "tokenId": "456" },

    // Targeted at a single contract — only when you want to narrow
    // invalidation; typically unnecessary.
    { "network": "mainnet", "contract": "0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401", "tokenId": "789" }
  ]
}
```

- **`items`** — 1–100 entries per call. Batch aggressively when possible;
  CF rate-limits tag purges (see below).
- **`network`** — required. One of `mainnet`, `sepolia`, `holesky`.
- **`name`** — optional. Fully-qualified ENS name, lowercased, normalized.
  e.g. `"foo.eth"` or `"sub.foo.eth"`.
- **`tokenId`** — optional. Decimal or `0x`-hex token id from the NFT
  contract that fired the event. When sent without `contract`, the
  service tries every contract in its `TOKEN_CONTRACTS` list against
  this tokenId — so the indexer doesn't need to know whether the
  event came from the base registrar or the name wrapper.
- **`contract`** — optional. `0x`-prefixed EVM address of a specific NFT
  contract. Only needed when you want to narrow invalidation to that
  one contract; otherwise omit it. Requires `tokenId`.

**Each item must contain `name` or `tokenId` (or both).** Missing both
is rejected with `400`; sending `contract` without `tokenId` is also
rejected. If both `name` and `tokenId` are provided, invalidation is
maximally precise. Name-only items derive a tokenId per contract
(labelhash for the base registrar, namehash for the name wrapper).
Extra deletes on (contract, tokenId) pairs that don't actually hold
entries are harmless no-ops.

### Response body

`200 OK`:

```json
{
  "ok": true,
  "tags_purged": 4,
  "kv_deleted": 6,
  "r2_deleted": 4,
  "items": [
    {
      "network": "mainnet",
      "name": "foo.eth",
      "kv_deleted": 2,
      "r2_deleted": 2,
      "tags": ["ens:mainnet:name:foo.eth"]
    }
  ]
}
```

- `tags_purged` — unique tags sent to Cloudflare's purge API.
- `kv_deleted` — sum of KV keys deleted across items.
- `r2_deleted` — sum of R2 generated-image entries deleted across items.
- `items[*]` — per-item breakdown; `tags[]` shows the exact tags sent.

### Error responses

| Status | Body shape | When |
|---|---|---|
| `400` | `{ "error": "bad_request", "message": "..." }` | Item fails shape check, unknown `network`, or invalid `contract` address. |
| `401` | `{ "error": "unauthorized", "message": "unauthorized" }` | Missing or wrong bearer token. |
| `502` | `{ "error": "purge_failed", "message": "cloudflare purge failed (…): …" }` | Cloudflare's `/zones/.../purge_cache` returned an error. KV + R2 deletes already ran — safe to retry; they're idempotent. |
| `503` | `{ "error": "not_configured", "message": "<VAR> not configured" }` | The service hasn't set `CACHE_INVALIDATION_TOKEN` / `CF_API_TOKEN` / `CF_ZONE_ID`. Retry once the ops side confirms config. |

---

## Tag scheme (reference only)

The indexer doesn't pick tags — the service derives them. But for
debugging or direct-CF purges, the format is:

- `ens:{network}:name:{urlEncodedLowercaseName}`
- `ens:{network}:token:{lowercaseContract}:{lowercaseTokenHex}`

Example: `ens:mainnet:name:foo.eth`,
`ens:mainnet:token:0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85:0x…`.

All responses from `/mainnet/avatar/{name}`, `/mainnet/header/{name}`,
and `/mainnet/{contract}/{tokenId}/image[.png]` carry these tags in the
`Cache-Tag` header, which Cloudflare strips before the response reaches
the client.

---

## Rate limits

Cloudflare caps tag-purge requests per zone (per CF's docs):

| Plan | Rate | Bucket | Max tags per call |
|---|---|---|---|
| Free | 5 / min | 25 | 100 |
| Pro | 5 / sec | 25 | 100 |
| Business | 10 / sec | 50 | 100 |
| Enterprise | 50 / sec | 500 | 100 |

Indexer strategy:

- **Batch.** Collect tags over a short window (e.g. 1–5 s) and send a
  single call with up to 100 items. Most record-change bursts (e.g. a
  single tx touching multiple records on one name) collapse to one
  network call.
- **De-duplicate.** Dedupe items by the tuple you sent —
  `(network, name)`, `(network, tokenId)`, or
  `(network, contract, tokenId)` — before flushing.
- **Back off.** On `502` (CF purge failure) or `429`, use exponential
  backoff starting at 1 s, max ~60 s. The KV + R2 deletes are already
  done, so backoff only delays the CDN purge.
- **Don't block indexing.** The invalidation call should be best-effort
  and async relative to the indexer's write path. Worst case a failed
  purge leaves stale CDN entries for the `Cache-Control: max-age` window
  (15 min for avatar/header, 1 year for name images — but those are
  specifically the ones R2 already wiped, so the next request
  re-renders fresh).

---

## Reference implementations

### TypeScript / Node.js

```ts
const ENDPOINT = process.env.METADATA_INVALIDATION_URL!;   // e.g. "https://metadata.ens.…/cache/invalidate"
const TOKEN = process.env.METADATA_INVALIDATION_TOKEN!;    // same value as CACHE_INVALIDATION_TOKEN on the service

type Item = {
  network: "mainnet" | "sepolia" | "holesky";
  name?: string;
  contract?: string;
  tokenId?: string;
};

export async function invalidateCache(items: Item[]): Promise<void> {
  if (items.length === 0) return;
  for (let i = 0; i < items.length; i += 100) {
    const chunk = items.slice(i, i + 100);
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ items: chunk }),
    });
    if (res.status === 401 || res.status === 503) {
      throw new Error(`invalidation config problem: ${res.status} ${await res.text()}`);
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`invalidation failed (${res.status}): ${body}`);
    }
  }
}
```

### A minimal batcher (debounce + flush)

```ts
const PENDING: Item[] = [];
let flushTimer: NodeJS.Timeout | null = null;

export function enqueueInvalidation(item: Item): void {
  PENDING.push(item);
  if (!flushTimer) flushTimer = setTimeout(flush, 2_000);
}

async function flush(): Promise<void> {
  flushTimer = null;
  if (PENDING.length === 0) return;
  const batch = dedupe(PENDING.splice(0, PENDING.length));
  try {
    await invalidateCache(batch);
  } catch (err) {
    // Re-enqueue with capped retry — don't lose invalidations on transient failures.
    console.error("invalidation batch failed, re-queueing", err);
    for (const it of batch) PENDING.push(it);
    if (!flushTimer) flushTimer = setTimeout(flush, 30_000);
  }
}

function dedupe(items: Item[]): Item[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const key = `${i.network}|${i.name ?? ""}|${i.contract ?? ""}|${i.tokenId ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
```

---

## Configuration (indexer side)

Two env vars on the indexer:

- `METADATA_INVALIDATION_URL` — full URL to `/cache/invalidate` on the
  target environment.
- `METADATA_INVALIDATION_TOKEN` — bearer token. Same value the service
  has configured as `CACHE_INVALIDATION_TOKEN` (stored via
  `wrangler secret put` on the service side).

Rotate the token by coordinating a change on both sides — rotate the
service secret first, then update the indexer. During the ~seconds gap,
the indexer gets `401`s; retries succeed after the indexer's new token
is deployed.

---

## Verifying end-to-end

1. Pick a name you know the service renders (e.g. one with an avatar).
2. `curl -I https://<service>/mainnet/avatar/<name>` — note the `etag`.
3. `curl -I https://<service>/mainnet/<contract>/<tokenId>/image` — note
   the `cf-cache-status` header. First request is usually `MISS`; the
   second is `HIT`.
4. Call `POST /cache/invalidate` for that name.
5. Re-issue step 3 — `cf-cache-status` should go back to `MISS`
   (CF evicted the entry; our Worker re-renders from fresh data).
6. If using workers.dev preview: step 5 will *not* show `MISS` for the
   CDN layer (no zone), but the R2 cache was deleted so the re-render
   still happens at the Worker layer.

---

## Not in scope

- Shared content-addressed caches (`ipfs/*`, `https/*` in R2) are
  **not** purged. They're keyed by content hash, so a changed URL
  naturally resolves to a different cache entry.
- Manual per-asset purges are not supported — use the CF dashboard or
  CF API directly if you need that.

---

## Known limitations

- On a `*.workers.dev` host, Cache-Tag headers are emitted but CF has
  no zone to index them against. Tag purge is effectively a no-op on
  preview deploys. Use a custom-domain deploy to exercise the full flow.
- CF's tag-purge reflects eventually consistent across colos; new
  requests globally may serve stale for a few seconds after purge
  returns `200`. Design retries and SLAs with this in mind.
