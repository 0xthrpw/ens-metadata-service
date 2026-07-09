// Builds the worker Env for the Node runtime: platform bindings become local
// implementations (fs-backed R2, in-memory KV) and [vars] defaults from
// wrangler.toml become process.env fallbacks, so a bare `node dist/server.mjs`
// behaves like a fresh Workers deploy. Secrets and overrides arrive the same
// way hotbox/Railway inject them — plain environment variables.
import type { Env } from "../env";
import { FsR2Bucket } from "./r2fs";
import { MemoryKV } from "./kvMemory";

// Mirrors [vars] in wrangler.toml. Update both together.
const VAR_DEFAULTS = {
  ETH_RPC_URL: "https://eth.drpc.org",
  SEPOLIA_RPC_URL: "https://sepolia.drpc.org",
  HOLESKY_RPC_URL: "https://holesky.drpc.org",
  IPFS_GATEWAYS:
    "https://apac.orbitor.dev,https://eu.orbitor.dev,https://latam.orbitor.dev,https://ipfs.filebase.io,https://dweb.link,https://4everland.io,https://ipfs.io",
  SUBGRAPH_URL_MAINNET:
    "https://gateway.thegraph.com/api/{API_KEY}/subgraphs/id/5XqPmWe6gjyrJtFn9cLy237i4cWw2j9HcUJEXsP5qGtH",
  SUBGRAPH_URL_SEPOLIA:
    "https://api.studio.thegraph.com/query/49574/enssepolia/version/latest",
  SUBGRAPH_URL_HOLESKY:
    "https://api.studio.thegraph.com/query/49574/ensholesky/version/latest",
} as const;

const OPTIONAL_VARS = [
  "THE_GRAPH_API_KEY",
  "OPENSEA_API_KEY",
  "BASE_RPC_URL",
  "OPTIMISM_RPC_URL",
  "ARBITRUM_RPC_URL",
  "POLYGON_RPC_URL",
  "CACHE_INVALIDATION_TOKEN",
  "CF_API_TOKEN",
  "CF_ZONE_ID",
  "CACHE_PRELOAD_TOKEN",
  "PUBLIC_BASE_URL",
  "LOG_LEVEL",
] as const;

export function buildEnv(): Env {
  const dataDir = process.env.DATA_DIR ?? "/data";
  const env: Record<string, unknown> = {
    // The Node classes implement the slice of the binding interfaces the app
    // actually calls; the casts paper over the (unused) remainder.
    IPFS_CACHE: new FsR2Bucket(dataDir) as unknown as Env["IPFS_CACHE"],
    RESOLVER_CACHE: new MemoryKV() as unknown as Env["RESOLVER_CACHE"],
  };
  for (const [name, fallback] of Object.entries(VAR_DEFAULTS)) {
    env[name] = process.env[name] ?? fallback;
  }
  for (const name of OPTIONAL_VARS) {
    const value = process.env[name];
    if (value !== undefined && value !== "") env[name] = value;
  }
  return env as Env;
}
