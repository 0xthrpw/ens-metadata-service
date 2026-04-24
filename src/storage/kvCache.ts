import type { Env } from "../env";
import type { AvatarKind } from "../services/avatarResolver";
import { RESOLVER_TTL_SECONDS, STALE_RESOLVER_TTL_SECONDS } from "../constants";

type Entry = { uri: string; fetchedAt: number };

export type ResolvedEntry = { uri: string; fresh: boolean };

function key(kind: AvatarKind, network: string, name: string): string {
  return `${kind}:${network}:${name.toLowerCase()}`;
}

const FRESH_MS = RESOLVER_TTL_SECONDS * 1000;

function parseEntry(raw: string): Entry | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as Entry).uri === "string" &&
      typeof (parsed as Entry).fetchedAt === "number"
    ) {
      return parsed as Entry;
    }
  } catch {
    // fall through
  }
  return null;
}

export async function getResolved(
  env: Env,
  kind: AvatarKind,
  network: string,
  name: string,
): Promise<ResolvedEntry | null> {
  const raw = await env.RESOLVER_CACHE.get(key(kind, network, name));
  if (!raw) return null;
  const entry = parseEntry(raw);
  if (!entry) return { uri: raw, fresh: true };
  return { uri: entry.uri, fresh: Date.now() - entry.fetchedAt < FRESH_MS };
}

export async function putResolved(
  env: Env,
  kind: AvatarKind,
  network: string,
  name: string,
  uri: string,
): Promise<void> {
  const entry: Entry = { uri, fetchedAt: Date.now() };
  await env.RESOLVER_CACHE.put(key(kind, network, name), JSON.stringify(entry), {
    expirationTtl: STALE_RESOLVER_TTL_SECONDS,
  });
}

export async function deleteResolved(
  env: Env,
  kind: AvatarKind,
  network: string,
  name: string,
): Promise<void> {
  await env.RESOLVER_CACHE.delete(key(kind, network, name));
}
