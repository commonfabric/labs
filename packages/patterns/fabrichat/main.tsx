/** Opens a space's own conversation and supplies the viewer's live profile. */
import {
  type AuthoredByCurrentUser,
  computed,
  currentPrincipal,
  FabricEpochNsec,
  handler,
  NAME,
  pattern,
  spaceAccess,
  spaceMembers,
  type TrustedActionWrite,
  UI,
  VIEWS,
  wish,
  Writable,
} from "commonfabric";
import { FabriChatRoom, type StoredMemory } from "./room.tsx";
import { CHAT_POLICY } from "./records.ts";
import type { ChatProfile, ChatRoomAbout, ChatRoomPolicy } from "./schemas.ts";

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
  about: Writable<ChatRoomAbout>;
  policy: Writable<ChatRoomPolicy>;
}>((_, { about, policy }) => {
  if (about.get()) return;
  const actor = currentPrincipal();
  const acl = spaceMembers();
  const access = actor ? acl?.[actor] ?? acl?.["*"] : undefined;
  if (access !== "WRITE" && access !== "OWNER") return;
  policy.set(CHAT_POLICY);
  about.set({
    kind: "group",
    title: "Space conversation",
    createdAt: new FabricEpochNsec(BigInt(Date.now()) * 1_000_000n),
    policy,
  });
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
    left: {},
    admissions: {},
    profiles: {},
    abandoned: false,
    notices: [],
  });
  const profile = wish<ChatProfile>({ query: "#profile" });
  const room = FabriChatRoom({ about, memory, myProfile: profile.result });
  const ready = computed(() => about.get() !== undefined);
  const canCreate = computed(() => {
    const access = spaceAccess(about);
    return access === "WRITE" || access === "OWNER";
  });
  return {
    [NAME]: "FabriChat",
    [UI]: (
      <cf-screen>
        {ready ? room[UI] : (
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
                onClick={initializeRoom({ about, policy })}
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
    [VIEWS]: { room: room[VIEWS].room },
  };
});
