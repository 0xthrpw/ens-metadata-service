// Filesystem-backed stand-in for the R2Bucket binding, covering exactly the
// surface src/storage/r2Cache.ts uses: get / put / head / list({prefix}) /
// delete. Objects live under DATA_DIR as `<key>.bin` plus a `<key>.meta.json`
// sidecar holding contentType + customMetadata; the .bin suffix keeps R2's
// "both `a` and `a/b` are valid keys" property representable on a filesystem.
//
// Keys are mapped to paths segment-by-segment with a collision-free encoding
// (encodeURIComponent, plus escapes for "", "." and ".." — outputs
// encodeURIComponent can never produce). Keys whose encoded segments exceed
// filesystem limits are treated as uncacheable: get/head miss, put/delete
// no-op. That can only make the cache colder, never wrong.
import { promises as fs } from "node:fs";
import * as path from "node:path";

type Meta = {
  contentType?: string;
  customMetadata?: Record<string, string>;
};

type PutOptions = {
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
};

const MAX_ENCODED_SEGMENT = 240; // filesystem limit is 255 bytes; leave room for ".meta.json"
const MAX_KEY_LENGTH = 1024; // R2's own key-length cap
const LIST_LIMIT = 1000; // R2 list() page size

function encodeSegment(seg: string): string {
  if (seg === "") return "%";
  if (seg === ".") return "%2E";
  if (seg === "..") return "%2E%2E";
  return encodeURIComponent(seg);
}

function decodeSegment(seg: string): string {
  if (seg === "%") return "";
  if (seg === "%2E") return ".";
  if (seg === "%2E%2E") return "..";
  return decodeURIComponent(seg);
}

/** Encoded relative path for a key, or null when the key is unrepresentable. */
function keyToRelPath(key: string): string | null {
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) return null;
  const segments = key.split("/").map(encodeSegment);
  if (segments.some((s) => s.length > MAX_ENCODED_SEGMENT)) return null;
  return segments.join("/");
}

function relPathToKey(rel: string): string {
  return rel.split(path.sep).map(decodeSegment).join("/");
}

let tmpCounter = 0;

async function atomicWrite(file: string, data: Uint8Array | string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${tmpCounter++}`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

async function readIfExists(file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export class FsR2Bucket {
  #root: string;

  constructor(root: string) {
    this.#root = path.resolve(root);
  }

  #paths(key: string): { bin: string; meta: string } | null {
    const rel = keyToRelPath(key);
    if (rel === null) return null;
    const bin = path.join(this.#root, `${rel}.bin`);
    // Encoding removes every "." segment, but keep a containment check as
    // defense in depth — a bug here would write outside the data dir.
    if (!bin.startsWith(this.#root + path.sep)) return null;
    return { bin, meta: path.join(this.#root, `${rel}.meta.json`) };
  }

  async get(key: string): Promise<unknown> {
    const p = this.#paths(key);
    if (!p) return null;
    const [bytes, metaRaw] = await Promise.all([
      readIfExists(p.bin),
      readIfExists(p.meta),
    ]);
    if (bytes === null || metaRaw === null) return null;
    let meta: Meta = {};
    try {
      meta = JSON.parse(metaRaw.toString("utf8")) as Meta;
    } catch {
      return null; // torn/corrupt sidecar — treat as a miss
    }
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return {
      key,
      httpMetadata: { contentType: meta.contentType },
      customMetadata: meta.customMetadata ?? {},
      arrayBuffer: async () => buf,
    };
  }

  async head(key: string): Promise<unknown> {
    const p = this.#paths(key);
    if (!p) return null;
    const metaRaw = await readIfExists(p.meta);
    if (metaRaw === null) return null;
    let meta: Meta = {};
    try {
      meta = JSON.parse(metaRaw.toString("utf8")) as Meta;
    } catch {
      return null;
    }
    return {
      key,
      httpMetadata: { contentType: meta.contentType },
      customMetadata: meta.customMetadata ?? {},
    };
  }

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView,
    options?: PutOptions,
  ): Promise<void> {
    const p = this.#paths(key);
    if (!p) return; // unrepresentable key — skip caching
    const bytes =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const meta: Meta = {
      contentType: options?.httpMetadata?.contentType,
      customMetadata: options?.customMetadata,
    };
    await fs.mkdir(path.dirname(p.bin), { recursive: true });
    // Bytes land before the sidecar; get() requires both, so a crash between
    // the two renames reads as a miss, never as mismatched data.
    await atomicWrite(p.bin, bytes);
    await atomicWrite(p.meta, JSON.stringify(meta));
  }

  async delete(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    await Promise.all(
      list.map(async (key) => {
        const p = this.#paths(key);
        if (!p) return;
        await Promise.all([
          fs.rm(p.meta, { force: true }),
          fs.rm(p.bin, { force: true }),
        ]);
      }),
    );
  }

  async list(options?: { prefix?: string }): Promise<{
    objects: Array<{ key: string }>;
    truncated: boolean;
  }> {
    const prefix = options?.prefix ?? "";
    // Walk from the deepest directory the prefix fully determines.
    const lastSlash = prefix.lastIndexOf("/");
    const dirKey = lastSlash === -1 ? "" : prefix.slice(0, lastSlash);
    const relDir = dirKey === "" ? "" : keyToRelPath(dirKey);
    if (relDir === null) return { objects: [], truncated: false };
    const walkRoot = path.join(this.#root, relDir);

    const objects: Array<{ key: string }> = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
      }
      for (const entry of entries) {
        if (objects.length >= LIST_LIMIT) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile() && entry.name.endsWith(".bin")) {
          const rel = path.relative(this.#root, full).slice(0, -".bin".length);
          const key = relPathToKey(rel);
          if (key.startsWith(prefix)) objects.push({ key });
        }
      }
    };
    await walk(walkRoot);
    return { objects, truncated: objects.length >= LIST_LIMIT };
  }
}
