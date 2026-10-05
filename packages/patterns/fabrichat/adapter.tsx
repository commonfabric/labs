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
  /**
   * The placed room's title, for lists of pieces: `"Chat"` for a room with no
   * title, and `"Chat (unavailable)"` for a room the viewer can't read.
   */
  [NAME]: string;

  /** The room's own rendering, or why there is none. */
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
    // Whether the viewer can read the room differs by viewer, so both parts
    // are always rendered and one is hidden by a prop: a tree built
    // differently per viewer is stored once for everyone, and runtimes that
    // built it differently overwrite each other without end. Each part is
    // `hidden` until its display has a value, as `FabriChatMessageRow` says.
    const roomDisplay = computed(() => (isMember ? "block" : "none"));
    const unavailableDisplay = computed(() => (isMember ? "none" : "block"));

    return {
      [NAME]: computed(() =>
        isMember ? chat.about?.title ?? "Chat" : "Chat (unavailable)"
      ),
      [UI]: (
        <cf-vstack>
          <div
            id="fabrichat-adapter-room"
            hidden
            style={{ display: roomDisplay }}
          >
            <cf-render $cell={placement.room} />
          </div>
          <div
            id="fabrichat-adapter-unavailable"
            hidden
            style={{ display: unavailableDisplay }}
          >
            <cf-empty-state message="This chat can't be read right now." />
          </div>
        </cf-vstack>
      ),
      placement,
      [VIEWS]: { chat },
    };
  },
);

export default FabriChatAdapter;
