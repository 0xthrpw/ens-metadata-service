import type { Env } from "../../env";
import { getNetwork } from "../../lib/networks";
import { badRequest, HttpError } from "../../lib/errors";
import { resolveRecord, type AvatarKind } from "../avatarResolver";
import { deleteResolved, getResolved, putResolved } from "../../storage/kvCache";
import { log } from "../../lib/log";

export async function resolveUriCached(
  env: Env,
  kind: AvatarKind,
  networkName: string,
  name: string,
  ctx: ExecutionContext,
): Promise<string> {
  const cached = await getResolved(env, kind, networkName, name);
  if (cached?.fresh) {
    log.debug("kv_resolver_hit", { kind, network: networkName, name });
    return cached.uri;
  }

  const network = getNetwork(env, networkName);
  if (!network) throw badRequest(`unknown network: ${networkName}`);

  if (cached) {
    log.debug("kv_resolver_stale", { kind, network: networkName, name });
    ctx.waitUntil(
      (async () => {
        try {
          const uri = await resolveRecord(network, kind, name);
          await putResolved(env, kind, networkName, name, uri);
        } catch (err) {
          if (err instanceof HttpError && err.status === 404) {
            await deleteResolved(env, kind, networkName, name);
            return;
          }
          log.warn("stale_revalidation_failed", {
            kind,
            network: networkName,
            name,
            err,
          });
        }
      })(),
    );
    return cached.uri;
  }

  log.debug("kv_resolver_miss", { kind, network: networkName, name });
  const uri = await resolveRecord(network, kind, name);
  ctx.waitUntil(putResolved(env, kind, networkName, name, uri));
  return uri;
}
