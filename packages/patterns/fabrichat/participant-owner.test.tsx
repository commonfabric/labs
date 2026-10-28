/**
 * A room names a participant by whose own profile theirs is, by the rule every
 * reader of a person's profiles applies (`profileOwnerOf()`), as `#profile`
 * does. A profile of the person's own whose `name` links to the name of another
 * profile of theirs names no one: its label names them, but its name is
 * borrowed from outside its own documents. Reading only whom its label
 * represents would take it for theirs.
 */
import {
  action,
  assert,
  computed,
  currentPrincipal,
  handler,
  pattern,
  principalOf,
  type RepresentsCurrentUser,
  TESTS,
  type TrustedActionWrite,
  UI,
  VIEWS,
  Writable,
} from "commonfabric";
import {
  findNode,
  isButton,
  propValue,
  readValue,
} from "../test/vnode-helpers.ts";
import { testRoomStorage } from "./room-test-fixture.ts";
import { FabriChatRoomCore, participantEntriesOf } from "./room.tsx";

/** The display of a room's first message-edit control. */
const editDisplay = (ui: unknown): unknown => {
  const style = propValue(findNode(ui, isButton("Edit")), "style");
  return readValue((style as { display?: unknown } | undefined)?.display);
};

/** The reviewed surface and action a person writes their own profile from. */
const PROFILE_SURFACE = "FabriChatTestProfileSurface";
const PROFILE_ACTION = "FabriChatTestWriteProfile";

/** The gesture writing a profile takes. */
const profileGesture = { surface: PROFILE_SURFACE, action: PROFILE_ACTION };

/**
 * A person's own profile, labeled with the principal who wrote it, which only
 * `writeNamedProfile` writes, from its reviewed surface.
 */
type NamedProfile = RepresentsCurrentUser<
  TrustedActionWrite<
    { name: string },
    typeof writeNamedProfile,
    typeof PROFILE_ACTION,
    typeof PROFILE_SURFACE
  >
>;

/** What `writeNamedProfile` is bound to. */
interface NamedProfileWriteState {
  /** The profile to write. */
  profile: Writable<NamedProfile>;

  /** The name to write into it. */
  name: string;
}

/** Writes the acting person's `NamedProfile`, under `name`. */
const writeNamedProfile = handler<unknown, NamedProfileWriteState>((
  _event,
  { profile, name },
) => {
  profile.set({ name });
});

/**
 * A person's own profile, as `NamedProfile` is, whose `name` holds a link,
 * which only `writeBorrowingProfile` writes, from the same reviewed surface.
 */
type BorrowingProfile = RepresentsCurrentUser<
  TrustedActionWrite<
    { name?: string },
    typeof writeBorrowingProfile,
    typeof PROFILE_ACTION,
    typeof PROFILE_SURFACE
  >
>;

/** What `writeBorrowingProfile` is bound to. */
interface BorrowingProfileWriteState {
  /** The profile to write. */
  profile: Writable<BorrowingProfile>;

  /** The name, in another document, that its `name` is to link. */
  name: Writable<string>;
}

/** Writes the acting person's `BorrowingProfile`, its `name` linking `name`. */
const writeBorrowingProfile = handler<unknown, BorrowingProfileWriteState>((
  _event,
  { profile, name },
) => {
  profile.set({ name });
});

export default pattern(() => {
  const named = Writable.of<NamedProfile>();
  const writeNamed = writeNamedProfile({ profile: named, name: "Ada" });
  const borrowing = Writable.of<BorrowingProfile>();
  const writeBorrowing = writeBorrowingProfile({
    profile: borrowing,
    name: named.key("name"),
  });
  const me = new Writable("");
  const recordMe = action(() => me.set(currentPrincipal() ?? ""));
  const principals = computed(() =>
    participantEntriesOf([named, borrowing]).map((entry) => entry.principal)
  );
  const records = testRoomStorage({});
  const ownRoom = FabriChatRoomCore({
    myProfile: named,
    messages: records.messages,
    about: { kind: "direct" },
  });
  const borrowedRoom = FabriChatRoomCore({
    myProfile: borrowing,
    messages: records.messages,
    about: { kind: "direct" },
  });
  return {
    [TESTS]: [
      { action: recordMe },
      { action: writeNamed, event: {}, trustedUi: profileGesture },
      { action: writeBorrowing, event: {}, trustedUi: profileGesture },
      // Both labels name the person, and the borrowed name is their own.
      {
        assertion: assert(() =>
          me.get() !== "" &&
          principalOf(borrowing, "represents-principal") === me.get()
        ),
      },
      {
        assertion: assert(() =>
          principals[0] === me.get() && principals[1] === undefined
        ),
      },
      {
        action: ownRoom.sendMessage,
        event: { body: "My message" },
        trustedUi: { surface: "ChatSendSurface", action: "ChatSend" },
      },
      {
        assertion: assert(() =>
          ownRoom[VIEWS].room.viewer.principal === me.get() &&
          ownRoom[VIEWS].room.messageRights[0]?.canEdit === true &&
          editDisplay(ownRoom[UI]) === "inline-flex"
        ),
      },
      {
        assertion: assert(() =>
          borrowedRoom[VIEWS].room.viewer.principal === undefined &&
          borrowedRoom[VIEWS].room.messageRights[0]?.canEdit === false &&
          borrowedRoom[VIEWS].room.messageRights[0]?.canDelete === false &&
          borrowedRoom[VIEWS].room.messageRights[0]?.canObliterate === false &&
          editDisplay(borrowedRoom[UI]) === "none"
        ),
      },
    ],
  };
});
