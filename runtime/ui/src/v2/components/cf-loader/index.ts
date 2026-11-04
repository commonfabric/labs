import { CFLoader, LoaderSize } from "./cf-loader.ts";

if (!customElements.get("cf-loader")) {
  customElements.define("cf-loader", CFLoader);
}

export type { CFLoader as CFLoaderElement } from "./cf-loader.ts";

export { CFLoader };
export type { LoaderSize };
