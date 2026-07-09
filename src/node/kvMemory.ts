// In-memory stand-in for the KVNamespace binding, covering the surface
// src/storage/kvCache.ts uses: get / put({expirationTtl}) / delete. Entries
// are small JSON strings with a 15-minute freshness window and a bounded
// stale TTL, so process-local storage is sufficient — a restart just means a
// cold resolver cache, which every caller already tolerates.
const SWEEP_INTERVAL_MS = 60_000;
const MAX_ENTRIES = 100_000; // ~tens of MB worst case; evicts oldest-inserted first

type Entry = { value: string; expiresAt: number | null };

export class MemoryKV {
  #store = new Map<string, Entry>();
  #sweeper: NodeJS.Timeout;

  constructor() {
    this.#sweeper = setInterval(() => this.#sweep(), SWEEP_INTERVAL_MS);
    this.#sweeper.unref();
  }

  #sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.#store) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) this.#store.delete(key);
    }
  }

  async get(key: string): Promise<string | null> {
    const entry = this.#store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.#store.delete(key);
      return null;
    }
    return entry.value;
  }

  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void> {
    if (this.#store.size >= MAX_ENTRIES && !this.#store.has(key)) {
      const oldest = this.#store.keys().next();
      if (!oldest.done) this.#store.delete(oldest.value);
    }
    const ttl = options?.expirationTtl;
    this.#store.set(key, {
      value,
      expiresAt: ttl !== undefined ? Date.now() + ttl * 1000 : null,
    });
  }

  async delete(key: string): Promise<void> {
    this.#store.delete(key);
  }
}
