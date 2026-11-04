import { CFAspectRatio } from "./cf-aspect-ratio.ts";

import { aspectRatioStyles } from "./styles.ts";

if (!customElements.get("cf-aspect-ratio")) {
  customElements.define("cf-aspect-ratio", CFAspectRatio);
}

export type { CFAspectRatio as CFAspectRatioElement } from "./cf-aspect-ratio.ts";

export { CFAspectRatio };
export { aspectRatioStyles };
