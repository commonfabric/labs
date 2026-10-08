/**
 * A FabriChat manager creating rooms, finding, forgetting, and accepting them,
 * and refusing the requests it can't act on. That each room lives in a space
 * of its own is something a pattern can't read, so
 * `../integration/fabrichat-manager.test.ts` checks it. The manager is given a
 * profile of its own, since `#profile` resolves nothing in this lane and no
 * chat starts without one; `manager.test.tsx` covers a manager with none.
 */
import {
  action,
  type AddIntegrity,
  assert,
  currentPrincipal,
  equals,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import type { SharedSpaceCatalogStorage } from "../system/shared-space-catalog.ts";
import {
  countElements,
  findNode,
  findNodeById,
  findNodeByProp,
  fireEvent,
  propsOf,
  propValue,
  readValue,
  textContent,
} from "../test/vnode-helpers.ts";
import { FabriChatManagerCore } from "./manager.tsx";
import {
  CHAT_START_ACTION,
  CHAT_START_SURFACE,
  type ChatIndexEntry,
  type ChatManagerNotice,
  type ChatProfile,
  type ChatRequestOutcome,
  type ChatRoomLink,
  type ProfileCell,
} from "./schemas.tsx";

type ManagerArg = Parameters<typeof FabriChatManagerCore>[0];

// A stand-in for this user's `#profile`, labeled, as a Fabric profile is,
// because a room's participants link only a document that carries a label.
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

/** The gesture a start takes, as a client's start control makes it. */
const startGesture = { surface: CHAT_START_SURFACE, action: CHAT_START_ACTION };

// Stand-ins for principals, each a base58btc key as a principal's is.
const BOB = "did:key:z6MkBob";
const CAROL = "did:key:z6MkCaro1";

/** A room held apart from the index, which forgetting it changes. */
interface HeldRoom {
  room?: Writable<ChatRoomLink & { participants?: ProfileCell[] }>;
}

const statusOf = (
  requests: Writable<Record<string, ChatRequestOutcome>>,
  id: string,
): string => requests.get()?.[id]?.status ?? "none";

// How the element `id` under `root` is displayed.
const displayOf = (root: unknown, id: string): unknown =>
  readValue(
    (propValue(findNodeById(root, id), "style") as { display?: unknown })
      ?.display,
  );

// What a manager shows about the session's latest start: how its refusal is
// displayed, and what it says.
const shownRefusal = (root: unknown): string =>
  `${displayOf(root, "fabrichat-start-refusal")}:` +
  textContent(findNodeById(root, "fabrichat-start-refusal"));

// The cell the first `cf-cell-link` labeled `label` under `root` links: a
// listed room's, labeled as its entry is, or a notice's, which carries no
// label.
const cellLinked = (
  root: unknown,
  label: string | undefined,
): object | undefined =>
  propsOf(
    findNode(root, (node) =>
      readValue((node as { name?: unknown })?.name) === "cf-cell-link" &&
      readValue(propsOf(node)?.label) === label),
  )?.$cell as object | undefined;

/** Why the request `id` was refused, or its status if it wasn't. */
const reasonOf = (
  requests: Writable<Record<string, ChatRequestOutcome>>,
  id: string,
): string => {
  const outcome = requests.get()?.[id];
  return outcome?.status === "refused"
    ? outcome.reason
    : outcome?.status ?? "none";
};

/** What a room says of its messages through the link a manager lists. */
const linkedCount = (room: ChatIndexEntry["room"] | undefined): string => {
  const messages = room?.get()?.messages;
  return `count:${messages?.count ?? "none"} ` +
    `newestAt:${messages?.newestAt ?? "none"}`;
};

/** An empty shared-space catalog, as a manager lists its rooms from. */
const emptyCatalog = () =>
  Writable.of<SharedSpaceCatalogStorage>({ entries: {}, offers: {} });

/** The room a request's outcome names, as a cell. */
const roomOf = (
  requests: Writable<Record<string, ChatRequestOutcome>>,
  id: string,
) => requests.key(id).key("entry").key("room").resolveAsCell();

const recipientsOf = (notices: Writable<ChatManagerNotice[]>): string =>
  (notices.get() ?? []).map((notice) => notice.recipient).join(",");

export default pattern(() => {
  const profile = Writable.of<TestProfile>({ name: "Tester" });

  // A direct room: one per counterpart, found again after it is forgotten.
  const directNotices = Writable.of<ChatManagerNotice[]>([]);
  const directRequests = Writable.of<Record<string, ChatRequestOutcome>>({});
  const direct = FabriChatManagerCore({
    myProfile: profile,
    sharedSpaceCatalog: emptyCatalog(),
    direct: Writable.of<Record<string, ChatIndexEntry>>({}),
    requests: directRequests,
    outgoingNotices: directNotices,
  } as ManagerArg);
  const directHeld = Writable.of<HeldRoom>({});
  const action_hold_direct = action(() =>
    directHeld.key("room").set(roomOf(directRequests, "d-1"))
  );
  const action_forget_direct_unrevised = action(() =>
    direct.forget.send({
      requestId: "f-unrevised",
      room: directHeld.key("room").resolveAsCell(),
    })
  );
  const action_forget_direct_stale = action(() =>
    direct.forget.send({
      requestId: "f-stale",
      room: directHeld.key("room").resolveAsCell(),
      revision: "1:stale",
    })
  );
  const action_forget_direct = action(() =>
    direct.forget.send({
      requestId: "f-1",
      room: directHeld.key("room").resolveAsCell(),
      revision: direct.rooms[0]?.revision,
    })
  );

  // A group room, which states its title, and leaves this user out of its
  // other members.
  const groupNotices = Writable.of<ChatManagerNotice[]>([]);
  const groupRequests = Writable.of<Record<string, ChatRequestOutcome>>({});
  const group = FabriChatManagerCore({
    myProfile: profile,
    sharedSpaceCatalog: emptyCatalog(),
    direct: Writable.of<Record<string, ChatIndexEntry>>({}),
    requests: groupRequests,
    outgoingNotices: groupNotices,
  } as ManagerArg);
  // This user's own principal, which the group's members name as well.
  const self = Writable.of<string>("");
  const action_note_self = action(() => self.set(currentPrincipal() ?? ""));
  const action_open_direct_with_self = action(() =>
    group.openDirect.send({
      requestId: "d-self",
      counterpart: currentPrincipal(),
    })
  );
  // A profile page's address, pasted where a principal's DID goes.
  const action_type_address = action(() =>
    fireEvent(
      findNodeByProp(group[UI], "inputId", "fabrichat-start-direct"),
      "onClick",
      { target: { value: ` ${BOB}/of:fid1:profile ` } },
      "the direct start control",
    )
  );

  // Accepting a group room, and a direct room only with its counterpart.
  const acceptRequests = Writable.of<Record<string, ChatRequestOutcome>>({});
  const accepting = FabriChatManagerCore({
    myProfile: profile,
    sharedSpaceCatalog: emptyCatalog(),
    direct: Writable.of<Record<string, ChatIndexEntry>>({}),
    requests: acceptRequests,
    outgoingNotices: Writable.of<ChatManagerNotice[]>([]),
  } as ManagerArg);
  const acceptHeld = Writable.of<HeldRoom>({});
  const action_hold_accepted_group = action(() =>
    acceptHeld.key("room").set(roomOf(acceptRequests, "g-1"))
  );
  const action_hold_accepted_direct = action(() =>
    acceptHeld.key("room").set(roomOf(acceptRequests, "d-1"))
  );
  const action_forget_accepted_group = action(() =>
    accepting.forget.send({
      requestId: "f-1",
      room: acceptHeld.key("room").resolveAsCell(),
      revision: accepting.rooms[0]?.revision,
    })
  );
  const action_forget_group_again = action(() =>
    accepting.forget.send({
      requestId: "f-2",
      room: acceptHeld.key("room").resolveAsCell(),
      revision: accepting.rooms[0]?.revision,
    })
  );
  const action_forget_accepted_direct = action(() =>
    accepting.forget.send({
      requestId: "f-3",
      room: acceptHeld.key("room").resolveAsCell(),
      revision: accepting.rooms[0]?.revision,
    })
  );
  const action_accept_group = action(() =>
    accepting.accept.send({
      requestId: "a-1",
      room: acceptHeld.key("room").resolveAsCell(),
    })
  );
  const action_accept_direct_alone = action(() =>
    accepting.accept.send({
      requestId: "a-2",
      room: acceptHeld.key("room").resolveAsCell(),
    })
  );
  const action_accept_direct_with_bob = action(() =>
    accepting.accept.send({
      requestId: "a-3",
      room: acceptHeld.key("room").resolveAsCell(),
      counterpart: BOB,
    })
  );

  // A notice reported delivered.
  const deliveredNotices = Writable.of<ChatManagerNotice[]>([]);
  const delivering = FabriChatManagerCore({
    myProfile: profile,
    sharedSpaceCatalog: emptyCatalog(),
    direct: Writable.of<Record<string, ChatIndexEntry>>({}),
    requests: Writable.of<Record<string, ChatRequestOutcome>>({}),
    outgoingNotices: deliveredNotices,
  } as ManagerArg);
  const action_report_delivered = action(() =>
    delivering.delivered.send({
      requestId: "n-1",
      id: deliveredNotices.get()[0]?.id,
    })
  );

  return {
    [TESTS]: [
      // A direct room.
      {
        action: direct.openDirect,
        event: { requestId: "d-1", counterpart: BOB },
        trustedUi: startGesture,
      },
      { action: action_hold_direct },
      {
        assertion: assert(() =>
          direct.rooms.length === 1 &&
          direct.rooms[0]?.counterpart === BOB &&
          // Its creator is listed among its participants without a step of
          // their own.
          (directHeld.key("room").get()?.get()?.participants ?? []).some((
            known,
          ) => equals(known, profile)) &&
          recipientsOf(directNotices) === BOB
        ),
      },
      // The notice offers the room's link, for its creator to send on, and
      // the room's entry in the list is a link to it, labeled with whom it is
      // with, which opens it as a page of its own: the manager renders no
      // room itself.
      {
        assertion: assert(() =>
          equals(cellLinked(direct[UI], undefined), directHeld.key("room")) &&
          equals(
            cellLinked(direct[UI], `With ${BOB}`),
            directHeld.key("room"),
          ) &&
          countElements(direct[UI], "cf-render") === 0
        ),
      },
      // The conversation with one person is always the same room.
      {
        action: direct.openDirect,
        event: { requestId: "d-2", counterpart: BOB },
        trustedUi: startGesture,
      },
      { assertion: assert(() => direct.rooms.length === 1) },
      // Forgetting it keeps it in `direct`; finding it again puts it back.
      { action: action_forget_direct },
      { assertion: assert(() => direct.rooms.length === 0) },
      {
        action: direct.openDirect,
        event: { requestId: "d-3", counterpart: BOB },
        trustedUi: startGesture,
      },
      {
        assertion: assert(() =>
          direct.rooms.length === 1 &&
          equals(direct.rooms[0]?.room, directHeld.key("room"))
        ),
      },
      // Forgetting names the revision of the room's entry its list showed, so
      // a request naming none, or one the entry has moved on from, is refused,
      // and the room stays listed.
      { action: action_forget_direct_unrevised },
      { action: action_forget_direct_stale },
      {
        assertion: assert(() =>
          reasonOf(directRequests, "f-unrevised") ===
            "The request names no revision of the room's entry." &&
          reasonOf(directRequests, "f-stale") ===
            "The room's entry changed since it was listed." &&
          direct.rooms.length === 1
        ),
      },

      // A group room.
      { action: action_note_self },
      {
        action: group.createGroup,
        event: {
          requestId: "g-1",
          title: "Team",
          members: [CAROL, CAROL, self],
        },
        trustedUi: startGesture,
      },
      {
        assertion: assert(() =>
          group.rooms.length === 1 &&
          recipientsOf(groupNotices) === CAROL &&
          group.rooms[0]?.kind === "group" &&
          group.rooms[0]?.room.key("about").get()?.kind === "group" &&
          group.rooms[0]?.room.key("about").get()?.title === "Team" &&
          !equals(group.rooms[0]?.room, directHeld.key("room"))
        ),
      },
      // The link carries where the conversation stands, which a new room has
      // no messages of.
      {
        assertion: assert(() =>
          linkedCount(group.rooms[0]?.room) === "count:0 newestAt:none"
        ),
      },
      // A request already decided changes nothing when it arrives again.
      {
        action: group.createGroup,
        event: { requestId: "g-1", title: "Team", members: [] },
        trustedUi: startGesture,
      },
      { assertion: assert(() => group.rooms.length === 1) },
      // The start controls are enabled, and a start the manager can't act on
      // is refused with its reason: a direct room with this user themself,
      // with someone who isn't a principal, or a group room with no title.
      {
        assertion: assert(() =>
          propValue(
            findNodeByProp(group[UI], "inputId", "fabrichat-start-direct"),
            "disabled",
          ) === false
        ),
      },
      { assertion: assert(() => shownRefusal(group[UI]) === "none:") },
      { action: action_open_direct_with_self },
      {
        assertion: assert(() =>
          shownRefusal(group[UI]) === "block:The counterpart is this user."
        ),
      },
      {
        action: group.openDirect,
        event: { requestId: "d-junk", counterpart: "not a principal" },
        trustedUi: startGesture,
      },
      {
        action: group.createGroup,
        event: { requestId: "g-blank", title: "  ", members: [CAROL] },
        trustedUi: startGesture,
      },
      {
        assertion: assert(() =>
          reasonOf(groupRequests, "d-self") ===
            "The counterpart is this user." &&
          reasonOf(groupRequests, "d-junk") ===
            "The counterpart is not a principal." &&
          reasonOf(groupRequests, "g-blank") ===
            "A group room needs a title." &&
          group.rooms.length === 1 &&
          recipientsOf(groupNotices) === CAROL
        ),
      },
      // The session is shown its latest refusal, and for text that isn't a
      // principal, the text it sent.
      {
        assertion: assert(() =>
          shownRefusal(group[UI]) === "block:A group room needs a title."
        ),
      },
      { action: action_type_address },
      {
        assertion: assert(() =>
          shownRefusal(group[UI]) ===
            "block:The counterpart is not a principal. Received: " +
              `"${BOB}/of:fid1:profile"`
        ),
      },
      // A well-formed DID whose key isn't base58btc names no principal: here,
      // one a sentence's period follows.
      {
        action: group.openDirect,
        event: { requestId: "d-period", counterpart: `${BOB}.` },
        trustedUi: startGesture,
      },
      {
        assertion: assert(() =>
          reasonOf(groupRequests, "d-period") ===
            "The counterpart is not a principal." &&
          shownRefusal(group[UI]) ===
            "block:The counterpart is not a principal. Received: " +
              `"${BOB}."`
        ),
      },
      // A group whose members include text that isn't a principal is
      // refused, and the session is shown that text.
      {
        action: group.createGroup,
        event: { requestId: "g-junk", title: "Team", members: [CAROL, "junk"] },
        trustedUi: startGesture,
      },
      {
        assertion: assert(() =>
          reasonOf(groupRequests, "g-junk") ===
            "A group's members must be principals." &&
          shownRefusal(group[UI]) ===
            'block:A group\'s members must be principals. Received: ["junk"]' &&
          group.rooms.length === 1
        ),
      },
      // A request missing what its stream needs is refused, with why, rather
      // than dropped: an event's type doesn't refuse it.
      { action: group.forget, event: { requestId: "f-none" } },
      { action: group.accept, event: { requestId: "a-none" } },
      { action: group.delivered, event: { requestId: "n-none" } },
      {
        action: group.createGroup,
        event: { requestId: "g-none", title: "No members" },
        trustedUi: startGesture,
      },
      {
        assertion: assert(() =>
          reasonOf(groupRequests, "f-none") === "The request names no room." &&
          reasonOf(groupRequests, "a-none") === "The request names no room." &&
          reasonOf(groupRequests, "n-none") ===
            "The request names no notice." &&
          reasonOf(groupRequests, "g-none") ===
            "A group's members must be listed." &&
          group.rooms.length === 1
        ),
      },
      // A profile that attests no principal offers no chat address.
      {
        assertion: assert(() =>
          displayOf(group[UI], "fabrichat-my-address") === "none"
        ),
      },
      // A start that is done shows nothing.
      {
        action: group.openDirect,
        event: { requestId: "d-carol", counterpart: CAROL },
        trustedUi: startGesture,
      },
      { assertion: assert(() => shownRefusal(group[UI]) === "none:") },

      // Accepting a group room it was admitted to.
      {
        action: accepting.createGroup,
        event: { requestId: "g-1", title: "Team", members: [] },
        trustedUi: startGesture,
      },
      { action: action_hold_accepted_group },
      { action: action_forget_accepted_group },
      { assertion: assert(() => accepting.rooms.length === 0) },
      { action: action_accept_group },
      {
        assertion: assert(() =>
          accepting.rooms.length === 1 &&
          accepting.rooms[0]?.kind === "group" &&
          equals(accepting.rooms[0]?.room, acceptHeld.key("room")) &&
          statusOf(acceptRequests, "a-1") === "done"
        ),
      },

      // A direct room this user created is not accepted, with a counterpart
      // or without one: its label names this user, and `openDirect` finds it
      // again. `accept.test.tsx` covers accepting someone else's.
      { action: action_forget_group_again },
      {
        action: accepting.openDirect,
        event: { requestId: "d-1", counterpart: BOB },
        trustedUi: startGesture,
      },
      { action: action_hold_accepted_direct },
      { action: action_forget_accepted_direct },
      { action: action_accept_direct_alone },
      { action: action_accept_direct_with_bob },
      {
        assertion: assert(() =>
          reasonOf(acceptRequests, "a-2") ===
            "The room was created by this user." &&
          reasonOf(acceptRequests, "a-3") ===
            "The room was created by this user." &&
          accepting.rooms.length === 0
        ),
      },

      // A notice reported delivered is dropped.
      {
        action: delivering.openDirect,
        event: { requestId: "d-1", counterpart: BOB },
        trustedUi: startGesture,
      },
      { assertion: assert(() => deliveredNotices.get().length === 1) },
      { action: action_report_delivered },
      { assertion: assert(() => deliveredNotices.get().length === 0) },
    ],
  };
});
