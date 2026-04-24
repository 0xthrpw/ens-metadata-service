// Resolves NFT avatars (CAIP-22 `eip155:CHAIN/erc{721,1155}:ADDR/ID`) to a
// fetchable image URI. Steps:
//   1. Look up the chain and call `tokenURI(uint256)` (ERC-721) or
//      `uri(uint256)` (ERC-1155). For ERC-1155, expand `{id}` to the
//      64-char zero-padded hex per the ERC-1155 metadata spec.
//   2. Fetch the metadata JSON from the resolved URI (HTTPS / ipfs:// /
//      data:) and pull the `image` field (with OpenSea `image_url` /
//      `image_data` fallbacks).
//   3. Verify the resolved image actually belongs to the ENS address: for
//      ERC-721, `ownerOf(id)` must match; for ERC-1155, `balanceOf(addr,id)
//      > 0`. Without this check anyone could set someone else's NFT as
//      their avatar.
//
// Returns the resolved (still-unfetched) image URI string so the existing
// `fetchImageBytes` pipeline can take over (HTTPS / IPFS / data caching all
// work the same way for the final image).
import { createPublicClient, http, type PublicClient, getAddress } from "viem";
import type { Env } from "../env";
import { getNftChain } from "../lib/nftChains";
import { badRequest, notFound, upstream, unsupported } from "../lib/errors";
import { decodeDataUri } from "./avatarResolver";
import { fetchIpfs, parseIpfs } from "./ipfs";
import { HTTPS_IMAGE_TIMEOUT_MS, RPC_TIMEOUT_MS } from "../constants";

export type NftAvatarRef = {
	chainId: number;
	namespace: "erc721" | "erc1155";
	contract: `0x${string}`;
	tokenId: string; // decimal string (avoids JSON-bigint pain)
};

const ERC721_ABI = [
	{
		name: "tokenURI",
		type: "function",
		stateMutability: "view",
		inputs: [{ name: "tokenId", type: "uint256" }],
		outputs: [{ type: "string" }],
	},
	{
		name: "ownerOf",
		type: "function",
		stateMutability: "view",
		inputs: [{ name: "tokenId", type: "uint256" }],
		outputs: [{ type: "address" }],
	},
] as const;

const ERC1155_ABI = [
	{
		name: "uri",
		type: "function",
		stateMutability: "view",
		inputs: [{ name: "id", type: "uint256" }],
		outputs: [{ type: "string" }],
	},
	{
		name: "balanceOf",
		type: "function",
		stateMutability: "view",
		inputs: [
			{ name: "account", type: "address" },
			{ name: "id", type: "uint256" },
		],
		outputs: [{ type: "uint256" }],
	},
] as const;

function clientFor(env: Env, chainId: number): PublicClient {
	const cfg = getNftChain(env, chainId);
	if (!cfg) {
		throw unsupported(
			`NFT avatar references chain ${chainId} but no RPC is configured for it`,
		);
	}
	return createPublicClient({
		chain: cfg.chain,
		transport: http(cfg.rpcUrl, {
			fetchOptions: { signal: AbortSignal.timeout(RPC_TIMEOUT_MS) },
		}),
	});
}

// ERC-1155 metadata URI may contain `{id}`, which must be replaced with the
// 64-char zero-padded lowercase hex of the token id. ERC-721 doesn't
// require this, but some ERC-721 contracts return the same template, so we
// apply unconditionally — it's a no-op when `{id}` isn't present.
export function expandIdTemplate(template: string, tokenIdDec: string): string {
	if (!template.includes("{id}")) return template;
	const hex = BigInt(tokenIdDec).toString(16).padStart(64, "0");
	return template.replaceAll("{id}", hex);
}

async function callTokenUri(
	client: PublicClient,
	ref: NftAvatarRef,
): Promise<string> {
	try {
		if (ref.namespace === "erc721") {
			const uri = await client.readContract({
				address: ref.contract,
				abi: ERC721_ABI,
				functionName: "tokenURI",
				args: [BigInt(ref.tokenId)],
			});
			return uri;
		}
		const uri = await client.readContract({
			address: ref.contract,
			abi: ERC1155_ABI,
			functionName: "uri",
			args: [BigInt(ref.tokenId)],
		});
		return uri;
	} catch (err) {
		throw upstream(
			`failed to read tokenURI from ${ref.contract} on chain ${ref.chainId}`,
			err,
		);
	}
}

async function verifyOwnership(
	client: PublicClient,
	ref: NftAvatarRef,
	expectedOwner: `0x${string}`,
): Promise<void> {
	try {
		if (ref.namespace === "erc721") {
			const owner = await client.readContract({
				address: ref.contract,
				abi: ERC721_ABI,
				functionName: "ownerOf",
				args: [BigInt(ref.tokenId)],
			});
			if (getAddress(owner) !== getAddress(expectedOwner)) {
				throw notFound(
					`NFT ${ref.contract}/${ref.tokenId} on chain ${ref.chainId} is owned by ${owner}, not ${expectedOwner}`,
				);
			}
			return;
		}
		const balance = await client.readContract({
			address: ref.contract,
			abi: ERC1155_ABI,
			functionName: "balanceOf",
			args: [expectedOwner, BigInt(ref.tokenId)],
		});
		if (balance === 0n) {
			throw notFound(
				`address ${expectedOwner} holds 0 of ERC-1155 ${ref.contract}/${ref.tokenId} on chain ${ref.chainId}`,
			);
		}
	} catch (err) {
		// Re-throw HttpErrors as-is; only wrap unexpected RPC failures.
		if (err instanceof Error && "status" in err) throw err;
		throw upstream(
			`ownership check failed for ${ref.contract}/${ref.tokenId} on chain ${ref.chainId}`,
			err,
		);
	}
}

