# ens-metadata-flarecloud

ENS metadata service running on Cloudflare Workers.

A subset of [`ensdomains/ens-metadata-service`](https://github.com/ensdomains/ens-metadata-service) ported to Workers. Serves NFT metadata JSON, avatar/header images, and an NFT lookup endpoint. The image-generation endpoints (`/image`, `/rasterize`) are not included since they need `node-canvas` and Puppeteer.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/encryptedDegen/ens-metadata-flarecloud)

## Compatibility

| Endpoint                                        | Upstream |       Flarecloud        |
| ----------------------------------------------- | :------: | :---------------------: |
| `GET /`                                         |    ✓     |     ✓ (Scalar docs)     |
| `GET /docs`                                     |    ✓     |     ✓ (Scalar docs)     |
| `GET /favicon.ico`                              |    ✓     |         ✓ (204)         |
| `GET /{network}/{contract}/{tokenId}`           |    ✓     |            ✓            |
| `GET /{network}/{contract}/{tokenId}/image`     |    ✓     | ✗ (needs `node-canvas`) |
| `GET /{network}/{contract}/{tokenId}/rasterize` |    ✓     |   ✗ (needs Puppeteer)   |
| `GET /{network}/avatar/{name}`                  |    ✓     |            ✓            |
| `GET /{network}/avatar/{name}/meta`             |    ✓     |            ✓            |
| `GET /{network}/header/{name}`                  |    ✓     |            ✓            |
| `GET /{network}/header/{name}/meta`             |    ✓     |            ✓            |
| `GET /queryNFT`                                 |    ✓     |            ✓            |
| `GET /preview/{name}`                           |    ✓     |            ✗            |
| `GET /openapi.json`                             |    ✗     |            ✓            |
| `GET /llms.txt`                                 |    ✗     |            ✓            |

`network` is one of `mainnet`, `sepolia`, `holesky`. `contract` is the BaseRegistrar (v1) or NameWrapper (v2) address.

## One-click deploy

Click the **Deploy to Cloudflare** button above. Cloudflare forks this repo into your GitHub and runs `npm run deploy`. The deploy script creates or reuses the R2 bucket (`ens-metadata-ipfs-cache`) and KV namespace (`RESOLVER_CACHE`) on your account, then writes the account-specific KV namespace ID into the build copy of `wrangler.toml` before publishing.

The setup page will prompt for these optional secrets — leave them blank unless you need them:

- `THE_GRAPH_API_KEY` — authenticated Graph queries
- `OPENSEA_API_KEY` — OpenSea-hosted NFT metadata used by ERC-721 and ERC-1155 avatar/header lookups
- `RPC_API_KEY` — if your configured RPC URL needs auth
- `PINATA_GATEWAY_TOKEN` — for Pinata IPFS gateway

Public endpoints (`ETH_RPC_URL`, `SUBGRAPH_URL_*`, `IPFS_GATEWAYS`) come from `[vars]` in `wrangler.toml` and can be overridden on the same setup page.

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
npx wrangler secret put RPC_API_KEY            # optional
npx wrangler secret put PINATA_GATEWAY_TOKEN   # optional

npm run deploy
```

## Configuration

Public vars live in `wrangler.toml` under `[vars]` and can be edited freely:

- `ETH_RPC_URL`, `SEPOLIA_RPC_URL`, `HOLESKY_RPC_URL`
- `IPFS_GATEWAYS` (comma-separated, primary first; defaults to w3s.link, nftstorage.link, ipfs.io)
- `SUBGRAPH_URL_MAINNET`, `SUBGRAPH_URL_SEPOLIA`, `SUBGRAPH_URL_HOLESKY`

Cloudflare retired its public IPFS gateway in 2024. Pinata or a self-hosted Kubo node is recommended for production.

## Caching

- Resolved avatar/header URIs are cached in KV for 15 minutes
- Image bytes are cached in R2, keyed by IPFS CID or by `sha256(url)` for HTTPS sources
- HTTPS fetches are revalidated with `If-None-Match` / `If-Modified-Since` when an ETag or `Last-Modified` was stored
- Responses also opt into the Workers Cache API via `Cache-Control: public, max-age=900`
- Sanitized SVG bytes are stored in R2 with a `sanitizerVersion` field. When the SVG sanitizer policy changes, bump `SANITIZER_VERSION` in `src/services/sanitize.ts`; older cached entries are lazily re-sanitized on first read. Note: `*.workers.dev` preview URLs cannot be tag-purged — stale Workers Cache responses expire naturally after `max-age=900` (15 min).

## License

MIT, see [LICENSE](./LICENSE).
