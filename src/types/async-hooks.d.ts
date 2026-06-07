// Minimal type for the Workers `node:async_hooks` AsyncLocalStorage (enabled
// at runtime via the `nodejs_compat` flag). Declared locally so we keep
// `types: ["@cloudflare/workers-types"]` and avoid pulling in @types/node,
// which would add conflicting Node globals. Only the surface we use.
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, callback: () => R): R;
    getStore(): T | undefined;
    enterWith(store: T): void;
    disable(): void;
  }
}
