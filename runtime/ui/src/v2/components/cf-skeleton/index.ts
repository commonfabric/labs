import { CFSkeleton, SkeletonVariant } from "./cf-skeleton.ts";

if (!customElements.get("cf-skeleton")) {
  customElements.define("cf-skeleton", CFSkeleton);
}

export type { CFSkeleton as CFSkeletonElement } from "./cf-skeleton.ts";

export { CFSkeleton };
export type { SkeletonVariant };
