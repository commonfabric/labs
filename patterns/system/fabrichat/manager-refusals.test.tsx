/**
 * What a FabriChat manager refuses. It offers a group room of its user's own
 * to no one named by a profile that attests no one, by something that is no
 * principal, or by a profile and an address that name two different people,
 * and not to the user themselves; each such refusal sends no one anything. It
 * accepts no room through a container that doesn't declare it. It forgets
 * nothing that is no room, and no room whose entry another client has changed
 * since the list the request came from, whether it holds the room's
 * membership or lists the room from the catalog alone; the room stays listed.
 * Each refusal is recorded under the request's id with its reason.
 */
import {
  action,
  type AddIntegrity,
  assert,
  type Cell,
  currentPrincipal,
  handler,
  pattern,
  type RepresentsCurrentUser,
  spaceOf,
  TESTS,
  type TrustedActionWrite,
  Writable,
} from "commonfabric";
import {
  readSharedSpaceCatalog,
  registerSharedSpaceIn,
  type SharedSpaceCatalogStorage,
  type SharedSpaceEntry,
} from "../shared-space/shared-space-catalog.ts";
import { FabriChatManagerCore } from "./manager.tsx";
import {
  CHAT_ROOM_OFFER_KIND,
  CHAT_START_ACTION,
  CHAT_START_SURFACE,
  type ChatContainer,
  type ChatIndexEntry,
  type ChatManagerNotice,
  type ChatManagerProfile,
  type ChatProfile,
  type ChatRequestOutcome,
  type ChatRoomLink,
} from "./schemas.tsx";

// A stand-in for this user's `#profile`, labeled, as a Fabric profile is.
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

const startGesture = { surface: CHAT_START_SURFACE, action: CHAT_START_ACTION };

/** The reviewed surface and action this user writes a profile of theirs from. */
const PROFILE_SURFACE = "FabriChatTestProfileSurface";
const PROFILE_ACTION = "FabriChatTestWriteProfile";
const profileGesture = { surface: PROFILE_SURFACE, action: PROFILE_ACTION };

// A stand-in for another principal, a base58btc key as a principal's is.
const BOB = "did:key:z6MkBob";

/**
 * A profile labeled with the principal who wrote it, which only
 * `writeOwnProfile` writes, from its reviewed surface.
 */
type OwnProfile = RepresentsCurrentUser<
  TrustedActionWrite<
    ChatManagerProfile,
    typeof writeOwnProfile,
    typeof PROFILE_ACTION,
    typeof PROFILE_SURFACE
  >
>;

/** What `writeOwnProfile` is bound to. */
interface ProfileWriteState {
  /** The profile to write. */
  profile: Writable<OwnProfile>;
}

/** Writes a profile of the acting person's own. */
const writeOwnProfile = handler<unknown, ProfileWriteState>((
  _event,
  { profile },
) => {
  profile.set({ name: "Tester, again" });
});

/** The catalog's entry for the space `room` lives in. */
const entryOf = (
  catalog: Cell<SharedSpaceCatalogStorage>,
  room: Cell<unknown>,
): SharedSpaceEntry | undefined =>
  readSharedSpaceCatalog(catalog).entries[spaceOf(room) ?? ""];

/** Why the request `id` was refused, or its status if it wasn't. */
const reasonOf = (
  requests: Cell<Record<string, ChatRequestOutcome>>,
  id: string,
): string => {
  const outcome = requests.get()?.[id];
  return outcome?.status === "refused"
    ? outcome.reason
    : outcome?.status ?? "none";
};

