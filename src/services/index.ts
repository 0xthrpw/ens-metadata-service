// Additive convenience barrel for the service layer. New code may import from
// `../services`; existing deep imports (`../services/<name>`) are intentionally
// left untouched to keep upstream-merge churn low.
//
// Heavy/WASM modules (rasterize, nameImage, emojiInline, fontLoader) are
// deliberately excluded so importing the barrel doesn't pull the resvg-wasm /
// font bundles into light consumers.
export * from "./image";
export * from "./ipfs";
export * from "./sanitize";
export * from "./avatarResolver";
export * from "./domain";
export * from "./ens";
export * from "./subgraph";
export * from "./nftAvatar";
