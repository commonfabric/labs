/**
 * Starting a direct chat from a FabriChat room's participants. A participant
 * other than the viewer, whose profile attests a principal, offers a chat, and
 * starting one asks the viewer's manager for a direct room with that
 * principal. Each person writes their own profile here, so its label names
 * them, as a Fabric profile's does.
 */
import {
  action,
  type AddIntegrity,
  assert,
  type Cell,
  currentPrincipal,
  equals,
  FabricEpochNsec,
  handler,
  multiUserTest,
  pattern,
  principalOf,
  type RepresentsCurrentUser,
  TESTS,
  type TrustedActionWrite,
  UI,
  Writable,
} from "commonfabric";
import type { SharedSpaceCatalogStorage } from "../system/shared-space-catalog.ts";
import {
  findElement,
  findNodeById,
  findNodeByProp,
  propValue,
  readValue,
} from "../test/vnode-helpers.ts";
import { FabriChatManagerCore } from "./manager.tsx";
import { testRoomAbout, testRoomStorage } from "./room-test-fixture.ts";
import type { StoredActivity, StoredMemory, StoredMessage } from "./room.tsx";
import type { ParticipantRosterCell } from "../loom/participants.tsx";
import { FabriChatRoom } from "./room.tsx";
import { ParticipantChip } from "./participant.tsx";
import {
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  CHAT_START_ACTION,
  CHAT_START_SURFACE,
  type ChatIndexEntry,
  type ChatProfile,
  type ChatRequestOutcome,
  type ChatRoomLink,
} from "./schemas.tsx";

type ManagerArg = Parameters<typeof FabriChatManagerCore>[0];

/** An empty shared-space catalog, as a manager lists its rooms from. */
const emptyCatalog = () =>
  Writable.of<SharedSpaceCatalogStorage>({ entries: {}, offers: {} });
type ChipArg = Parameters<typeof ParticipantChip>[0];

/** The reviewed surface and action a person writes their own profile from. */
const PROFILE_SURFACE = "FabriChatTestProfileSurface";
const PROFILE_ACTION = "FabriChatTestWriteProfile";

/** The gesture writing a profile takes. */
const profileGesture = { surface: PROFILE_SURFACE, action: PROFILE_ACTION };

/**
 * A person's own profile, labeled with the principal who wrote it, which only
 * `writeOwnProfile` writes, from its reviewed surface.
 */
type OwnProfile = RepresentsCurrentUser<
  TrustedActionWrite<
    ChatProfile,
    typeof writeOwnProfile,
    typeof PROFILE_ACTION,
    typeof PROFILE_SURFACE
  >
>;

/** What `writeOwnProfile` is bound to. */
interface ProfileWriteState {
  /** The profile to write. */
  profile: Writable<OwnProfile>;

  /** The name to write into it. */
  name: string;
}

/** Writes the acting person's own profile, under `name`. */
const writeOwnProfile = handler<unknown, ProfileWriteState>((
  _event,
  { profile, name },
) => {
  profile.set({ name } as OwnProfile);
});

/** A profile whose label names no principal. */
type UnclaimedProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

const sendGesture = { surface: CHAT_SEND_SURFACE, action: CHAT_SEND_ACTION };
const startGesture = { surface: CHAT_START_SURFACE, action: CHAT_START_ACTION };

// How a chip shows its chat control.
const chatDisplay = (chip: unknown): unknown =>
  readValue(
    (propValue(
      findNodeByProp(chip, "data-ui-pattern", CHAT_START_SURFACE),
      "style",
    ) as { display?: unknown })?.display,
  );

// The profile a chip binds as its chat control's name.
const chatNamed = (chip: unknown): object | undefined => {
  const named = propValue(
    findNodeByProp(chip, "data-ui-action", CHAT_START_ACTION),
    "$name",
  );
  return typeof named === "object" && named !== null ? named : undefined;
};

// The stream a chip's chat control sends its click to.
const chatTarget = (chip: unknown): object | undefined => {
  const target = propValue(
    findNodeByProp(chip, "data-ui-action", CHAT_START_ACTION),
    "onClick",
  );
  return typeof target === "object" && target !== null ? target : undefined;
};

// How a manager shows its user's chat address, and the address it offers to
// copy.
const addressShown = (root: unknown): unknown =>
  propValue(
    findElement(findNodeById(root, "fabrichat-my-address"), "cf-copy-button"),
    "text",
  );

/** The room's records, which every participant's room shares. */
export interface Records {
  records: Writable<StoredMessage[]>;
  memory: Writable<StoredMemory>;
  activity: Writable<StoredActivity[]>;
  roster: ParticipantRosterCell;
}

/** What every session receives from the setup. */
export interface Setup {
  records: Records;

  /** Alice's principal, as her own run of a handler finds it. */
  aliceDid: Writable<string>;
}

export const setup = pattern<Record<string, never>, Setup>(() => ({
  records: testRoomStorage({}),
  aliceDid: Writable.of<string>(""),
}));

