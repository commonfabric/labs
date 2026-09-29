/**
 * Embeds a placement's room rendering and re-exports its data face by link.
 * The room owns every reviewed writer surface and all composer state.
 */

import {
  type Cell,
  computed,
  NAME,
  pattern,
  type PerSpace,
  UI,
  VIEWS,
  type VNode,
} from "commonfabric";
import type { ChatPlacementOutput, ChatPlacementView } from "./placement.tsx";

/** A container's rendering adapter for one placement. */
export interface ChatAdapterOutput {
  [NAME]: string;
  placement: PerSpace<Cell<ChatPlacementOutput>>;
  [UI]: VNode;
  [VIEWS]: { chat: Cell<ChatPlacementView> };
}

/** Renders the room's own UI when the reader can reach it. */
export const FabriChatAdapter = pattern<
  { placement: PerSpace<Cell<ChatPlacementOutput>> },
  ChatAdapterOutput
>(({ placement }) => {
  const chat = placement.key(VIEWS).key("chat");
  const state = computed(() => chat.key("state").get());
  return {
    [NAME]: "FabriChat",
    placement,
    [UI]: (
      <cf-screen>
        {state === "member"
          ? <cf-render $cell={placement.key("room")} />
          : (
            <cf-empty-state
              message={state === "not-member"
                ? "You are not a member of this conversation."
                : "Conversation unavailable."}
            />
          )}
      </cf-screen>
    ),
    [VIEWS]: { chat },
  };
});

export default FabriChatAdapter;
