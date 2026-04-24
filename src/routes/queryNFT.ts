import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { namehash } from "viem";
import type { Env } from "../env";
import { getNetwork } from "../lib/networks";
import { badRequest, notFound } from "../lib/errors";
import { queryDomainByNamehash } from "../services/subgraph";
import { normalizeName } from "../services/ens";
import { NAME_WRAPPER_V2 } from "../constants";
import { ErrorSchema, QueryNFTSchema } from "../schemas";

export const queryNFTRoutes = new OpenAPIHono<{ Bindings: Env }>();

const route = createRoute({
  method: "get",
  path: "/queryNFT",
  tags: ["query"],
  summary: "Look up an ENS name's NFT identifiers",
  request: {
    query: z.object({
      name: z.string().min(1).openapi({ example: "vitalik.eth" }),
      network: z
        .enum(["mainnet", "sepolia", "holesky"])
        .optional()
        .openapi({ example: "mainnet" }),
    }),
  },
  responses: {
    200: {
      description: "NFT identifiers",
      content: { "application/json": { schema: QueryNFTSchema } },
    },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

queryNFTRoutes.openapi(route, async (c) => {
  const { name: rawName, network: networkName = "mainnet" } = c.req.valid("query");

  const network = getNetwork(c.env, networkName);
  if (!network) throw badRequest(`unknown network: ${networkName}`);

  const name = normalizeName(rawName);
  const hash = namehash(name);
  const record = await queryDomainByNamehash(network, c.env, hash);
  if (!record) throw notFound(`domain not found: ${name}`);

  return c.json(
    {
      name,
      namehash: hash,
      contract: NAME_WRAPPER_V2,
      tokenId: BigInt(hash).toString(),
      owner: record.owner?.id ?? null,
      registration: record.registration,
    },
    200,
  );
});
