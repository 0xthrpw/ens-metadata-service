import { GraphQLClient, gql } from "graphql-request";
import type { NetworkConfig } from "../lib/networks";
import type { Env } from "../env";
import { ETH_NAMEHASH } from "../constants";
import { HttpError } from "../lib/errors";

export type DomainRecord = {
  id: string;
  name: string | null;
  labelName: string | null;
  labelhash: string;
  createdAt: string;
  registration: {
    registrationDate: string;
    expiryDate: string;
  } | null;
  owner: { id: string } | null;
};

const DOMAIN_BY_LABELHASH = gql`
  query DomainByLabelhash($labelhash: String!) {
    domains(where: { labelhash: $labelhash, parent: "${ETH_NAMEHASH}" }, first: 1) {
      id
      name
      labelName
      labelhash
      createdAt
      registration { registrationDate expiryDate }
      owner { id }
    }
  }
`;

const DOMAIN_BY_NAMEHASH = gql`
  query DomainByNamehash($id: ID!) {
    domain(id: $id) {
      id
      name
      labelName
      labelhash
      createdAt
      registration { registrationDate expiryDate }
      owner { id }
    }
  }
`;

function resolveSubgraphUrl(url: string, env: Env): string {
  if (!url.includes("{API_KEY}")) return url;
  if (!env.THE_GRAPH_API_KEY) {
    throw new HttpError(
      500,
      "subgraph URL requires THE_GRAPH_API_KEY but the env var is not set",
      "missing_graph_api_key",
    );
  }
  return url.replaceAll("{API_KEY}", env.THE_GRAPH_API_KEY);
}

function client(network: NetworkConfig, env: Env): GraphQLClient {
  return new GraphQLClient(resolveSubgraphUrl(network.subgraphUrl, env));
}

export async function queryDomainByLabelhash(
  network: NetworkConfig,
  env: Env,
  labelhash: `0x${string}`,
): Promise<DomainRecord | null> {
  const c = client(network, env);
  const data = await c.request<{ domains: DomainRecord[] }>(DOMAIN_BY_LABELHASH, { labelhash });
  return data.domains[0] ?? null;
}

export async function queryDomainByNamehash(
  network: NetworkConfig,
  env: Env,
  namehash: `0x${string}`,
): Promise<DomainRecord | null> {
  const c = client(network, env);
  const data = await c.request<{ domain: DomainRecord | null }>(DOMAIN_BY_NAMEHASH, {
    id: namehash,
  });
  return data.domain;
}
