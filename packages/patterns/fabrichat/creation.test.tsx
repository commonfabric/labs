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
  assert,
  currentPrincipal,
  equals,
  pattern,
  type SentSpaceAccessNotice,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  cfRenderHasUI,
  clickButton,
  findElement,
  findNodeById,
  findNodeByProp,
  fireEvent,
  propsOf,
  propValue,
  readValue,
  textContent,
} from "../test/vnode-helpers.ts";
import { FabriChatManagerCore } from "./manager.tsx";
import type {
  ChatIndexEntry,
  ChatManagerNotice,
  ChatProfile,
  ChatRequestOutcome,
  ChatRoomLink,
} from "./schemas.tsx";

type ManagerArg = Parameters<typeof FabriChatManagerCore>[0];

// Stand-ins for principals, each a base58btc key as a principal's is.
const BOB = "did:key:z6MkBob";
const CAROL = "did:key:z6MkCaro1";

/** A room held apart from the index, which forgetting it changes. */
interface HeldRoom {
  room?: Writable<ChatRoomLink>;
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

// Which of a manager's two parts it shows: the chosen room, or the prompt to
// choose one.
const shownPart = (root: unknown): string =>
  `selected:${displayOf(root, "fabrichat-selected")} ` +
  `unselected:${displayOf(root, "fabrichat-unselected")}`;

// What a manager shows about the session's latest start: how its refusal is
// displayed, and what it says.
const shownRefusal = (root: unknown): string =>
  `${displayOf(root, "fabrichat-start-refusal")}:` +
  textContent(findNodeById(root, "fabrichat-start-refusal"));

// The cell a manager's first notice links.
const noticeLink = (root: unknown): object | undefined =>
  propsOf(findElement(root, "cf-cell-link"))?.$cell as object | undefined;

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

const recipientsOf = (notices: Writable<ChatManagerNotice[]>): string =>
  (notices.get() ?? []).map((notice) => notice.recipient).join(",");

export default pattern<{ spaceAccessNotices: SentSpaceAccessNotice[] }>((
  { spaceAccessNotices },
) => {
  const profile = Writable.of<ChatProfile>({ name: "Tester" });

  // A direct room: one per counterpart, found again after it is forgotten.
  const directRooms = Writable.of<ChatIndexEntry[]>([]);
  const directNotices = Writable.of<ChatManagerNotice[]>([]);
  const direct = FabriChatManagerCore({
    myProfile: profile,
    rooms: directRooms,
    direct: Writable.of<Record<string, ChatIndexEntry>>({}),
    requests: Writable.of<Record<string, ChatRequestOutcome>>({}),
    outgoingNotices: directNotices,
  } as ManagerArg);
  const directHeld = Writable.of<HeldRoom>({});
  const action_hold_direct = action(() =>
    directHeld.key("room").set(directRooms.key(0).key("room").resolveAsCell())
  );
  const action_forget_direct = action(() =>
    direct.forget.send({
      requestId: "f-1",
      room: directHeld.key("room").resolveAsCell(),
    })
  );

  // A group room, which states its title, and leaves this user out of its
  // other members.
  const groupRooms = Writable.of<ChatIndexEntry[]>([]);
  const groupNotices = Writable.of<ChatManagerNotice[]>([]);
  const groupRequests = Writable.of<Record<string, ChatRequestOutcome>>({});
  const group = FabriChatManagerCore({
    myProfile: profile,
    rooms: groupRooms,
    direct: Writable.of<Record<string, ChatIndexEntry>>({}),
    requests: groupRequests,
    outgoingNotices: groupNotices,
  } as ManagerArg);
  const action_create_group = action(() =>
    group.createGroup.send({
      requestId: "g-1",
      title: "Team",
      members: [CAROL, CAROL, "junk", currentPrincipal() ?? ""],
    })
  );
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
  const acceptRooms = Writable.of<ChatIndexEntry[]>([]);
  const acceptRequests = Writable.of<Record<string, ChatRequestOutcome>>({});
  const accepting = FabriChatManagerCore({
    myProfile: profile,
    rooms: acceptRooms,
    direct: Writable.of<Record<string, ChatIndexEntry>>({}),
    requests: acceptRequests,
    outgoingNotices: Writable.of<ChatManagerNotice[]>([]),
  } as ManagerArg);
  const acceptHeld = Writable.of<HeldRoom>({});
  const action_hold_accepted = action(() =>
    acceptHeld.key("room").set(acceptRooms.key(0).key("room").resolveAsCell())
  );
  const action_forget_accepted_group = action(() =>
    accepting.forget.send({
      requestId: "f-1",
      room: acceptHeld.key("room").resolveAsCell(),
    })
  );
  const action_forget_group_again = action(() =>
    accepting.forget.send({
      requestId: "f-2",
      room: acceptHeld.key("room").resolveAsCell(),
    })
  );
  const action_forget_accepted_direct = action(() =>
    accepting.forget.send({
      requestId: "f-3",
      room: acceptHeld.key("room").resolveAsCell(),
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
    rooms: Writable.of<ChatIndexEntry[]>([]),
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
      },
      { action: action_hold_direct },
      {
        assertion: assert(() =>
          directRooms.get().length === 1 &&
          directRooms.get()[0]?.counterpart === BOB &&
          recipientsOf(directNotices) === BOB
        ),
      },
      // The notice offers the room's link, for its creator to send on.
      {
        assertion: assert(() =>
          equals(noticeLink(direct[UI]), directRooms.key(0).key("room"))
        ),
      },
      // Choosing the room shows it in place of the prompt to choose one.
      {
        assertion: assert(() =>
          shownPart(direct[UI]) === "selected:none unselected:block"
        ),
      },
      { action: action(() => clickButton(direct[UI], `With ${BOB}`)) },
      {
        assertion: assert(() =>
          shownPart(direct[UI]) === "selected:block unselected:none" &&
          cfRenderHasUI(findNodeById(direct[UI], "fabrichat-selected"))
        ),
      },
      // The conversation with one person is always the same room.
      {
        action: direct.openDirect,
        event: { requestId: "d-2", counterpart: BOB },
      },
      { assertion: assert(() => directRooms.get().length === 1) },
      // Forgetting it keeps it in `direct`; finding it again puts it back.
      { action: action_forget_direct },
      { assertion: assert(() => directRooms.get().length === 0) },
      {
        action: direct.openDirect,
        event: { requestId: "d-3", counterpart: BOB },
      },
      {
        assertion: assert(() =>
          directRooms.get().length === 1 &&
          equals(directRooms.key(0).key("room"), directHeld.key("room"))
        ),
      },

      // A group room.
      { action: action_create_group },
      {
        assertion: assert(() =>
          groupRooms.get().length === 1 &&
          recipientsOf(groupNotices) === CAROL &&
          groupRooms.key(0).key("room").key("about").get()?.kind === "group" &&
          groupRooms.key(0).key("room").key("about").get()?.title === "Team" &&
          !equals(groupRooms.key(0).key("room"), directHeld.key("room"))
        ),
      },
      // Each room's other member is told through their inbox, once: Bob of
      // the direct room, though it was found again twice, and Carol of the
      // group room, both by this user, each about a room in a space of its own
      // rather than this user's home space.
      { settle: true },
      {
        assertion: assert(() =>
          spaceAccessNotices.map((notice) => notice.recipient).join() ===
            `${BOB},${CAROL}` &&
          spaceAccessNotices.every((notice) =>
            notice.sender === spaceAccessNotices[0]?.sender &&
            notice.space !== notice.sender
          )
        ),
      },
      // A request already decided changes nothing when it arrives again.
      {
        action: group.createGroup,
        event: { requestId: "g-1", title: "Team", members: [] },
      },
      { assertion: assert(() => groupRooms.get().length === 1) },
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
      },
      {
        action: group.createGroup,
        event: { requestId: "g-blank", title: "  ", members: [CAROL] },
      },
      {
        assertion: assert(() =>
          reasonOf(groupRequests, "d-self") ===
            "The counterpart is this user." &&
          reasonOf(groupRequests, "d-junk") ===
            "The counterpart is not a principal." &&
          reasonOf(groupRequests, "g-blank") ===
            "A group room needs a title." &&
          groupRooms.get().length === 1 &&
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
      },
      { assertion: assert(() => shownRefusal(group[UI]) === "none:") },

      // Accepting a group room it was admitted to.
      {
        action: accepting.createGroup,
        event: { requestId: "g-1", title: "Team", members: [] },
      },
      { action: action_hold_accepted },
      { action: action_forget_accepted_group },
      { assertion: assert(() => acceptRooms.get().length === 0) },
      { action: action_accept_group },
      {
        assertion: assert(() =>
          acceptRooms.get().length === 1 &&
          acceptRooms.get()[0]?.kind === "group" &&
          equals(acceptRooms.key(0).key("room"), acceptHeld.key("room")) &&
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
      },
      { action: action_hold_accepted },
      { action: action_forget_accepted_direct },
      { action: action_accept_direct_alone },
      { action: action_accept_direct_with_bob },
      {
        assertion: assert(() =>
          reasonOf(acceptRequests, "a-2") ===
            "The room was created by this user." &&
          reasonOf(acceptRequests, "a-3") ===
            "The room was created by this user." &&
          acceptRooms.get().length === 0
        ),
      },

      // A notice reported delivered is dropped.
      {
        action: delivering.openDirect,
        event: { requestId: "d-1", counterpart: BOB },
      },
      { assertion: assert(() => deliveredNotices.get().length === 1) },
      { action: action_report_delivered },
      { assertion: assert(() => deliveredNotices.get().length === 0) },
    ],
  };
});
