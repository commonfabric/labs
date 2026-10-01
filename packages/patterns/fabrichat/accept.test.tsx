/**
 * Accepting a FabriChat direct room someone else created. The room's `about`
 * links the record its creator's manager wrote, labeled `authored-by` the
 * creator, and the accepting manager takes the counterpart from that label: it
 * refuses an event naming someone else, and with no counterpart named, records
 * the creator.
 */
import {
  action,
  assert,
  type Cell,
  currentPrincipal,
  type DID,
  handler,
  multiUserTest,
  pattern,
  principalOf,
  TESTS,
  Writable,
} from "commonfabric";
import { FabriChatManagerCore } from "./manager.tsx";
import {
  type ChatIndexEntry,
  type ChatManagerNotice,
  type ChatProfile,
  type ChatRequestOutcome,
  type ChatRoomLink,
} from "./schemas.tsx";

type ManagerArg = Parameters<typeof FabriChatManagerCore>[0];

const CAROL = "did:key:z6MkiT3dKXX5dqUcbnpf1Ejp8hFVuMM9MN9eftydT9T4uurE";

/** A DID a participant has written, or `""` before it has. */
type MaybeDID = DID | "";

/** What every session receives from the setup. */
interface Setup {
  /** Alice's principal, as her own run of a handler finds it. */
  aliceDid: Writable<MaybeDID>;

  /** Bob's principal, as his own run of a handler finds it. */
  bobDid: Writable<MaybeDID>;

  /** The direct room Alice created, once she has. */
  held: Writable<{ room?: Cell<ChatRoomLink> }>;
}

export const setup = pattern(() => ({
  aliceDid: Writable.of<MaybeDID>(""),
  bobDid: Writable.of<MaybeDID>(""),
  held: Writable.of<{ room?: Cell<ChatRoomLink> }>({}),
}));

/** What `introduce` is bound to. */
interface IntroduceState {
  /** Where the actor's principal goes. */
  me: Writable<MaybeDID>;
}

/** Records the actor's principal in `me`. */
const introduce = handler<unknown, IntroduceState>((_event, { me }) => {
  me.set(currentPrincipal() ?? "");
});

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

// Creates a direct room with Bob, and hands it to him through the setup.
export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const rooms = Writable.of<ChatIndexEntry[]>([]);
  const manager = FabriChatManagerCore({
    myProfile: Writable.of<ChatProfile>({ name: "Alice" }),
    rooms,
    direct: Writable.of<Record<string, ChatIndexEntry>>({}),
    requests: Writable.of<Record<string, ChatRequestOutcome>>({}),
    outgoingNotices: Writable.of<ChatManagerNotice[]>([]),
  } as ManagerArg);
  const action_open_direct = action(() =>
    manager.openDirect.send({
      requestId: "d-1",
      counterpart: setup.bobDid.get(),
    })
  );
  const action_hand_over = action(() =>
    setup.held.key("room").set(rooms.key(0).key("room").resolveAsCell())
  );

  return {
    [TESTS]: [
      { action: introduce({ me: setup.aliceDid }), event: {} },
      { await: "bob-introduced" },
      { action: action_open_direct },
      { action: action_hand_over },
      { assertion: assert(() => rooms.get()[0]?.counterpart !== undefined) },
      { label: "alice-created" },
      { await: "bob-done" },
    ],
  };
});

// Accepts the room, with a counterpart that isn't its creator and with none.
export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const rooms = Writable.of<ChatIndexEntry[]>([]);
  const requests = Writable.of<Record<string, ChatRequestOutcome>>({});
  const manager = FabriChatManagerCore({
    myProfile: Writable.of<ChatProfile>({ name: "Bob" }),
    rooms,
    direct: Writable.of<Record<string, ChatIndexEntry>>({}),
    requests,
    outgoingNotices: Writable.of<ChatManagerNotice[]>([]),
  } as ManagerArg);
  const action_accept_naming_carol = action(() =>
    manager.accept.send({
      requestId: "a-1",
      room: setup.held.key("room").resolveAsCell(),
      counterpart: CAROL,
    })
  );
  const action_accept = action(() =>
    manager.accept.send({
      requestId: "a-2",
      room: setup.held.key("room").resolveAsCell(),
    })
  );

  return {
    [TESTS]: [
      { action: introduce({ me: setup.bobDid }), event: {} },
      { label: "bob-introduced" },
      { await: "alice-created" },
      // The room's record names Alice as its creator.
      {
        assertion: assert(() =>
          setup.aliceDid.get() !== "" &&
          principalOf(
              setup.held.key("room").key("about").key("record"),
              "authored-by",
            ) === setup.aliceDid.get()
        ),
      },
      { action: action_accept_naming_carol },
      { action: action_accept },
      {
        assertion: assert(() =>
          reasonOf(requests, "a-1") ===
            "The counterpart is not the room's creator." &&
          reasonOf(requests, "a-2") === "done" &&
          rooms.get().length === 1 &&
          rooms.get()[0]?.counterpart === setup.aliceDid.get()
        ),
      },
      { label: "bob-done" },
    ],
  };
});

export default multiUserTest({ setup, participants: { alice, bob } });
