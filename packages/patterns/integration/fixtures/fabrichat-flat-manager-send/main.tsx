/** Exercises a room's flat command and observation bindings from Home. */

import { type Cell, pattern } from "commonfabric";
import {
  type ChatRoomOutput,
  FabriChatRoomCore,
  type FabriChatRoomInput,
  type RoomManager,
} from "../../../fabrichat/room.tsx";
import type { ChatProfile } from "../../../fabrichat/schemas.tsx";

interface Input extends FabriChatRoomInput {
  profile: Cell<ChatProfile>;
  manager: RoomManager;
}

export default pattern<Input, ChatRoomOutput>((input) =>
  FabriChatRoomCore({
    myProfile: input.profile,
    messages: input.messages,
    roster: input.participants,
    manager: input.manager,
  })
);
