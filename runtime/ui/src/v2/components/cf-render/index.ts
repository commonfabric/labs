import { CFRender } from "./cf-render.ts";

if (!customElements.get("cf-render")) {
  customElements.define("cf-render", CFRender);
}

export type { CFRender as CFRenderElement } from "./cf-render.ts";
export { hasVariantValue, normalizeVariant } from "./cf-render.ts";

export * from "./cf-render.ts";
