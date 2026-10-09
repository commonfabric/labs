/** The Loom root's link to its space conversation. */

import type { Cell, Stream, UI, VNode } from "commonfabric";
import type { ChatRoomOutput } from "./schemas.tsx";

/** A room reference retains both its protocol and reviewed rendering. */
export type SpaceChatRoom = ChatRoomOutput & { [UI]: VNode };

/** The room registry offered by the Loom root resolved by the `#default` wish. */
export interface SpaceChat {
  /** The conversation registered in the root's own space. */
  chatRoom?: Cell<SpaceChatRoom>;

  /** Registers the conversation through the root's own writer. */
  setChatRoom?: Stream<{ room: Cell<SpaceChatRoom> }>;
}
