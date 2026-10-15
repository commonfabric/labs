/** Opens a space's own conversation and supplies the viewer's live profile. */
import {
  type Cell,
  computed,
  handler,
  lift,
  NAME,
  pattern,
  spaceAccess,
  UI,
  VIEWS,
  wish,
} from "commonfabric";
import FabriChatRoom, { type ChatRoomView } from "./room.tsx";
import type { SpaceChat, SpaceChatRoom } from "./space.ts";
import type { ChatProfile } from "./schemas.tsx";

/** Registers the space conversation once from its reviewed start control. */
const initializeRoom = handler<unknown, {
  space: Cell<SpaceChat | undefined>;
  available: boolean;
  candidate: Cell<SpaceChatRoom>;
}>((_, { space, available, candidate }) => {
  if (!available) return;
  const root = space.get();
  if (!root?.setChatRoom || root.chatRoom) return;
  const access = spaceAccess(candidate);
  if (access !== "WRITE" && access !== "OWNER") return;
  root.setChatRoom.send({ room: candidate });
});

/** Selects the registered room while retaining its reference identity. */
const selectRoom = lift(({
  space,
  candidate,
}: { space: Cell<SpaceChat | undefined>; candidate: Cell<SpaceChatRoom> }) => {
  return space.get()?.chatRoom ?? candidate;
});

/** A space conversation shares its enclosing space's membership. */
export default pattern(() => {
  const profile = wish<ChatProfile>({ query: "#profile" });
  const space = wish<SpaceChat>({ query: "#default" });
  // A stream schema supplies a handle even when the underlying field is
  // absent. The unbranded projection checks that the registry exists.
  const registry = wish<{ setChatRoom?: unknown }>({ query: "#default" });
  const candidate = FabriChatRoom({});
  const room = selectRoom({ space: space.result!, candidate });
  const ready = computed(() => space.result?.chatRoom !== undefined);
  const canCreate = computed(() => {
    const access = spaceAccess(room);
    return registry.result?.setChatRoom !== undefined &&
      (access === "WRITE" || access === "OWNER");
  });
  return {
    [NAME]: "FabriChat",
    [UI]: (
      <cf-screen>
        {ready ? <cf-render $cell={room} /> : (
          <cf-vstack padding="4" gap="3">
            <cf-heading level={2}>Space conversation</cf-heading>
            <cf-text>
              Everyone with access to this space can read its conversation.
            </cf-text>
            <div
              data-ui-pattern="ChatStartSurface"
              data-ui-event-integrity="ChatStartSurface"
            >
              <cf-button
                disabled={!canCreate}
                data-ui-action="ChatStart"
                onClick={initializeRoom({
                  space: space.result!,
                  available: canCreate,
                  candidate,
                })}
              >
                Start conversation
              </cf-button>
            </div>
          </cf-vstack>
        )}
        {profile.result === undefined
          ? <div id="fabrichat-profile-setup">{profile[UI]}</div>
          : null}
      </cf-screen>
    ),
    room,
    [VIEWS]: { room: computed<ChatRoomView>(() => room.get()[VIEWS].room) },
  };
});
