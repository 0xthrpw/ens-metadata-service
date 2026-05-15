import type { Env } from "../env";
import { upstream } from "../lib/errors";
import { log } from "../lib/log";
import { IPFS_GATEWAY_TIMEOUT_MS } from "../constants";

export type IpfsRef = {
  cid: string;
  path: string;
};

export type IpnsRef = {
  target: string;
  path: string;
};

const CID_RE = /^((?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[A-Za-z2-7]{58,}))(\/.+)?$/;
const IPFS_PREFIX_RE = /^(?:(?:ipfs:\/\/)|(?:ipfs\/))+/i;
const IPNS_RE = /^(?:ipns:\/\/|ipns\/)([^/]+)(\/.*)?$/i;

export function parseIpfs(uri: string): IpfsRef | null {
  const m = uri.replace(IPFS_PREFIX_RE, "").match(CID_RE);
  if (!m) return null;
  return { cid: m[1]!, path: m[2] ?? "" };
}

export function parseIpns(uri: string): IpnsRef | null {
  const m = uri.match(IPNS_RE);
  if (!m) return null;
  return { target: m[1]!, path: m[2] ?? "" };
}

function gateways(env: Env): string[] {
  return env.IPFS_GATEWAYS.split(",")
    .map((g) => g.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

async function fetchFromGateways(
  env: Env,
  pathForGateway: (gateway: string) => string,
  label: string,
  cacheTtlSeconds?: number,
): Promise<Response> {
  const list = gateways(env);
  if (list.length === 0) throw upstream("no IPFS gateways configured");

  const controllers = list.map(() => new AbortController());
  const attempts = list.map(async (gw, i) => {
    const url = pathForGateway(gw);
    const ctrl = controllers[i]!;
    const signal = AbortSignal.any([
      ctrl.signal,
      AbortSignal.timeout(IPFS_GATEWAY_TIMEOUT_MS),
    ]);
    const init = cacheTtlSeconds === undefined
      ? { signal }
      : {
          cf: { cacheTtl: cacheTtlSeconds, cacheEverything: true },
          signal,
        };
    const res = await fetch(url, {
      ...init,
    });
    if (!res.ok) throw new Error(`${gw} -> ${res.status}`);
    return { res, index: i };
  });

  let winner: { res: Response; index: number };
  try {
    winner = await Promise.any(attempts);
  } catch (e) {
    const errs =
      e instanceof AggregateError
        ? e.errors.map((x) => (x instanceof Error ? x.message : String(x))).join("; ")
        : e instanceof Error
          ? e.message
          : String(e);
    log.error("ipfs_all_gateways_failed", {
      label,
      attempts: list.length,
      errors: errs,
    });
    throw upstream(`all ${label} gateways failed: ${errs}`, e);
  }

  log.debug("ipfs_gateway_win", {
    label,
    gatewayIndex: winner.index,
    attempts: list.length,
  });
  for (let i = 0; i < controllers.length; i++) {
    if (i !== winner.index) controllers[i]!.abort();
  }
  return winner.res;
}

export async function fetchIpfs(env: Env, ref: IpfsRef): Promise<Response> {
  return fetchFromGateways(
    env,
    (gw) => `${gw}/ipfs/${ref.cid}${ref.path}`,
    "IPFS",
    3600,
  );
}

export async function fetchIpns(env: Env, ref: IpnsRef): Promise<Response> {
  return fetchFromGateways(
    env,
    (gw) => `${gw}/ipns/${ref.target}${ref.path}`,
    "IPNS",
  );
}
