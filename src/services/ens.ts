import { createPublicClient, http, type PublicClient } from "viem";
import { normalize } from "viem/ens";
import type { NetworkConfig } from "../lib/networks";
import { badRequest } from "../lib/errors";
import { RPC_TIMEOUT_MS } from "../constants";

export function createClient(network: NetworkConfig): PublicClient {
  return createPublicClient({
    chain: network.chain,
    transport: http(network.rpcUrl, {
      fetchOptions: { signal: AbortSignal.timeout(RPC_TIMEOUT_MS) },
    }),
  });
}

export function normalizeName(name: string): string {
  try {
    return normalize(name);
  } catch {
    throw badRequest(`invalid ENS name: ${name}`);
  }
}

export async function getTextRecord(
  client: PublicClient,
  name: string,
  key: string,
): Promise<string | null> {
  const value = await client.getEnsText({ name, key });
  return value && value.length > 0 ? value : null;
}

export async function getOwner(
  client: PublicClient,
  name: string,
): Promise<`0x${string}` | null> {
  const addr = await client.getEnsAddress({ name });
  return addr ?? null;
}
