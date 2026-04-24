// Tags we set on every cacheable response so the indexer can invalidate by
// `{name}` or `{contract, tokenHex}` without knowing the concrete URLs.
//
// Values are percent-encoded to stay inside Cache-Tag's printable-ASCII
// constraint (emoji / non-ASCII labels otherwise break the header).
// Tags are case-insensitive at Cloudflare's edge, so we lowercase everything
// to keep set operations in this codebase predictable.
//
// NOTE: Cache-Tag is a zone-level feature. On `*.workers.dev` the responses
// are still cached at the edge but not under a zone you own, so tag-purge
// has no effect there. The tags are still emitted — they just become no-ops.

export function nameTag(network: string, name: string): string {
  return `ens:${network.toLowerCase()}:name:${encodeURIComponent(name.toLowerCase())}`;
}

export function tokenTag(
  network: string,
  contract: string,
  tokenHex: string,
): string {
  return `ens:${network.toLowerCase()}:token:${contract.toLowerCase()}:${tokenHex.toLowerCase()}`;
}

/**
 * Join multiple tags into a single `Cache-Tag` header value. Cloudflare
 * treats comma-separated values and repeated headers equivalently; this
 * returns the single-header form.
 */
export function cacheTagHeader(...tags: (string | undefined | null)[]): string {
  return tags.filter((t): t is string => typeof t === "string" && t.length > 0).join(",");
}
