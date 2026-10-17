import { CFLoomPresence } from "./cf-loom-presence.ts";

if (!customElements.get("cf-loom-presence")) {
  customElements.define("cf-loom-presence", CFLoomPresence);
}

export type { CFLoomPresence as CFLoomPresenceElement } from "./cf-loom-presence.ts";
export {
  type PresentParticipant,
  presentParticipantsOf,
} from "./presence-roster.ts";

export { CFLoomPresence };
