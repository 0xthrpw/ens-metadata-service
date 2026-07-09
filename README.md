# ens-metadata-flarecloud

ENS metadata service running on Cloudflare Workers.

A subset of [`ensdomains/ens-metadata-service`](https://github.com/ensdomains/ens-metadata-service) ported to Workers. Serves NFT metadata JSON, resolved avatar/header images, server-rendered ENS name cards (SVG + PNG), and an NFT lookup endpoint. Name cards are rendered with `resvg-wasm` (no `node-canvas`); the upstream Puppeteer-based `/preview` and `/rasterize` endpoints are not included.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ethereumidentitykit/ens-metadata-flarecloud)

## Compatibility

| Endpoint                                        | Upstream |          Flarecloud          |
| ----------------------------------------------- | :------: | :--------------------------: |
| `GET /`                                         |    ✓     |       ✓ (Scalar docs)        |
| `GET /docs`                                     |    ✓     |       ✓ (Scalar docs)        |
| `GET /favicon.ico`                              |    ✓     |          ✓ (204)            |
| `GET /{network}/{contract}/{tokenId}`           |    ✓     |              ✓               |
| `GET /{network}/{contract}/{tokenId}/image`     |    ✓     |  ✓ (SVG card via resvg-wasm) |
| `GET /{network}/{contract}/{tokenId}/image/png` |    ✗     |   ✓ (PNG card via resvg-wasm)|
| `GET /{network}/{contract}/{tokenId}/rasterize` |    ✓     |     ✗ (needs Puppeteer)      |
| `GET /{network}/avatar/{name}`                  |    ✓     |              ✓               |
| `GET /{network}/avatar/{name}/meta`             |    ✓     |              ✓               |
| `GET /{network}/header/{name}`                  |    ✓     |              ✓               |
| `GET /{network}/header/{name}/meta`             |    ✓     |              ✓               |
| `GET /queryNFT`                                 |    ✓     |              ✓               |
| `GET /preview/{name}`                           |    ✓     |              ✗               |
| `POST /cache/invalidate`                        |    ✗     |     ✓ (indexer-only)         |
| `POST /cache/preload`                           |    ✗     |     ✓ (indexer-only)         |
| `GET /openapi.json`                             |    ✗     |              ✓               |
| `GET /llms.txt`                                 |    ✗     |              ✓               |

`network` is one of `mainnet`, `sepolia`, `holesky`. `contract` is the BaseRegistrar (v1) or NameWrapper (v2) address.

## One-click deploy

Click the **Deploy to Cloudflare** button above. Cloudflare forks this repo into your GitHub and runs `npm run deploy`. The deploy script creates or reuses the R2 bucket (`ens-metadata-ipfs-cache`) and KV namespace (`RESOLVER_CACHE`) on your account, then writes the account-specific KV namespace ID into the build copy of `wrangler.toml` before publishing.

The setup page will prompt for these optional secrets — leave them blank unless you need them:

- `THE_GRAPH_API_KEY` — one or more **comma-separated** Graph API keys. Requests are spread randomly across the keys and retried on a different key on rate-limit/transport failures. Blank uses the public subgraph endpoints.
- `OPENSEA_API_KEY` — OpenSea-hosted NFT metadata used by ERC-721 and ERC-1155 avatar/header lookups.

Public endpoints (`ETH_RPC_URL`, `SUBGRAPH_URL_*`, `IPFS_GATEWAYS`) come from `[vars]` in `wrangler.toml` and can be overridden on the same setup page. The indexer-only endpoints need their own secrets — see [Indexer endpoints](#indexer-endpoints).

## Local development

Requires Node 20+.

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in any secrets you have
npm run dev                      # wrangler dev on localhost:8787
npm test                         # vitest in workerd via @cloudflare/vitest-pool-workers
npm run typecheck                # tsc --noEmit
```

Open http://localhost:8787 for the Scalar docs. Miniflare simulates R2 and KV locally — no manual resource creation needed for dev.

## Deploy manually

If you'd rather clone and deploy from the CLI instead of using the button, log in with Wrangler, add any optional secrets you need, then deploy. `npm run deploy` will create or reuse the KV namespace and R2 bucket for the authenticated account before publishing.

```sh
npx wrangler secret put THE_GRAPH_API_KEY      # optional
npx wrangler secret put OPENSEA_API_KEY        # optional

npm run deploy
```

## Run on Node / Docker

The service also runs as a plain Node server for self-hosting on container
platforms. The app code is shared unchanged; `src/node/` injects local
stand-ins for the Workers platform pieces:

| Workers                       | Node                                                 |
| ----------------------------- | ---------------------------------------------------- |
| R2 bucket (`IPFS_CACHE`)      | files under `DATA_DIR` (default `/data`)             |
| KV (`RESOLVER_CACHE`)         | in-memory, same TTLs (cold after restart)            |
| edge cache (`caches.default`) | in-process LRU, honors `max-age` (128 MB cap)        |
| `HTMLRewriter`                | [`html-rewriter-wasm`](https://github.com/mrbbot/html-rewriter-wasm) polyfill — same lol-html engine |

```sh
npm run build:node                          # bundles to dist/server.mjs (esbuild)
PORT=8080 DATA_DIR=./data npm run start:node
npm run typecheck:node                      # tsc over the Node view of the codebase
```

Or containerized: `docker build -t ens-metadata .` then run with a volume on
`/data` so cached image bytes survive restarts. All configuration arrives as
plain environment variables with the same names and defaults as the Workers
deploy (`[vars]` in `wrangler.toml` are mirrored in `src/node/env.ts` — update
both together).

Self-hosting notes:

- `POST /cache/invalidate` still requires `CF_API_TOKEN` + `CF_ZONE_ID`
  because it purges the Cloudflare edge cache by tag. Self-hosted without
  Cloudflare's proxy in front there is no edge cache to purge, but the
  endpoint (its KV + R2 deletion included) stays 503 until all three secrets
  are set — same behavior as an unconfigured Workers deploy.
- The resolver KV and response caches are process-local; a restart serves
  cold until they re-warm. Image bytes in `DATA_DIR` persist.

## Configuration

Public vars live in `wrangler.toml` under `[vars]` and can be edited freely:

- `ETH_RPC_URL`, `SEPOLIA_RPC_URL`, `HOLESKY_RPC_URL`
- `IPFS_GATEWAYS` — comma-separated. All gateways are raced in parallel and the fastest successful response wins. The defaults in `wrangler.toml` are public, best-effort endpoints.
- `SUBGRAPH_URL_MAINNET`, `SUBGRAPH_URL_SEPOLIA`, `SUBGRAPH_URL_HOLESKY` — `{API_KEY}` in a URL is substituted with a `THE_GRAPH_API_KEY` key.
- `LOG_LEVEL` — `debug` | `info` | `warn` | `error` (default `info`). See [Observability](#observability).
- `PUBLIC_BASE_URL` — optional; the absolute origin `/cache/preload` self-fetches to warm the edge cache. Falls back to the incoming request origin when unset (set it behind a custom domain / preview).

Cloudflare retired its public IPFS gateway in 2024. For production, point `IPFS_GATEWAYS` at reliable dedicated gateways or a self-hosted Kubo node rather than relying on the public defaults.

## Indexer endpoints

Two indexer-only `POST` endpoints keep caches in sync with on-chain changes. Each returns `503` until its secrets are set; every other route is unaffected.

- **`POST /cache/invalidate`** — purge KV + R2 + the edge cache for a name/token. Secrets: `CACHE_INVALIDATION_TOKEN`, `CF_API_TOKEN`, `CF_ZONE_ID`. Spec: [`docs/cache-invalidation.md`](./docs/cache-invalidation.md).
- **`POST /cache/preload`** — warm R2 (by CID) and the per-colo edge cache (by `network`+`name`) so the first real user gets a hot response. Secret: `CACHE_PRELOAD_TOKEN` (optional `PUBLIC_BASE_URL`). Spec: [`docs/cache-preload.md`](./docs/cache-preload.md).

```sh
npx wrangler secret put CACHE_INVALIDATION_TOKEN
npx wrangler secret put CF_API_TOKEN
npx wrangler secret put CF_ZONE_ID
npx wrangler secret put CACHE_PRELOAD_TOKEN
```

## Caching

- Resolved avatar/header URIs are cached in KV for 15 minutes
- Image bytes are cached in R2, keyed by IPFS CID or by `sha256(url)` for HTTPS sources
- On a cache miss, IPFS/HTTPS images stream to the client while the R2 copy is written in the background, so time-to-first-byte does not wait on the full download
- HTTPS fetches are revalidated with `If-None-Match` / `If-Modified-Since` when an ETag or `Last-Modified` was stored
- Responses also opt into the Workers Cache API via `Cache-Control: public, max-age=900`
- Sanitized SVG bytes are stored in R2 with a `sanitizerVersion` field. When the SVG sanitizer policy changes, bump `SANITIZER_VERSION` in `src/services/sanitize.ts`; older cached entries are lazily re-sanitized on first read. Note: `*.workers.dev` preview URLs cannot be tag-purged — stale Workers Cache responses expire naturally after `max-age=900` (15 min).

## Observability

`[observability]` is enabled in `wrangler.toml`, so `console` output is ingested by Workers Logs. The service emits **structured single-line JSON** logs:

- One `request_complete` line per request (method, path, status, duration) carrying a `reqId` — Cloudflare's `cf-ray` when present, a UUID otherwise — propagated to all service-layer and `waitUntil` logs via `AsyncLocalStorage`.
- Unhandled errors log `unhandled_error`; handled 5xx log `http_error` (4xx are not logged).
- Cache-seam and IPFS gateway-race diagnostics (`r2_image_*`, `kv_resolver_*`, `ipfs_gateway_win`) are `debug`-level — set `LOG_LEVEL=debug` under `[vars]` to surface them.

## License

MIT, see [LICENSE](./LICENSE).
