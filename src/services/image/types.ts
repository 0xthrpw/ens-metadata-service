import type { NetworkConfig } from "../../lib/networks";

// Context the eip155 (NFT) image path needs to look up the wallet that
// "owns" the avatar — i.e. the address the ENS name resolves to. Other URI
// schemes ignore this entirely.
export type EnsContext = {
  network: NetworkConfig;
  name: string;
};

export type ImageResult = {
  body: ReadableStream<Uint8Array> | ArrayBuffer;
  contentType: string;
  etag?: string;
};
