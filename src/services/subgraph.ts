import { ClientError, GraphQLClient, gql } from "graphql-request";
import type { Variables } from "graphql-request";
import type { NetworkConfig } from "../lib/networks";
import type { Env } from "../env";
import { ETH_NAMEHASH } from "../constants";
import { HttpError } from "../lib/errors";

export type DomainRecord = {
	id: string
	name: string | null
	labelName: string | null
	labelhash: string
	createdAt: string
	registration: {
		registrationDate: string
		expiryDate: string
	} | null
	owner: { id: string } | null
}

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
`

// $id is String! rather than the schema's ID!: subgraph-compatible backends
// like ENSNode don't define the ID scalar, and both graph-node and ENSNode
// accept (and coerce) String for the domain(id:) argument.
const DOMAIN_BY_NAMEHASH = gql`
	query DomainByNamehash($id: String!) {
		domain(id: $id) {
			id
			name
			labelName
			labelhash
			createdAt
			registration {
				registrationDate
				expiryDate
			}
			owner {
				id
			}
		}
	}
`

// THE_GRAPH_API_KEY may hold one or more comma-separated keys. Requests are
// spread across them (random pick) and, on a key-fixable failure, retried on
// the remaining keys. Mirrors the IPFS_GATEWAYS CSV convention.
function graphApiKeys(env: Env): string[] {
  const raw = env.THE_GRAPH_API_KEY;
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean),
    ),
  ];
}

// Fisher–Yates. The key list is tiny (a handful), so a per-request shuffle is
// effectively free and avoids any shared/global rotation state on Workers.
function shuffled<T>(input: readonly T[]): T[] {
  const a = [...input];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

// A different key can only help for transport/auth/rate-limit/server faults.
// A deterministic GraphQL/query error (2xx with `errors`, or a 4xx like 400)
// returns the same for every key, so it is thrown immediately rather than
// burning the other keys' quota.
function isKeyFixableError(err: unknown): boolean {
  if (!(err instanceof ClientError)) return true; // network / transport / abort
  const status = err.response?.status;
  if (status === undefined) return true;
  return status === 401 || status === 403 || status === 429 || status >= 500;
}

async function requestWithRotation<T>(
  network: NetworkConfig,
  env: Env,
  document: string,
  variables: Variables,
): Promise<T> {
  const url = network.subgraphUrl;

  // Studio endpoints (sepolia/holesky) carry no {API_KEY} — no key, no
  // rotation. Behaviour identical to before.
  if (!url.includes("{API_KEY}")) {
    return new GraphQLClient(url).request<T>(document, variables);
  }

  const keys = graphApiKeys(env);
  if (keys.length === 0) {
    throw new HttpError(
      500,
      "subgraph URL requires THE_GRAPH_API_KEY but the env var is not set",
      "missing_graph_api_key",
    );
  }

  const order = shuffled(keys);
  for (let i = 0; i < order.length; i++) {
    const client = new GraphQLClient(url.replaceAll("{API_KEY}", order[i]!));
    try {
      return await client.request<T>(document, variables);
    } catch (err) {
      // Rethrow on the last key, or when another key can't help — preserving
      // the original error shape callers/onError already handle.
      if (i < order.length - 1 && isKeyFixableError(err)) continue;
      throw err;
    }
  }
  // Unreachable: keys.length > 0 guarantees the loop returns or throws.
  throw new HttpError(500, "subgraph request failed", "subgraph_error");
}

export async function queryDomainByLabelhash(
	network: NetworkConfig,
	env: Env,
	labelhash: `0x${string}`,
): Promise<DomainRecord | null> {
  const data = await requestWithRotation<{ domains: DomainRecord[] }>(
    network,
    env,
    DOMAIN_BY_LABELHASH,
    { labelhash },
  );
  return data.domains[0] ?? null;
}

export async function queryDomainByNamehash(
	network: NetworkConfig,
	env: Env,
	namehash: `0x${string}`,
): Promise<DomainRecord | null> {
  const data = await requestWithRotation<{ domain: DomainRecord | null }>(
    network,
    env,
    DOMAIN_BY_NAMEHASH,
    { id: namehash },
  );
  return data.domain;
}
