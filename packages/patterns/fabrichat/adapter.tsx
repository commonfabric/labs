/**
 * `FabriChatAdapter`: renders one placement for hosts that render VDOM
 * (`docs/specs/fabrichat/FabriChatAdapter.md`). A container holds the adapter,
 * which links to its placement, which links to its room.
 *
 * When the viewer can read the room, the adapter embeds the room's own
 * `[UI]`, composer and all, so every gesture is made on the room's own
 * reviewed surfaces. It re-exports the placement's `chat` group, so a host
 * drawing a container's pieces natively finds it on the piece it holds.
 */
import {
  type Cell,
  computed,
  NAME,
  pattern,
  UI,
  VIEWS,
  type VNode,
} from "commonfabric";
import { type FabriChatPlacementView, type PlacedRoom } from "./placement.tsx";

/** A placement as an adapter reads it through its link. */
export interface AdaptedPlacement {
  /** The placed room. */
  room: Cell<PlacedRoom>;

  /** The placement's data face. */
  [VIEWS]: { chat: FabriChatPlacementView };
}

/** What an adapter holds. */
export interface FabriChatAdapterInput {
  /** The placement, set when the adapter is created. */
  placement: AdaptedPlacement;
}

/** What an adapter offers. */
export interface FabriChatAdapterOutput {
  [NAME]: string;
  [UI]: VNode;

  /** The placement. */
  placement: AdaptedPlacement;

  /** The placement's data face, re-exported by link. */
  [VIEWS]: { chat: FabriChatPlacementView };
}

/** A placed chat, rendered: the room's own rendering, or why there is none. */
const FabriChatAdapter = pattern<FabriChatAdapterInput, FabriChatAdapterOutput>(
  ({ placement }) => {
    const chat = placement[VIEWS].chat;
    const isMember = computed(() => chat.state === "member");

    return {
      [NAME]: computed(() =>
        isMember ? chat.about?.title ?? "Chat" : "Chat (unavailable)"
      ),
      [UI]: (
        <cf-vstack>
          {isMember
            ? <cf-render $cell={placement.room} />
            : <cf-empty-state message="This chat can't be read right now." />}
        </cf-vstack>
      ),
      placement,
      [VIEWS]: { chat },
    };
  },
);

export default FabriChatAdapter;
