// Chain registry for NFT avatar resolution. NFT avatars use CAIP-22
// (`eip155:CHAIN/erc721:ADDR/ID`), which can reference any EVM chain — not
// just the ENS networks we serve metadata for. The ENS chains share their
// configured RPC URL with this resolver; for additional common chains we
// fall back to public drpc.org endpoints, with optional env-var overrides
// for deployments that want to use their own RPC providers.
import {
	type Chain,
	arbitrum,
	base,
	holesky,
	mainnet,
	optimism,
	polygon,
	sepolia,
} from "viem/chains";
import type { Env } from "../env";

export type NftChainConfig = {
	chainId: number;
	chain: Chain;
	rpcUrl: string;
};

export function getNftChain(env: Env, chainId: number): NftChainConfig | null {
	switch (chainId) {
		case 1:
			return { chainId, chain: mainnet, rpcUrl: env.ETH_RPC_URL };
		case 11155111:
			return { chainId, chain: sepolia, rpcUrl: env.SEPOLIA_RPC_URL };
		case 17000:
			return { chainId, chain: holesky, rpcUrl: env.HOLESKY_RPC_URL };
		case 8453:
			return { chainId, chain: base, rpcUrl: env.BASE_RPC_URL ?? "https://base.drpc.org" };
		case 10:
			return {
				chainId,
				chain: optimism,
				rpcUrl: env.OPTIMISM_RPC_URL ?? "https://optimism.drpc.org",
			};
		case 42161:
			return {
				chainId,
				chain: arbitrum,
				rpcUrl: env.ARBITRUM_RPC_URL ?? "https://arbitrum.drpc.org",
			};
		case 137:
			return { chainId, chain: polygon, rpcUrl: env.POLYGON_RPC_URL ?? "https://polygon.drpc.org" };
		default:
			return null;
	}
}
