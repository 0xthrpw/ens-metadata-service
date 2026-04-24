export const RESOLVER_TTL_SECONDS = 15 * 60;
export const STALE_RESOLVER_TTL_SECONDS = 2 * 60 * 60;
export const CACHE_API_MAX_AGE = 15 * 60;

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export const RPC_TIMEOUT_MS = 5_000;
export const IPFS_GATEWAY_TIMEOUT_MS = 4_000;
export const HTTPS_IMAGE_TIMEOUT_MS = 5_000;

export const BASE_REGISTRAR_V1 = "0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85" as const;
export const NAME_WRAPPER_V2 = "0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401" as const;

/**
 * Every ENS-name-bearing NFT contract the service knows about. Used by the
 * cache-invalidation endpoint to blast all candidates when the indexer
 * supplies a tokenId without a contract, or a name without a tokenId.
 *
 * `derivation` is how a tokenId is derived from a name for this contract:
 *   - "label" — `labelhash(firstLabel)` (base registrar, ETH 2LDs only)
 *   - "name"  — `namehash(fullName)` (name wrapper, any ENS name)
 *
 * Append an entry here when a new contract needs to be covered; no other
 * change is required for the invalidation endpoint.
 */
export const TOKEN_CONTRACTS = [
  { address: BASE_REGISTRAR_V1, derivation: "label" },
  { address: NAME_WRAPPER_V2, derivation: "name" },
] as const satisfies ReadonlyArray<{
  address: `0x${string}`;
  derivation: "label" | "name";
}>;

export const ETH_NAMEHASH =
  "0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae" as const;
