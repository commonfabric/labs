/**
 * Who is reading a FabriChat room, as a client that draws natively reads it
 * from the room's views: the reader's profile, as a link to the profile in the
 * form each message's `authorProfile` takes, the principal it attests, and
 * the reader's access; and what the reader may do to each message. Each
 * person reaches their profile through a link of its own, as a `#profile`
 * wish's result is. Reading through the runtime follows that link either way,
 * so what this checks is the document each link names, not the stored form
 * of the link.
 */
import {
  action,
  assert,
  type Cell,
  currentPrincipal,
  equals,
  getEntityId,
  handler,
  multiUserTest,
  pattern,
  type RepresentsCurrentUser,
  TESTS,
  type TrustedActionWrite,
  valueEqual,
  VIEWS,
  Writable,
} from "commonfabric";
import { type MessageRecord, type MessagesValue } from "./room-records.tsx";
import { type ChatMessageRights, FabriChatRoomCore } from "./room.tsx";
import {
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  type ChatProfile,
} from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];

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

/** A link to a person's profile, as a `#profile` wish's result holds one. */
interface ProfilePointer {
  /** The profile; absent until it is pointed at. */
  profile?: Writable<ChatProfile>;
}

const sendGesture = { surface: CHAT_SEND_SURFACE, action: CHAT_SEND_ACTION };

const typed = (text: string) => ({ type: "click", target: { value: text } });

/** The room's records, which every participant's room shares. */
interface Records {
  messages: Writable<MessagesValue>;
}

/** What every session receives from the setup. */
interface Setup {
  records: Records;
}

export const setup = pattern(() => ({
  records: {
    messages: Writable.of<MessagesValue>([] as MessagesValue),
  },
}));

// Whether two links name the same document, compared as a client compares
// them: by the entity each names, with no link followed past it.
const sameEntity = (a: unknown, b: unknown): boolean => {
  const first = getEntityId(a);
  return first !== undefined && valueEqual(first, getEntityId(b));
};

// The stored message at `index` of `messages`.
const messageAt = (
  messages: Cell<MessagesValue>,
  index: number,
): MessageRecord | undefined =>
  ((messages.get() ?? []) as MessageRecord[])[index];

// The view's rights for the message at `index` of `messages`.
const rightsAt = (
  rights: readonly ChatMessageRights[],
  messages: Cell<MessagesValue>,
  index: number,
): ChatMessageRights | undefined =>
  rights.find((entry) => equals(entry.message, messages.key(index)));

// The OWNER, who sends first.
export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<OwnProfile>();
  const pointer = Writable.of<ProfilePointer>({});
  const action_point = action(() => pointer.key("profile").set(profile));
  const writeProfile = writeOwnProfile({ profile, name: "Alice" });
  const did = Writable.of<string>("");
  const action_note_principal = action(() => did.set(currentPrincipal() ?? ""));
  const room = FabriChatRoomCore({
    myProfile: pointer.key("profile"),
    about: { kind: "group" as const, title: "Team" },
    messages: setup.records.messages,
  } as RoomArg);

  return {
    [TESTS]: [
      { action: writeProfile, event: {}, trustedUi: profileGesture },
      { action: action_point },
      { action: action_note_principal },
      {
        action: room.composerSend,
        event: typed("From Alice"),
        trustedUi: sendGesture,
      },
      { label: "alice-sent" },
      { await: "bob-sent" },
      // The view's profile names the document her message's `authorProfile`
      // names, and not the pointer she reaches it through, as read.
      {
        assertion: assert(() =>
          sameEntity(
            room[VIEWS].room.viewer.profile,
            messageAt(setup.records.messages, 0)?.authorProfile,
          ) && !sameEntity(room[VIEWS].room.viewer.profile, pointer)
        ),
      },
      {
        assertion: assert(() =>
          !sameEntity(
            room[VIEWS].room.viewer.profile,
            messageAt(setup.records.messages, 1)?.authorProfile,
          )
        ),
      },
      {
        assertion: assert(() =>
          did.get() !== "" &&
          room[VIEWS].room.viewer.principal === did.get() &&
          room[VIEWS].room.viewer.role === "OWNER"
        ),
      },
      // As an OWNER of a group room she may obliterate Bob's message, but
      // edit and delete only her own.
      {
        assertion: assert(() => {
          const rights = room[VIEWS].room.messageRights;
          const hers = rightsAt(rights, setup.records.messages, 0);
          const his = rightsAt(rights, setup.records.messages, 1);
          return rights.length === 2 && hers?.canEdit === true &&
            hers?.canDelete === true && hers?.canObliterate === true &&
            his?.canEdit === false && his?.canDelete === false &&
            his?.canObliterate === true;
        }),
      },
      { label: "alice-done" },
    ],
  };
});

// A member with WRITE, the default.
export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<OwnProfile>();
  const pointer = Writable.of<ProfilePointer>({});
  const action_point = action(() => pointer.key("profile").set(profile));
  const writeProfile = writeOwnProfile({ profile, name: "Bob" });
  const did = Writable.of<string>("");
  const action_note_principal = action(() => did.set(currentPrincipal() ?? ""));
  const room = FabriChatRoomCore({
    myProfile: pointer.key("profile"),
    about: { kind: "group" as const, title: "Team" },
    messages: setup.records.messages,
  } as RoomArg);

  return {
    [TESTS]: [
      { action: writeProfile, event: {}, trustedUi: profileGesture },
      { action: action_point },
      { action: action_note_principal },
      { await: "alice-sent" },
      {
        action: room.composerSend,
        event: typed("From Bob"),
        trustedUi: sendGesture,
      },
      // His view's profile is his message's author, and the room's own
      // output carries the same.
      {
        assertion: assert(() =>
          sameEntity(
            room[VIEWS].room.viewer.profile,
            messageAt(setup.records.messages, 1)?.authorProfile,
          ) &&
          equals(
            room.viewer.profile,
            messageAt(setup.records.messages, 1)?.authorProfile,
          )
        ),
      },
      {
        assertion: assert(() =>
          did.get() !== "" &&
          room[VIEWS].room.viewer.principal === did.get() &&
          room[VIEWS].room.viewer.role === "WRITE"
        ),
      },
      // Without OWNER he may edit and delete only his own message, and
      // obliterate none in a group room.
      {
        assertion: assert(() => {
          const rights = room[VIEWS].room.messageRights;
          const hers = rightsAt(rights, setup.records.messages, 0);
          const his = rightsAt(rights, setup.records.messages, 1);
          return hers?.canEdit === false && hers?.canDelete === false &&
            hers?.canObliterate === false && his?.canEdit === true &&
            his?.canDelete === true && his?.canObliterate === false;
        }),
      },
      { label: "bob-sent" },
      { await: "alice-done" },
    ],
  };
});

export default multiUserTest({ setup, participants: { alice, bob } });
