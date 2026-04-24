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
  RPC_API_KEY?: string;
  PINATA_GATEWAY_TOKEN?: string;

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
};
