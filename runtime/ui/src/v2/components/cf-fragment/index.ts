import { CFFragment } from "./cf-fragment.ts";

if (!customElements.get("cf-fragment")) {
  customElements.define("cf-fragment", CFFragment);
}

export type { CFFragment as CFFragmentElement } from "./cf-fragment.ts";

export * from "./cf-fragment.ts";
