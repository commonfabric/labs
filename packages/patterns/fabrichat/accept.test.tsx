/**
 * Accepting a FabriChat direct room someone else created. The room's `about`
 * links the record its creator's manager wrote, labeled `authored-by` the
 * creator, and the accepting manager takes the counterpart from that label: it
 * refuses an event naming someone else, and with no counterpart named, records
 * the creator. The room offers its other member the control that asks their
 * manager to list it, until the manager does, and accepting the room lists
 * them among its participants. A start with the creator finds a room listed
 * as theirs, preferring the one `direct` holds, rather than creating another.
 */
import {
  action,
  type AddIntegrity,
  assert,
  type Cell,
  currentPrincipal,
  type DID,
  equals,
  handler,
  multiUserTest,
  pattern,
  principalOf,
  spaceOf,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  readSharedSpaceCatalog,
  registerSharedSpace,
  type SharedSpaceCatalogStorage,
} from "../system/shared-space-catalog.ts";
import {
  clickButton,
  findNodeById,
  propValue,
  readValue,
} from "../test/vnode-helpers.ts";
import { FabriChatManagerCore } from "./manager.tsx";
import { AddToChats } from "./room.tsx";
import {
  CHAT_ROOM_OFFER_KIND,
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

// A stand-in for a person's `#profile`, labeled, as a Fabric profile is,
// because a room's participants link only a document that carries a label.
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;
type AddArg = Parameters<typeof AddToChats>[0];

/** The gesture a start takes, as a client's start control makes it. */
const startGesture = { surface: CHAT_START_SURFACE, action: CHAT_START_ACTION };

const CAROL = "did:key:z6MkiT3dKXX5dqUcbnpf1Ejp8hFVuMM9MN9eftydT9T4uurE";

/** A DID a participant has written, or `""` before it has. */
type MaybeDID = DID | "";

/** The room Alice created, as the test reads it: a link, and its participants. */
type HeldRoom = ChatRoomLink & { participants?: ProfileCell[] };

/** What every session receives from the setup. */
interface Setup {
  /** Alice's principal, as her own run of a handler finds it. */
  aliceDid: Writable<MaybeDID>;

  /** Bob's principal, as his own run of a handler finds it. */
  bobDid: Writable<MaybeDID>;

  /** The direct room Alice created, once she has. */
  held: Writable<{ room?: Cell<HeldRoom> }>;

  /**
   * A second direct room Alice created with Bob, from another manager, once
   * she has.
   */
  heldAgain: Writable<{ room?: Cell<HeldRoom> }>;
}

export const setup = pattern(() => ({
  aliceDid: Writable.of<MaybeDID>(""),
  bobDid: Writable.of<MaybeDID>(""),
  held: Writable.of<{ room?: Cell<HeldRoom> }>({}),
  heldAgain: Writable.of<{ room?: Cell<HeldRoom> }>({}),
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

// How a room's control adding it to the viewer's chats is displayed.
const addDisplay = (root: unknown): unknown =>
  readValue(
    (propValue(findNodeById(root, "fabrichat-add-to-chats"), "style") as {
      display?: unknown;
    })?.display,
  );

/** An empty shared-space catalog, as a manager lists its rooms from. */
const emptyCatalog = () =>
  Writable.of<SharedSpaceCatalogStorage>({ entries: {}, offers: {} });

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

// Creates a direct room with Bob, and hands it to him through the setup, and
// then a second one, from another manager.
export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const requests = Writable.of<Record<string, ChatRequestOutcome>>({});
  const manager = FabriChatManagerCore({
    myProfile: Writable.of<TestProfile>({ name: "Alice" }),
    sharedSpaceCatalog: emptyCatalog(),
    direct: Writable.of<Record<string, ChatIndexEntry>>({}),
    requests,
    outgoingNotices: Writable.of<ChatManagerNotice[]>([]),
  } as ManagerArg);
  const action_hand_over = action(() =>
    setup.held.key("room").set(
      requests.key("d-1").key("entry").key("room").resolveAsCell(),
    )
  );
  const againRequests = Writable.of<Record<string, ChatRequestOutcome>>({});
  const again = FabriChatManagerCore({
    myProfile: Writable.of<TestProfile>({ name: "Alice, again" }),
    sharedSpaceCatalog: emptyCatalog(),
    direct: Writable.of<Record<string, ChatIndexEntry>>({}),
    requests: againRequests,
    outgoingNotices: Writable.of<ChatManagerNotice[]>([]),
  } as ManagerArg);
  const action_hand_over_again = action(() =>
    setup.heldAgain.key("room").set(
      againRequests.key("d-2").key("entry").key("room").resolveAsCell(),
    )
  );

  return {
    [TESTS]: [
      { action: introduce({ me: setup.aliceDid }), event: {} },
      { await: "bob-introduced" },
      {
        action: manager.openDirect,
        event: { requestId: "d-1", counterpart: setup.bobDid },
        trustedUi: startGesture,
      },
      { action: action_hand_over },
      {
        assertion: assert(() => manager.rooms[0]?.counterpart !== undefined),
      },
      {
        action: again.openDirect,
        event: { requestId: "d-2", counterpart: setup.bobDid },
        trustedUi: startGesture,
      },
      { action: action_hand_over_again },
      { assertion: assert(() => again.rooms.length === 1) },
      { label: "alice-created" },
      { await: "bob-done" },
    ],
  };
});

// Accepts the room, with a counterpart that isn't its creator and with none,
// and starts chats with Alice that find rooms listed as hers.
export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const requests = Writable.of<Record<string, ChatRequestOutcome>>({});
  const bobProfile = Writable.of<TestProfile>({ name: "Bob" });
  const catalog = emptyCatalog();
  const manager = FabriChatManagerCore({
    myProfile: bobProfile,
    sharedSpaceCatalog: catalog,
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
  // The room's own control, which sends `accept` with the room alone.
  const adder = AddToChats({
    room: setup.held.key("room"),
    catalog: manager.sharedSpaceCatalog,
    accept: manager.accept,
  } as AddArg);
  const action_add = action(() => clickButton(adder[UI], "Add to my chats"));

  // A manager whose catalog lists the room as a host registers an offered
  // one, without `accept`, so `direct` holds nothing for it.
  const offeredCatalog = emptyCatalog();
  const offeredDirect = Writable.of<Record<string, ChatIndexEntry>>({});
  const offeredRequests = Writable.of<Record<string, ChatRequestOutcome>>({});
  const offered = FabriChatManagerCore({
    myProfile: Writable.of<TestProfile>({ name: "Bob, offered" }),
    sharedSpaceCatalog: offeredCatalog,
    direct: offeredDirect,
    requests: offeredRequests,
    outgoingNotices: Writable.of<ChatManagerNotice[]>([]),
  } as ManagerArg);
  const register = registerSharedSpace({ catalog: offeredCatalog });
  const action_register_offered = action(() =>
    register.send({
      space: spaceOf(setup.held.key("room")) ?? "",
      host: "http://localhost",
      kind: CHAT_ROOM_OFFER_KIND,
      offer: { from: setup.aliceDid.get(), id: "d-1" },
    })
  );
  // Alice's second room, registered as a host registers an offered one, in
  // the catalog of the manager that accepted her first, as admitted later.
  const registerAgain = registerSharedSpace({ catalog });
  const action_register_again = action(() =>
    registerAgain.send({
      space: spaceOf(setup.heldAgain.key("room")) ?? "",
      host: "http://localhost",
      kind: CHAT_ROOM_OFFER_KIND,
      offer: { from: setup.aliceDid.get(), id: "d-2" },
      since: Date.now() + 3_600_000,
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
      // The room isn't listed, so the room offers to add it.
      {
        assertion: assert(() =>
          reasonOf(requests, "a-1") ===
            "The counterpart is not the room's creator." &&
          manager.rooms.length === 0 &&
          Object.keys(readSharedSpaceCatalog(catalog).entries).length === 0 &&
          addDisplay(adder[UI]) === "flex"
        ),
      },
      { action: action_add },
      {
        assertion: assert(() =>
          manager.rooms.length === 1 &&
          manager.rooms[0]?.counterpart === setup.aliceDid.get() &&
          addDisplay(adder[UI]) === "none"
        ),
      },
      // Accepting it registers its space in Bob's catalog, as a saved
      // FabriChat room, from which the manager lists it.
      {
        assertion: assert(() => {
          const entries = Object.values(
            readSharedSpaceCatalog(catalog).entries,
          );
          return entries.length === 1 &&
            entries[0]?.kind === CHAT_ROOM_OFFER_KIND &&
            entries[0]?.state === "saved";
        }),
      },
      // Accepting the room lists Bob among its participants, without a step
      // of his own.
      {
        assertion: assert(() =>
          (setup.held.key("room").get()?.get()?.participants ?? []).some((
            known,
          ) => equals(known, bobProfile))
        ),
      },
      // A room listed only by the catalog names its labeled creator as its
      // counterpart.
      { action: action_register_offered },
      {
        assertion: assert(() =>
          offered.rooms.length === 1 &&
          offered.rooms[0]?.kind === "direct" &&
          offered.rooms[0]?.counterpart === setup.aliceDid.get()
        ),
      },
      // A start with Alice finds that room, creates none, and keeps it in
      // `direct` from then on.
      {
        action: offered.openDirect,
        event: { requestId: "reuse", counterpart: setup.aliceDid },
        trustedUi: startGesture,
      },
      {
        assertion: assert(() => {
          const outcome = offeredRequests.get()["reuse"];
          const space = spaceOf(setup.held.key("room"));
          return space !== undefined && outcome?.status === "done" &&
            spaceOf(outcome.entry?.room) === space &&
            offered.rooms.length === 1 &&
            Object.keys(readSharedSpaceCatalog(offeredCatalog).entries)
                .length === 1 &&
            spaceOf(offeredDirect.get()[setup.aliceDid.get()]?.room) === space;
        }),
      },
      // With a second room of Alice's listed, newest, beside the one `direct`
      // holds, a start with her finds the one `direct` holds.
      { action: action_register_again },
      {
        assertion: assert(() =>
          manager.rooms.length === 2 &&
          spaceOf(manager.rooms[0]?.room) ===
            spaceOf(setup.heldAgain.key("room")) &&
          manager.rooms.every((entry) =>
            entry.counterpart === setup.aliceDid.get()
          )
        ),
      },
      {
        action: manager.openDirect,
        event: { requestId: "direct-wins", counterpart: setup.aliceDid },
        trustedUi: startGesture,
      },
      {
        assertion: assert(() => {
          const outcome = requests.get()["direct-wins"];
          const space = spaceOf(setup.held.key("room"));
          return space !== undefined && outcome?.status === "done" &&
            spaceOf(outcome.entry?.room) === space &&
            manager.rooms.length === 2 &&
            Object.keys(readSharedSpaceCatalog(catalog).entries).length === 2;
        }),
      },
      { label: "bob-done" },
    ],
  };
});

export default multiUserTest({ setup, participants: { alice, bob } });
