/** The system space record's link to its single conversation. */

import type { Cell, UI, VNode } from "commonfabric";
import type { ChatRoomOutput } from "./schemas.ts";

/** A room reference retains both its protocol and reviewed rendering. */
export type SpaceChatRoom = ChatRoomOutput & { [UI]: VNode };

/** The chat field of the system space record resolved by the `/` wish. */
export interface SpaceChat {
  chat?: Cell<SpaceChatRoom>;
}
