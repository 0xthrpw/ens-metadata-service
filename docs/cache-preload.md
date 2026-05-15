# Cache-preload endpoint — indexer integration spec

This spec is everything an indexer needs to call `POST /cache/preload`
on the ENS-metadata service so the caches are warm *before* the first
real user requests an asset.

It is the inverse of [`POST /cache/invalidate`](./cache-invalidation.md):
invalidate clears stale entries; preload primes fresh ones. Call preload
right after invalidate (or right after you've indexed a new/changed
record you expect traffic for) so the first visitor gets a hot response
instead of paying the cold IPFS-gateway + render cost.

The endpoint warms:

1. **R2 IPFS cache** — for an item with a `cid`: the content is fetched
   via the gateway race, sanitized (SVGs), and stored in R2.
2. **KV + R2 + edge cache** — for an item with `network`+`name`: the
   service self-fetches the public avatar/header URL(s), whose handler
   resolves the record, fills KV + R2, and populates the Cloudflare
   edge cache.

Preload is **best-effort and idempotent**. Per-item failures never fail
the batch.

---

## When to call it

- After a `TextChanged` (`avatar`/`header`), `AddrChanged`,
  `NameChanged`/`NameRegistered`/`NameWrapped`/`NameUnwrapped` for a
  name you expect to be requested soon — typically right after the
  matching `/cache/invalidate` call.
- When you ingest a brand-new name/CID and want the first lookup hot.

Over-preloading is cheap and safe (the work is the same a first user
would have triggered anyway), but it does cost subrequests — batch and
bound it like invalidation.

---

## Endpoint

```
POST https://<service-host>/cache/preload
Authorization: Bearer <CACHE_PRELOAD_TOKEN>
Content-Type: application/json
```

`CACHE_PRELOAD_TOKEN` is a **separate secret** from
`CACHE_INVALIDATION_TOKEN` so preload can be rotated/scoped
independently. Set it with `wrangler secret put CACHE_PRELOAD_TOKEN`.

### Edge-warming is per-colo and best-effort

The self-fetch primes the Cloudflare edge cache **only in the
datacenter (colo) that served the preload request**. Other colos stay
cold until their first real request; global warmth builds with traffic.
KV and R2 are global, so the expensive IPFS/render cost is paid once
regardless. `r2_warmed` / `edge_warmed` mean "warm initiated and the
fetch succeeded", not "confirmed persisted" — the inner route's writes
run in `waitUntil`.

By default the service self-fetches its own request origin. Behind a
custom domain / on preview / `wrangler dev`, set `PUBLIC_BASE_URL`
(a non-secret `[vars]` value, e.g. `https://metadata.ens.example`) so
the self-fetch targets the canonical host.

### Request body

```jsonc
{
  "items": [
    // Warm R2 for a known IPFS CID (or ipfs:// URI). No public route, so
    // R2-only (no edge warm).
    { "cid": "QmPChd2hVbrJ6bfo3WBcTW4iZnpHm8TEzWkLHmLpXhF68A" },

    // Warm KV + R2 + edge for a name. `kind` ∈ avatar|header|both
    // (default both).
    { "network": "mainnet", "name": "foo.eth" },
    { "network": "mainnet", "name": "bar.eth", "kind": "avatar" },

    // Both signals on one item: CID warms R2, name warms the edge.
    { "cid": "ipfs://Qm…/avatar.svg", "network": "mainnet", "name": "baz.eth" }
  ]
}
```

- **`items`** — 1–100 entries per call. Self-fetches run with bounded
  concurrency (6) to stay within Worker subrequest limits.
- **`cid`** — optional. Raw CID or `ipfs://`/`ipfs/` URI (path allowed).
  Warms R2 keyed by the CID.
- **`network`** — optional (required with `name`). One of `mainnet`,
  `sepolia`, `holesky`.
- **`name`** — optional (required with `network`). Fully-qualified ENS
  name, lowercased, normalized.
- **`kind`** — optional, `avatar` | `header` | `both` (default `both`).
  Only meaningful with `network`+`name`.

**Each item must contain `cid` or both `network` and `name`.** Missing
both is rejected with `400`.

### Response body

`200 OK`:

```json
{
  "ok": true,
  "warmed": 2,
  "failed": 1,
  "items": [
    { "cid": "Qm…", "r2_warmed": true, "edge_warmed": false, "bytes": 12345 },
    { "network": "mainnet", "name": "foo.eth", "kind": "both", "r2_warmed": false, "edge_warmed": true, "status": 200 },
    { "cid": "bad", "r2_warmed": false, "edge_warmed": false, "error": "invalid ipfs CID/URI: bad" }
  ]
}
```

- `warmed` — items where at least one of R2/edge was warmed.
- `failed` — items that recorded an `error`. An item can be both warmed
  and failed (e.g. CID warmed but the name self-fetch failed).
- `ok` is `true` even with `failed > 0` — preload is best-effort;
  inspect per-item flags and retry selectively.

### Error responses

| Status | Body shape | When |
|---|---|---|
| `400` | `{ "error": "bad_request", "message": "..." }` | Item fails shape check, or the request carries the internal `x-ens-preload` loop-marker header. |
| `401` | `{ "error": "unauthorized", "message": "unauthorized" }` | Missing or wrong bearer token. |
| `503` | `{ "error": "not_configured", "message": "CACHE_PRELOAD_TOKEN not configured" }` | The service hasn't set `CACHE_PRELOAD_TOKEN`. |

Upstream/gateway/name failures are **not** a request-level error — they
surface per item in `items[*].error` with `ok: true`.

---

## Reference implementation

### TypeScript / Node.js

```ts
const ENDPOINT = process.env.METADATA_PRELOAD_URL!;   // e.g. "https://metadata.ens.…/cache/preload"
const TOKEN = process.env.METADATA_PRELOAD_TOKEN!;    // same value as CACHE_PRELOAD_TOKEN on the service

type Item = {
  cid?: string;
  network?: "mainnet" | "sepolia" | "holesky";
  name?: string;
  kind?: "avatar" | "header" | "both";
};

export async function preloadCache(items: Item[]): Promise<void> {
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
      throw new Error(`preload config problem: ${res.status} ${await res.text()}`);
    }
    // 200 with per-item errors is normal & best-effort — log, don't throw.
    if (!res.ok && res.status !== 200) {
      throw new Error(`preload failed (${res.status}): ${await res.text()}`);
    }
  }
}
```

Pair it with the same debounce/flush batcher as
[cache-invalidation](./cache-invalidation.md#a-minimal-batcher-debounce--flush):
on a record change, enqueue an `invalidate` then a `preload` for the
same `(network, name)`.

---

## Not in scope

- Preload does not guarantee global edge warmth (per-colo, see above).
- Preload does not purge anything — use `/cache/invalidate` first if the
  underlying record changed.
- A bare `cid` does not warm the edge (there is no public route keyed by
  a raw CID); pass `network`+`name` for edge warming.
