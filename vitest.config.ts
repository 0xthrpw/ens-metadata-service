import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2025-02-14",
        compatibilityFlags: ["nodejs_compat"],
        kvNamespaces: ["RESOLVER_CACHE"],
        r2Buckets: ["IPFS_CACHE"],
        // Mirror wrangler.toml [[rules]] so the pool externalises these
        // imports to workerd instead of letting Vite try to bundle them.
        modulesRules: [
          { type: "CompiledWasm", include: ["**/*.wasm"], fallthrough: true },
          { type: "Data", include: ["**/*.ttf", "**/*.otf"], fallthrough: true },
          { type: "Text", include: ["**/*.svg"], fallthrough: true },
        ],
        bindings: {
          ETH_RPC_URL: "https://cloudflare-eth.com",
          SEPOLIA_RPC_URL: "https://sepolia.drpc.org",
          HOLESKY_RPC_URL: "https://holesky.drpc.org",
          IPFS_GATEWAYS:
            "https://w3s.link,https://nftstorage.link,https://ipfs.io",
          SUBGRAPH_URL_MAINNET: "https://example.invalid/mainnet",
          SUBGRAPH_URL_SEPOLIA: "https://example.invalid/sepolia",
          SUBGRAPH_URL_HOLESKY: "https://example.invalid/holesky",
        },
      },
    }),
  ],
});