export default pattern(() => {
  const profile = Writable.of<TestProfile>({ name: "Tester" });
  const requests = Writable.of<Record<string, ChatRequestOutcome>>({});
  const notices = Writable.of<ChatManagerNotice[]>([]);
  const catalog = Writable.of<SharedSpaceCatalogStorage>({
    entries: {},
    offers: {},
  });
  const manager = FabriChatManagerCore({
    myProfile: profile,
    sessionProfile: profile,
    sharedSpaceCatalog: catalog,
    direct: Writable.of<Record<string, ChatIndexEntry>>({}),
    requests,
    outgoingNotices: notices,
  });
  // Another manager of this user's, whose room the first lists from the
  // catalog alone, as one listed before memberships were recorded is.
  const otherRequests = Writable.of<Record<string, ChatRequestOutcome>>({});
  const other = FabriChatManagerCore({
    myProfile: profile,
    sessionProfile: profile,
    sharedSpaceCatalog: Writable.of<SharedSpaceCatalogStorage>({
      entries: {},
      offers: {},
    }),
    direct: Writable.of<Record<string, ChatIndexEntry>>({}),
    requests: otherRequests,
    outgoingNotices: Writable.of<ChatManagerNotice[]>([]),
  });
  // A container that declares no conversation.
  const bareContainer = Writable.of<ChatContainer>({});

  // A profile of this user's own, and one no principal wrote as theirs.
  const own = Writable.of<OwnProfile>();
  const unattested = Writable.of<ChatManagerProfile>({ name: "Nobody" });

  const held = Writable.of<{ room?: Cell<ChatRoomLink> }>({});
  const action_hold = action(() =>
    held.key("room").set(
      requests.key("g-1").key("entry").key("room").resolveAsCell(),
    )
  );
  const action_offer_to_unattested = action(() =>
    manager.offerRoom.send({
      requestId: "o-unattested",
      room: held.key("room").resolveAsCell(),
      profile: unattested,
    })
  );
  const action_offer_to_non_principal = action(() =>
    manager.offerRoom.send({
      requestId: "o-not-principal",
      room: held.key("room").resolveAsCell(),
      member: "not a principal",
    })
  );
  const action_offer_by_mismatched_profile = action(() =>
    manager.offerRoom.send({
      requestId: "o-mismatch",
      room: held.key("room").resolveAsCell(),
      profile: own,
      member: BOB,
    })
  );
  const action_offer_by_own_profile = action(() =>
    manager.offerRoom.send({
      requestId: "o-own-profile",
      room: held.key("room").resolveAsCell(),
      profile: own,
    })
  );
  const action_offer_to_self = action(() =>
    manager.offerRoom.send({
      requestId: "o-self",
      room: held.key("room").resolveAsCell(),
      member: currentPrincipal() ?? "",
    })
  );

  // An accept naming the room through a container that doesn't declare it.
  const action_accept_through_bare_container = action(() =>
    manager.accept.send({
      requestId: "a-undeclared",
      room: held.key("room").resolveAsCell(),
      container: bareContainer,
    })
  );
  // A forget naming, through a container, something in the room's space that
  // is no room: its message list.
  const action_forget_message_list_through_container = action(() =>
    manager.forget.send({
      requestId: "f-not-room",
      room: held.key("room").key("messages").resolveAsCell(),
      container: bareContainer,
      revision: entryOf(catalog, held.key("room").resolveAsCell())?.revision ??
        "",
    })
  );
  // Another client's change to the room's entry, which it recorded and never
  // finished: the entry still reads as saved.
  const action_leave_change_unfinished = action(() => {
    const space = spaceOf(held.key("room").resolveAsCell()) ?? "";
    const revision = entryOf(catalog, held.key("room").resolveAsCell())
      ?.revision ?? "";
    catalog.key("entries", space, "lastAction").set({
      id: "another-client",
      expectedRevision: revision,
      state: "archived",
    });
  });
  const action_forget_mid_change = action(() =>
    manager.forget.send({
      requestId: "f-mid-change",
      room: held.key("room").resolveAsCell(),
      revision: entryOf(catalog, held.key("room").resolveAsCell())?.revision ??
        "",
    })
  );
  const otherHeld = Writable.of<{ room?: Cell<ChatRoomLink> }>({});
  const action_list_other_room = action(() => {
    const room = otherRequests.key("g-2").key("entry").key("room")
      .resolveAsCell();
    otherHeld.key("room").set(room);
    registerSharedSpaceIn(catalog, {
      space: spaceOf(room) ?? "",
      host: "http://localhost:8000",
      kind: CHAT_ROOM_OFFER_KIND,
    });
  });
  const action_forget_listed_room_stale = action(() =>
    manager.forget.send({
      requestId: "f-listed-stale",
      room: otherHeld.key("room").resolveAsCell(),
      revision: "1:stale",
    })
  );

  return {
    [TESTS]: [
      {
        action: manager.createGroup,
        event: { requestId: "g-1", title: "Team", members: [] },
        trustedUi: startGesture,
      },
      { assertion: assert(() => reasonOf(requests, "g-1") === "done") },
      { action: action_hold },
      {
        action: writeOwnProfile({ profile: own }),
        event: {},
        trustedUi: profileGesture,
      },
      { action: action_offer_to_unattested },
      { action: action_offer_to_non_principal },
      { action: action_offer_by_mismatched_profile },
      { action: action_offer_by_own_profile },
      { action: action_offer_to_self },
      {
        assertion: assert(() =>
          reasonOf(requests, "o-unattested") ===
            "A member's profile attests no principal." &&
          reasonOf(requests, "o-not-principal") ===
            "The member is not a principal." &&
          reasonOf(requests, "o-mismatch") ===
            "The profile is not the member's." &&
          reasonOf(requests, "o-own-profile") ===
            "The member is this user." &&
          reasonOf(requests, "o-self") === "The member is this user." &&
          (notices.get() ?? []).length === 0
        ),
      },
      { action: action_accept_through_bare_container },
      { action: action_forget_message_list_through_container },
      { action: action_leave_change_unfinished },
      { action: action_forget_mid_change },
      {
        action: other.createGroup,
        event: { requestId: "g-2", title: "Elsewhere", members: [] },
        trustedUi: startGesture,
      },
      { assertion: assert(() => reasonOf(otherRequests, "g-2") === "done") },
      { action: action_list_other_room },
      { action: action_forget_listed_room_stale },
      // Each is refused, and the room stays listed as saved.
      {
        assertion: assert(() =>
          reasonOf(requests, "a-undeclared") ===
            "The container does not declare this room." &&
          reasonOf(requests, "f-not-room") === "The request names no room." &&
          reasonOf(requests, "f-mid-change") ===
            "The room's entry changed since it was listed." &&
          reasonOf(requests, "f-listed-stale") ===
            "The room's entry changed since it was listed." &&
          entryOf(catalog, held.key("room").resolveAsCell())?.state ===
            "saved" &&
          entryOf(catalog, otherHeld.key("room").resolveAsCell())?.state ===
            "saved"
        ),
      },
    ],
  };
});
