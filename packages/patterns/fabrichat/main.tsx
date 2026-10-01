/** Opens a space's own conversation and supplies the viewer's live profile. */
import {
  type AuthoredByCurrentUser,
  type Cell,
  computed,
  FabricEpochNsec,
  handler,
  lift,
  NAME,
  pattern,
  spaceAccess,
  type TrustedActionWrite,
  UI,
  VIEWS,
  wish,
  Writable,
} from "commonfabric";
import { FabriChatRoom, type StoredMemory } from "./room.tsx";
import type { SpaceChat, SpaceChatRoom } from "./space.ts";
import { CHAT_POLICY } from "./records.ts";
import type {
  ChatProfile,
  ChatRoomAbout,
  ChatRoomFacts,
  ChatRoomPolicy,
} from "./schemas.ts";

/** Immutable creation records admitted by the space conversation's start control. */
type Created<T> = AuthoredByCurrentUser<
  TrustedActionWrite<
    T,
    typeof initializeRoom,
    "ChatStart",
    "ChatStartSurface"
  >
>;

/** Creates the space conversation once, recording its creator and policy together. */
const initializeRoom = handler<unknown, {
  space: Writable<SpaceChat | undefined>;
  candidate: Cell<SpaceChatRoom>;
  about: Writable<ChatRoomAbout>;
  policy: Writable<ChatRoomPolicy>;
}>((_, { space, candidate, about, policy }) => {
  if (space.get()?.chat || about.get()) return;
  const access = spaceAccess(about);
  if (access !== "WRITE" && access !== "OWNER") return;
  policy.set(CHAT_POLICY);
  about.set({
    kind: "group",
    createdAt: new FabricEpochNsec(BigInt(Date.now()) * 1_000_000n),
    policy,
  });
  space.key("chat").set(candidate);
});

/** Selects the registered room while retaining its reference identity. */
const selectRoom = lift(({
  space,
  candidate,
}: { space: Cell<SpaceChat | undefined>; candidate: Cell<SpaceChatRoom> }) => {
  return space.get()?.chat ?? candidate;
});

/** A space conversation shares its enclosing space's membership. */
export default pattern(() => {
  const about = new Writable<Created<ChatRoomAbout>>();
  const policy = new Writable<Created<ChatRoomPolicy>>();
  const memory = new Writable<StoredMemory>({
    requests: {},
    authors: {},
    usedTimes: {},
    nextSeq: 1,
    expiredThrough: 0,
  });
  const profile = wish<ChatProfile>({ query: "#profile" });
  const space = wish<Writable<SpaceChat>>({ query: "/" });
  const candidate = FabriChatRoom({ about, memory, myProfile: profile.result });
  const room = selectRoom({ space: space.result!, candidate });
  const ready = computed(() => space.result?.get()?.chat !== undefined);
  const canCreate = computed(() => {
    const access = spaceAccess(about);
    return access === "WRITE" || access === "OWNER";
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
                  candidate,
                  about,
                  policy,
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
    [VIEWS]: { room: computed<ChatRoomFacts>(() => room.get()[VIEWS].room) },
  };
});
