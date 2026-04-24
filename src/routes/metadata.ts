import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { keccak256, namehash } from "viem";
import type { Env } from "../env";
import { resolveDomain } from "../services/domain";
import { CACHE_API_MAX_AGE } from "../constants";
import {
  AddressParam,
  ErrorSchema,
  NFTMetadataSchema,
  NetworkParam,
  TokenIdParam,
  type MetadataAttribute,
} from "../schemas";
import { ens_normalize } from "@adraffy/ens-normalize";

export const metadataRoutes = new OpenAPIHono<{ Bindings: Env }>();

const route = createRoute({
  method: "get",
  path: "/{network}/{contract}/{tokenId}",
  tags: ["metadata"],
  summary: "Get ENS NFT metadata JSON",
  request: {
    params: z.object({
      network: NetworkParam,
      contract: AddressParam,
      tokenId: TokenIdParam,
    }),
  },
  responses: {
    200: {
      description: "NFT metadata",
      content: { "application/json": { schema: NFTMetadataSchema } },
    },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
  },
});

function isNormalized(name: string): boolean {
  try {
    return ens_normalize(name) === name;
  } catch {
    return false;
  }
}

metadataRoutes.openapi(route, async (c) => {
  const { network: networkName, contract, tokenId: tokenIdRaw } = c.req.valid("param");
  const { kind, tokenHex, record } = await resolveDomain(
    c.env,
    networkName,
    contract,
    tokenIdRaw,
  );

  const name = record.name ?? (record.labelName ? `${record.labelName}.eth` : null);
  const registration = record.registration;
  const attributes: MetadataAttribute[] = [];

  if (record.createdAt) {
    attributes.push({
      trait_type: "Created Date",
      display_type: "date",
      value: Number(record.createdAt) * 1000,
    });
  }
  if (record.labelName) {
    attributes.push({ trait_type: "Length", value: record.labelName.length });
  }
  if (registration?.registrationDate) {
    attributes.push({
      trait_type: "Registration Date",
      display_type: "date",
      value: Number(registration.registrationDate) * 1000,
    });
  }
  if (registration?.expiryDate) {
    attributes.push({
      trait_type: "Expiration Date",
      display_type: "date",
      value: Number(registration.expiryDate) * 1000,
    });
  }

  const tokenHash =
    kind === "v1" && record.labelName
      ? keccak256(new TextEncoder().encode(record.labelName))
      : name
        ? namehash(name)
        : tokenHex;

  const origin = new URL(c.req.url).origin;
  const image = `${origin}/${networkName}/${contract}/${tokenIdRaw}/image`;
  const normalized = name ? isNormalized(name) : false;
  const backgroundImage = normalized
    ? `${origin}/${networkName}/avatar/${encodeURIComponent(name!)}`
    : null;

  c.header("cache-control", `public, max-age=${CACHE_API_MAX_AGE}`);
  return c.json(
    {
      is_normalized: normalized,
      name: name ?? "unknown.eth",
      description: name
        ? `${name}, an ENS name.`
        : "This domain name could not be resolved.",
      attributes,
      name_length: record.labelName?.length ?? null,
      url: name ? `https://app.ens.domains/name/${name}` : null,
      version: kind === "v1" ? 1 : 2,
      background_image: backgroundImage,
      image,
      image_url: image,
      token_hash: tokenHash,
    },
    200,
  );
});