// Fetches token metadata JSON from any of the URI schemes the metadata
// itself can use. Returns the parsed object — non-object payloads (or JSON
// parse failures) raise an upstream error so the caller falls back to the
// default avatar.
async function fetchMetadataJson(env: Env, uri: string): Promise<unknown> {
	if (uri.startsWith("data:")) {
		const { bytes } = decodeDataUri(uri);
		return parseJson(new TextDecoder().decode(bytes), uri);
	}
	if (uri.startsWith("ipfs://") || uri.startsWith("ipfs/")) {
		const ref = parseIpfs(uri);
		if (!ref) throw badRequest(`invalid ipfs URI in token metadata: ${uri}`);
		const res = await fetchIpfs(env, ref);
		return parseJson(await res.text(), uri);
	}
	if (uri.startsWith("ar://")) {
		const rest = uri.slice("ar://".length);
		if (!rest) throw badRequest(`malformed ar:// URI in token metadata: ${uri}`);
		return fetchHttpsJson(`https://arweave.net/${rest}`);
	}
	if (/^https?:\/\//i.test(uri)) {
		return fetchHttpsJson(uri);
	}
	throw unsupported(`unsupported metadata URI scheme: ${uri.slice(0, 40)}…`);
}

async function fetchHttpsJson(url: string): Promise<unknown> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), HTTPS_IMAGE_TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			cf: { cacheTtl: 3600, cacheEverything: true },
			signal: ctrl.signal,
		} as RequestInit);
		if (!res.ok) {
			throw upstream(`metadata fetch failed (${res.status}): ${url}`);
		}
		return parseJson(await res.text(), url);
	} catch (err) {
		if (err instanceof Error && "status" in err) throw err;
		throw upstream(`metadata fetch failed: ${url}`, err);
	} finally {
		clearTimeout(timer);
	}
}

function parseJson(text: string, source: string): unknown {
	try {
		return JSON.parse(text);
	} catch (err) {
		throw upstream(`invalid JSON metadata from ${source}`, err);
	}
}

// OpenSea-style metadata supports several image fields. `image_data` is
// inline SVG markup — wrap it in a data URI so the existing pipeline can
// sanitize and serve it. `image` and `image_url` are URI strings that go
// back through `fetchImageBytes`.
export function extractImageUri(metadata: unknown): string | null {
	if (!metadata || typeof metadata !== "object") return null;
	const m = metadata as Record<string, unknown>;
	if (typeof m.image === "string" && m.image.length > 0) return m.image;
	if (typeof m.image_url === "string" && m.image_url.length > 0) return m.image_url;
	if (typeof m.image_data === "string" && m.image_data.length > 0) {
		const svg = m.image_data;
		const base64 = btoa(unescape(encodeURIComponent(svg)));
		return `data:image/svg+xml;base64,${base64}`;
	}
	return null;
}

export type NftAvatarMeta = {
	chainId: number;
	namespace: "erc721" | "erc1155";
	contract: `0x${string}`;
	tokenId: string;
	tokenUri: string;
	imageUri: string;
};

/**
 * Resolves an NFT avatar reference to the underlying image URI.
 *
 * - `expectedOwner` is the address that the ENS name's `addr` record
 *   resolves to. Pass `null` to skip ownership verification (e.g. for
 *   debug/preview routes); the production avatar route always passes the
 *   resolved address.
 */
export async function resolveNftAvatar(
	env: Env,
	ref: NftAvatarRef,
	expectedOwner: `0x${string}` | null,
): Promise<NftAvatarMeta> {
	const client = clientFor(env, ref.chainId);
	const rawTokenUri = await callTokenUri(client, ref);
	const tokenUri = expandIdTemplate(rawTokenUri, ref.tokenId);

	// Run ownership check and metadata fetch in parallel — both depend only
	// on the same RPC client, but RPC and the metadata host are independent.
	const [, metadata] = await Promise.all([
		expectedOwner ? verifyOwnership(client, ref, expectedOwner) : Promise.resolve(),
		fetchMetadataJson(env, tokenUri),
	]);

	const imageUri = extractImageUri(metadata);
	if (!imageUri) {
		throw notFound(
			`token metadata at ${tokenUri} has no resolvable image field`,
		);
	}

	return {
		chainId: ref.chainId,
		namespace: ref.namespace,
		contract: ref.contract,
		tokenId: ref.tokenId,
		tokenUri,
		imageUri,
	};
}
