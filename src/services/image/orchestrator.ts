import type { Env } from "../../env";
import { classifyUri } from "../avatarResolver";
import { handleData } from "./data";
import { handleEip155 } from "./eip155";
import { handleHttps } from "./https";
import { handleIpfs } from "./ipfs";
import { handleIpns } from "./ipns";
import type { EnsContext, ImageResult } from "./types";

export async function fetchImageBytes(
  env: Env,
  uri: string,
  ctx: ExecutionContext,
  ensContext?: EnsContext,
): Promise<ImageResult> {
  const classified = classifyUri(uri);

  switch (classified.kind) {
    case "data":
      return handleData(uri);
    case "ipfs":
      return handleIpfs(env, uri, ctx);
    case "ipns":
      return handleIpns(env, uri);
    case "https":
      return handleHttps(env, classified.url, ctx);
    case "eip155":
      return handleEip155(env, classified, ctx, ensContext);
  }
}
