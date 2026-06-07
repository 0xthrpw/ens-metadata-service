export type Env = {
  IPFS_CACHE: R2Bucket;
  RESOLVER_CACHE: KVNamespace;

  ETH_RPC_URL: string;
  SEPOLIA_RPC_URL: string;
  HOLESKY_RPC_URL: string;
  IPFS_GATEWAYS: string;
  SUBGRAPH_URL_MAINNET: string;
  SUBGRAPH_URL_SEPOLIA: string;
  SUBGRAPH_URL_HOLESKY: string;

  THE_GRAPH_API_KEY?: string;
  OPENSEA_API_KEY?: string;

  // Optional overrides for non-ENS chains used only when resolving NFT
  // avatars on chains other than the configured ENS networks. Public
  // drpc.org endpoints are used if these aren't set.
  BASE_RPC_URL?: string;
  OPTIMISM_RPC_URL?: string;
  ARBITRUM_RPC_URL?: string;
  POLYGON_RPC_URL?: string;

  // Cache-invalidation endpoint. When any of these are unset the
  // `/cache/invalidate` endpoint returns 503; every other route is
  // unaffected. Set them as secrets (`wrangler secret put ...`).
  CACHE_INVALIDATION_TOKEN?: string;
  CF_API_TOKEN?: string;
  CF_ZONE_ID?: string;

  // Indexer-only `/cache/preload` endpoint. When unset the endpoint returns
  // 503; every other route is unaffected. Set as a secret
  // (`wrangler secret put CACHE_PRELOAD_TOKEN`).
  CACHE_PRELOAD_TOKEN?: string;
  // Absolute base URL the preload endpoint self-fetches to warm the edge
  // cache (e.g. https://ens.example.com). Falls back to the incoming request
  // origin when unset. Set as a [vars] value, not a secret.
  PUBLIC_BASE_URL?: string;

  // Optional. One of "debug" | "info" | "warn" | "error". Minimum structured
  // log level emitted to Workers Logs; defaults to "info" when unset or
  // unrecognised. Set as a [vars] value, not a secret.
  LOG_LEVEL?: string;
};
