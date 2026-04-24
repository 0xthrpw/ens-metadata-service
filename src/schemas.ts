import { z } from "@hono/zod-openapi";

export const NetworkParam = z
  .enum(["mainnet", "sepolia", "holesky"])
  .openapi({ param: { name: "network", in: "path" }, example: "mainnet" });

export const NameParam = z
  .string()
  .min(1)
  .openapi({ param: { name: "name", in: "path" }, example: "vitalik.eth" });

export const AddressParam = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/)
  .openapi({
    param: { name: "contract", in: "path" },
    example: "0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85",
  });

export const TokenIdParam = z
  .string()
  .min(1)
  .openapi({
    param: { name: "tokenId", in: "path" },
    example:
      "61995921128521442959106650131462633484209613104719629969216087274450637974528",
  });

export const ErrorSchema = z
  .object({
    error: z.string().openapi({ example: "not_found" }),
    message: z.string().openapi({ example: "domain not found" }),
  })
  .openapi("Error");

export const AvatarMetaSchema = z
  .object({
    name: z.string(),
    network: z.string(),
    uri: z.string(),
    kind: z.enum(["avatar", "header"]),
  })
  .openapi("AvatarMeta");

export const MetadataAttribute = z
  .object({
    trait_type: z.string(),
    display_type: z.string().optional(),
    value: z.union([z.string(), z.number()]),
  })
  .openapi("MetadataAttribute");

export type MetadataAttribute = z.infer<typeof MetadataAttribute>;

export const NFTMetadataSchema = z
  .object({
    is_normalized: z.boolean(),
    name: z.string(),
    description: z.string(),
    attributes: z.array(MetadataAttribute),
    name_length: z.number().nullable(),
    url: z.string().nullable(),
    version: z.number(),
    background_image: z.string().nullable(),
    image: z.string().nullable(),
    image_url: z.string().nullable(),
    token_hash: z.string(),
  })
  .openapi("NFTMetadata");

export type NFTMetadata = z.infer<typeof NFTMetadataSchema>;

export const QueryNFTSchema = z
  .object({
    name: z.string(),
    namehash: z.string(),
    contract: z.string(),
    tokenId: z.string(),
    owner: z.string().nullable(),
    registration: z
      .object({
        registrationDate: z.string(),
        expiryDate: z.string(),
      })
      .nullable(),
  })
  .openapi("QueryNFT");
