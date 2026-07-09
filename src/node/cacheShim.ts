// In-process stand-in for the Workers Cache API (`caches.default`), covering
// the surface the routes use: match(request) / put(request, response). On
// Workers this is a per-colo edge cache in front of KV + R2; here it's a
// small in-memory LRU with the same role — losing it entirely would still be
// correct, just slower, so the implementation stays deliberately simple.
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_ENTRIES = 2_000;

type Entry = {
  status: number;
  headers: Array<[string, string]>;
  body: Uint8Array;
  expiresAt: number;
};

function maxAgeSeconds(response: Response): number | null {
  const cc = response.headers.get("cache-control") ?? "";
  if (/(?:^|,)\s*(?:no-store|private)\s*(?:,|$)/i.test(cc)) return null;
  const m = /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(cc);
  if (!m) return null;
  const seconds = Number(m[1]);
  return seconds > 0 ? seconds : null;
}

export class MemoryResponseCache {
  #entries = new Map<string, Entry>();
  #totalBytes = 0;

  async match(request: Request): Promise<Response | undefined> {
    if (request.method !== "GET") return undefined;
    const entry = this.#entries.get(request.url);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.#delete(request.url, entry);
      return undefined;
    }
    // Refresh recency (Map iteration order doubles as the LRU order).
    this.#entries.delete(request.url);
    this.#entries.set(request.url, entry);
    return new Response(entry.body.slice(), {
      status: entry.status,
      headers: entry.headers,
    });
  }

  async put(request: Request, response: Response): Promise<void> {
    if (request.method !== "GET") return;
    const seconds = maxAgeSeconds(response);
    if (seconds === null) return;
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > MAX_TOTAL_BYTES / 4) return; // never let one object dominate
    const previous = this.#entries.get(request.url);
    if (previous) this.#delete(request.url, previous);
    const entry: Entry = {
      status: response.status,
      headers: [...response.headers],
      body,
      expiresAt: Date.now() + seconds * 1000,
    };
    this.#entries.set(request.url, entry);
    this.#totalBytes += body.byteLength;
    this.#evict();
  }

  #delete(url: string, entry: Entry): void {
    this.#entries.delete(url);
    this.#totalBytes -= entry.body.byteLength;
  }

  #evict(): void {
    for (const [url, entry] of this.#entries) {
      if (this.#totalBytes <= MAX_TOTAL_BYTES && this.#entries.size <= MAX_ENTRIES) return;
      this.#delete(url, entry);
    }
  }
}

export function installCaches(): void {
  if (!("caches" in globalThis)) {
    const shared = new MemoryResponseCache();
    (globalThis as Record<string, unknown>).caches = {
      default: shared,
      open: async () => shared,
    };
  }
}
