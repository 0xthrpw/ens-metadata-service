import type { Env } from "../env";
import { upstream } from "../lib/errors";
import { IPFS_GATEWAY_TIMEOUT_MS } from "../constants";

export type IpfsRef = {
  cid: string;
  path: string;
};

const CID_RE = /^(?:ipfs:\/\/)?(?:ipfs\/)?((?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[A-Za-z2-7]{58,}))(\/.+)?$/;

export function parseIpfs(uri: string): IpfsRef | null {
  const m = uri.match(CID_RE);
  if (!m) return null;
  return { cid: m[1]!, path: m[2] ?? "" };
}

function gateways(env: Env): string[] {
  return env.IPFS_GATEWAYS.split(",")
    .map((g) => g.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

export async function fetchIpfs(env: Env, ref: IpfsRef): Promise<Response> {
  const list = gateways(env);
  if (list.length === 0) throw upstream("no IPFS gateways configured");

  const controllers = list.map(() => new AbortController());
  const attempts = list.map(async (gw, i) => {
    const url = `${gw}/ipfs/${ref.cid}${ref.path}`;
    const ctrl = controllers[i]!;
    const headerTimeout = setTimeout(() => ctrl.abort(), IPFS_GATEWAY_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        cf: { cacheTtl: 3600, cacheEverything: true },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`${gw} → ${res.status}`);
      return { res, index: i };
    } finally {
      clearTimeout(headerTimeout);
    }
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
    throw upstream(`all IPFS gateways failed: ${errs}`, e);
  }

  for (let i = 0; i < controllers.length; i++) {
    if (i !== winner.index) controllers[i]!.abort();
  }
  return winner.res;
}
