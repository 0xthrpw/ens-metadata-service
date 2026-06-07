import type { Env } from "../../env";
import { notFound } from "../../lib/errors";
import type { ResolvedUri } from "../avatarResolver";
import { createClient, getOwner, normalizeName } from "../ens";
import { resolveNftAvatar } from "../nftAvatar";
import { fetchImageBytes } from "./orchestrator";
import type { EnsContext, ImageResult } from "./types";

type Eip155Uri = Extract<ResolvedUri, { kind: "eip155" }>;

export async function handleEip155(
  env: Env,
  classified: Eip155Uri,
  ctx: ExecutionContext,
  ensContext?: EnsContext,
): Promise<ImageResult> {
  // Resolve the NFT (tokenURI → metadata JSON → image URI) and recurse
  // through fetchImageBytes so the resolved image goes through the existing
  // IPFS/HTTPS/data caching paths. Ownership check uses the address the ENS
  // name resolves to. Without an ensContext (debug-only callers) we skip the
  // check; otherwise a missing addr record makes verification impossible and
  // we treat it as not-found.
  let expectedOwner: `0x${string}` | null = null;
  if (ensContext) {
    expectedOwner = await getOwner(
      createClient(ensContext.network),
      normalizeName(ensContext.name),
    );
    if (!expectedOwner) {
      throw notFound(
        `${ensContext.name} has no addr record; cannot verify NFT avatar ownership`,
      );
    }
  }
  const meta = await resolveNftAvatar(
    env,
    {
      chainId: classified.chainId,
      namespace: classified.namespace,
      contract: classified.contract,
      tokenId: classified.tokenId,
    },
    expectedOwner,
  );
  // Pass undefined ensContext on recursion — the inner image URI is no
  // longer ENS-bound and shouldn't trigger another ownership check.
  return fetchImageBytes(env, meta.imageUri, ctx);
}
