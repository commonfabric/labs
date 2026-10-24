/** A social space's room, bound to a viewer's private Home catalog. */
import { type Cell, handler, pattern } from "commonfabric";
import {
  type ChatRoomOutput,
  FabriChatRoomCore,
  type FabriChatRoomInput,
  type OfferRoomRequest,
} from "../../../fabrichat/room.tsx";
import type { ChatProfile } from "../../../fabrichat/schemas.tsx";
import type { SharedSpaceCatalogStorage } from "../../../system/shared-space-catalog.ts";

/** The room's records and the viewer's Home bindings. */
interface Input extends FabriChatRoomInput {
  /** The viewer's public profile. */
  profile: Cell<ChatProfile>;

  /** The catalog supplied by the viewer's private Home. */
  catalog: SharedSpaceCatalogStorage;
}

/** An offer endpoint for a manager whose only test role is its catalog. */
const offer = handler<OfferRoomRequest, Record<PropertyKey, never>>(() => {});

export default pattern<Input, ChatRoomOutput>((input) => {
  const manager = {
    offerRoom: offer({}),
    requests: {},
    people: {},
    // The producer carries private data outside the room's narrow manager
    // contract. Keeping it here tests that room writes never load that data.
    sharedSpaceCatalog: input.catalog,
  };
  return FabriChatRoomCore({
    myProfile: input.profile,
    messages: input.messages,
    roster: input.participants,
    manager,
  });
});
