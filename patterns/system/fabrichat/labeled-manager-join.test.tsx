/**
 * A FabriChat room tells its viewer's manager the viewer joined it, through
 * the manager's `joinRoom`, even where the manager carries a confidentiality
 * label the room's space doesn't admit, such as the person's `PersonalSpace`.
 * Whether the room can tell the manager anything is the room's own to decide:
 * what the room stores in its space reads nothing of the manager, so the
 * label can't keep the join from being sent. A control room, whose manager
 * carries no label, sends the same join.
 */
import {
  type AddIntegrity,
  assert,
  type Confidential,
  handler,
  pattern,
  SELF,
  TESTS,
  Writable,
} from "commonfabric";
import type { ParticipantRoster } from "../loom/participants.tsx";
import { type JoinRoomRequest, type MessagesValue } from "./room-records.tsx";
import {
  FabriChatRoomCore,
  type OfferRoomRequest,
  type RoomManager,
} from "./room.tsx";
import {
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  type ChatProfile,
  type ChatRoomLink,
  type TitleRecord,
} from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];

// A stand-in for a viewer's `#profile`, labeled as a Fabric profile is.
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

// The label of the space a person's Home lives in, naming someone other than
// the test's space.
const HOME_LABEL = {
  type: "https://commonfabric.org/cfc/atom/PersonalSpace",
  owner: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
} as const;

/** The part of a manager a room reaches, carrying `HOME_LABEL`. */
type LabeledManager = Confidential<RoomManager, readonly [typeof HOME_LABEL]>;

const sendGesture = { surface: CHAT_SEND_SURFACE, action: CHAT_SEND_ACTION };

const typed = (text: string) => ({ type: "click", target: { value: text } });

/** Counts each join a room sends its viewer's manager. */
const countJoins = handler<JoinRoomRequest, { joins: Writable<number> }>(
  (_event, { joins }) => {
    joins.set(joins.get() + 1);
  },
);

/** Takes an offer and does nothing with it. */
const ignoreOffer = handler<OfferRoomRequest, Record<PropertyKey, never>>(
  () => {},
);

/** A manager's room-facing part, whose `joinRoom` counts into `joins`. */
const StubManager = pattern<{ joins: Writable<number> }, RoomManager>(
  ({ joins }) => ({
    offerRoom: ignoreOffer({}),
    requests: {},
    people: {},
    joinRoom: countJoins({ joins }),
  } as RoomManager),
);

/** A manager's room-facing part, as a document carrying `HOME_LABEL`. */
const LabelManager = pattern<{ manager: RoomManager }, LabeledManager>(
  ({ manager }) => manager as LabeledManager,
);

/** A room's own result, as the link a manager names the room by. */
function roomLinkOf(room: unknown): ChatRoomLink;
function roomLinkOf(room: unknown): unknown {
  return room;
}

/** A room's records, fresh. */
const records = () => ({
  messages: Writable.of<MessagesValue>([] as MessagesValue),
  titles: Writable.of<TitleRecord[]>([]),
});

export default pattern((input) => {
  const profile = Writable.of<TestProfile>({ name: "Alice" });
  const self = roomLinkOf(input[SELF]);

  const labeledJoins = Writable.of<number>(0);
  const labeledRecords = records();
  const labeled = FabriChatRoomCore({
    myProfile: profile,
    about: { kind: "group" as const, title: "Team" },
    ...labeledRecords,
    roster: Writable.of<ParticipantRoster>({}),
    self,
    manager: LabelManager({ manager: StubManager({ joins: labeledJoins }) }),
  } as RoomArg);

  const plainJoins = Writable.of<number>(0);
  const plainRecords = records();
  const plain = FabriChatRoomCore({
    myProfile: profile,
    about: { kind: "group" as const, title: "Control" },
    ...plainRecords,
    roster: Writable.of<ParticipantRoster>({}),
    self,
    manager: StubManager({ joins: plainJoins }),
  } as RoomArg);

  return {
    [TESTS]: [
      {
        action: plain.sendMessage,
        event: typed("Hello"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          plainRecords.messages.get().length === 1 && plainJoins.get() === 1
        ),
      },
      {
        action: labeled.sendMessage,
        event: typed("Hello"),
        trustedUi: sendGesture,
      },
      // The send lands, as `labeled-manager.test.tsx` shows ...
      { assertion: assert(() => labeledRecords.messages.get().length === 1) },
      // ... and the room tells the labeled manager the viewer joined it.
      { assertion: assert(() => labeledJoins.get() === 1) },
    ],
    allowRuntimeErrors: true,
    allowConsoleWarnings: true,
  };
});
