import { type Chain, mainnet, sepolia, holesky } from "viem/chains";
import type { Env } from "../env";

export type NetworkName = "mainnet" | "sepolia" | "holesky";

export type NetworkConfig = {
  name: NetworkName;
  chain: Chain;
  rpcUrl: string;
  subgraphUrl: string;
};

export function getNetwork(env: Env, name: string): NetworkConfig | null {
  switch (name) {
    case "mainnet":
      return {
        name: "mainnet",
        chain: mainnet,
        rpcUrl: env.ETH_RPC_URL,
        subgraphUrl: env.SUBGRAPH_URL_MAINNET,
      };
    case "sepolia":
      return {
        name: "sepolia",
        chain: sepolia,
        rpcUrl: env.SEPOLIA_RPC_URL,
        subgraphUrl: env.SUBGRAPH_URL_SEPOLIA,
      };
    case "holesky":
      return {
        name: "holesky",
        chain: holesky,
        rpcUrl: env.HOLESKY_RPC_URL,
        subgraphUrl: env.SUBGRAPH_URL_HOLESKY,
      };
    default:
      return null;
  }
}
