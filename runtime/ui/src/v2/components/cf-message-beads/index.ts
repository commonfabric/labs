import { CFMessageBeads } from "./cf-message-beads.ts";

if (!customElements.get("cf-message-beads")) {
  customElements.define("cf-message-beads", CFMessageBeads);
}

export type { CFMessageBeads as CFMessageBeadsElement } from "./cf-message-beads.ts";

export { CFMessageBeads } from "./cf-message-beads.ts";
