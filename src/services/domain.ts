import { isAddress, toHex } from "viem";
import type { Env } from "../env";
import { badRequest, notFound } from "../lib/errors";
import { BASE_REGISTRAR_V1, NAME_WRAPPER_V2 } from "../constants";
import { getNetwork, type NetworkConfig } from "../lib/networks";
import {
  queryDomainByLabelhash,
  queryDomainByNamehash,
  type DomainRecord,
} from "./subgraph";

export type ContractKind = "v1" | "v2";

export type ResolvedDomain = {
  network: NetworkConfig;
  kind: ContractKind;
  tokenHex: `0x${string}`;
  record: DomainRecord;
};

export function tokenIdToHex(tokenId: string): `0x${string}` {
  if (tokenId.startsWith("0x")) return tokenId as `0x${string}`;
  try {
    return toHex(BigInt(tokenId), { size: 32 });
  } catch {
    throw badRequest(`invalid tokenId: ${tokenId}`);
  }
}

export function contractKind(contract: string): ContractKind | null {
  const c = contract.toLowerCase();
  if (c === BASE_REGISTRAR_V1.toLowerCase()) return "v1";
  if (c === NAME_WRAPPER_V2.toLowerCase()) return "v2";
  return null;
}

export async function resolveDomain(
  env: Env,
  networkName: string,
  contract: string,
  tokenIdRaw: string,
): Promise<ResolvedDomain> {
  const network = getNetwork(env, networkName);
  if (!network) throw badRequest(`unknown network: ${networkName}`);
  if (!isAddress(contract)) throw badRequest("invalid contract address");

  const kind = contractKind(contract);
  if (!kind) throw badRequest(`unsupported contract: ${contract}`);

  const tokenHex = tokenIdToHex(tokenIdRaw);
  const record =
    kind === "v1"
      ? await queryDomainByLabelhash(network, env, tokenHex)
      : await queryDomainByNamehash(network, env, tokenHex);

  if (!record) throw notFound(`domain not found for token ${tokenIdRaw}`);
  return { network, kind, tokenHex, record };
}