// Writes her profile, notes her principal, and sends a message, which makes
// her one of the room's participants.
export const alice = pattern<{ setup: Setup }>(
  ({ setup }) => {
    const profile = Writable.of<OwnProfile>();
    const writeProfile = writeOwnProfile({ profile, name: "Alice" });
    const action_note_principal = action(() =>
      setup.aliceDid.set(currentPrincipal() ?? "")
    );
    const version = new Writable({
      body: "Hello from Alice",
      sentAt: new FabricEpochNsec(0n),
    });
    const initializeVersion = action(() =>
      version.key("sentAt").set(
        new FabricEpochNsec(BigInt(Date.now()) * 1_000_000n),
      )
    );
    const description = testRoomAbout({ kind: "group", standalone: false });
    const room = FabriChatRoom({
      myProfile: profile,
      about: description.about,
      records: setup.records.records,
      memory: setup.records.memory,
      activity: setup.records.activity,
      roster: setup.records.roster,
    });

    return {
      [TESTS]: [
        { action: writeProfile, event: {}, trustedUi: profileGesture },
        { action: description.initialize },
        { action: initializeVersion },
        { render: room[UI] },
        { action: action_note_principal },
        {
          action: room.sendMessage,
          event: { requestId: "first", version },
          trustedUi: sendGesture,
        },
        { label: "alice-sent" },
        { await: "bob-done" },
      ],
    };
  },
);

// Has a manager, and finds a chat offered with Alice alone.
export const bob = pattern<{ setup: Setup }>(
  ({ setup }) => {
    const profile = Writable.of<OwnProfile>();
    const unclaimed = Writable.of<UnclaimedProfile>({ name: "Nobody" });
    const writeProfile = writeOwnProfile({ profile, name: "Bob" });
    const requests = Writable.of<Record<string, ChatRequestOutcome>>({});
    const bobDid = Writable.of<string>("");
    const action_note_principal = action(() =>
      bobDid.set(currentPrincipal() ?? "")
    );
    const manager = FabriChatManagerCore({
      myProfile: profile,
      sharedSpaceCatalog: emptyCatalog(),
      direct: Writable.of<Record<string, ChatIndexEntry>>({}),
      requests,
      outgoingNotices: Writable.of<
        { id: string; room: Cell<ChatRoomLink>; recipient: string }[]
      >([]),
    } as ManagerArg);
    const chipFor = {
      myProfile: profile,
      startDirect: manager.openDirect,
    };
    // Alice's profile, reached as the room reaches it: through her message.
    const aliceProfile = setup.records.records.key(0).key("authorProfile");
    const aliceChip = ParticipantChip({
      participant: aliceProfile,
      ...chipFor,
    } as ChipArg);
    const ownChip = ParticipantChip(
      { participant: profile, ...chipFor } as ChipArg,
    );
    const unclaimedChip = ParticipantChip(
      { participant: unclaimed, ...chipFor } as ChipArg,
    );

    return {
      [TESTS]: [
        { action: writeProfile, event: {}, trustedUi: profileGesture },
        { action: action_note_principal },
        // Bob's manager offers his chat address, which his profile attests, to
        // read and to copy.
        {
          assertion: assert(() =>
            bobDid.get() !== "" &&
            addressShown(manager[UI]) === bobDid.get()
          ),
        },
        { await: "alice-sent" },
        // The room's activity entry for Alice's message names her as its
        // author, as her own message does.
        {
          assertion: assert(() =>
            setup.aliceDid.get() !== "" &&
            principalOf(setup.records.activity.key(0), "authored-by") ===
              setup.aliceDid.get()
          ),
        },
        {
          assertion: assert(() =>
            chatDisplay(aliceChip[UI]) === "inline-flex" &&
            chatDisplay(ownChip[UI]) === "none" &&
            chatDisplay(unclaimedChip[UI]) === "none"
          ),
        },
        // Alice's chip names her by her profile, and its
        // click is the viewer's reviewed start, sent to the manager itself.
        {
          assertion: assert(() =>
            equals(chatNamed(aliceChip[UI]), aliceProfile) &&
            equals(chatTarget(aliceChip[UI]), manager.openDirect)
          ),
        },
        {
          action: manager.openDirect,
          event: { type: "click", target: { name: aliceProfile } },
          trustedUi: startGesture,
        },
        {
          assertion: assert(() =>
            manager.rooms.length === 1 && manager.rooms[0]?.kind === "direct" &&
            manager.rooms[0]?.counterpart === setup.aliceDid.get() &&
            setup.aliceDid.get() !== ""
          ),
        },
        // A deployed chip that names only her principal finds the same room.
        {
          action: manager.openDirect,
          event: {
            requestId: "older-chip",
            type: "click",
            target: { dataset: { counterpart: setup.aliceDid } },
          },
          trustedUi: startGesture,
        },
        {
          assertion: assert(() =>
            requests.get()["older-chip"]?.status === "done" &&
            manager.rooms.length === 1
          ),
        },
        { label: "bob-done" },
      ],
    };
  },
);

export default multiUserTest({ setup, participants: { alice, bob } });
