import { CFEmptyState } from "./cf-empty-state.ts";

if (!customElements.get("cf-empty-state")) {
  customElements.define("cf-empty-state", CFEmptyState);
}

export type { CFEmptyState as CFEmptyStateElement } from "./cf-empty-state.ts";

export { CFEmptyState };
