/**
 * Defines the policy shared by room writers and the room's published facts.
 */

import { FabricDurationNsec } from "commonfabric";
import type { ChatRoomPolicy } from "./schemas.tsx";

/** The policy used by writers and the published policy cell. */
export const CHAT_POLICY: ChatRoomPolicy = {
  ownersMayObliterate: true,
  keepsHistory: true,
  deletionIsObliteration: false,
  proposedTimeMaxAgeNsec: new FabricDurationNsec(600_000_000_000n),
  proposedTimeMaxLeadNsec: new FabricDurationNsec(10_000_000_000n),
  recentActivityWindowNsec: new FabricDurationNsec(600_000_000_000n),
  maxWindowCount: 100,
  maxOpenWindows: 50,
};
