// This module was split into per-scheme handlers and shared helpers under
// `./image/`. It is kept as a re-export shim so existing `services/image`
// imports keep working and the import path stays stable across upstream merges.
//
// UPSTREAM MERGE NOTE: a patch that targets this path must be re-applied to the
// matching module under `./image/`:
//   - scheme handlers:  data.ts, ipfs.ts, ipns.ts, https.ts, eip155.ts
//   - orchestration:    orchestrator.ts (fetchImageBytes), resolveUri.ts
//   - shared helpers:   stream.ts, size.ts, sanitizeBytes.ts, types.ts
export * from "./image/index";
