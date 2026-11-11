/**
 * A manager consumes original display records through a retained descriptor.
 * No room producer runs in this fixture: old writers can change those records
 * while the descriptor's copied facts stay stale. Removing or replacing the
 * descriptor restores the legacy path or follows the replacement.
 */
import {
  action,
  assert,
  type Cell,
  equals,
  handler,
  NAME,
  pattern,
  type RepresentsCurrentUser,
  TESTS,
  UI,
  Writable,
  type WriteAuthorizedBy,
} from "commonfabric";
import {
  findNode,
  propsOf,
  readValue,
} from "../../tools/test-support/vnode-helpers.ts";
import { FabriChatManagerCore } from "./manager.tsx";
import { TITLE_KEY } from "./room-records.tsx";
import {
  type AboutRecord,
  type ChatIndexEntry,
  type ChatManagerNotice,
  type ChatManagerProfile,
  type ChatRequestOutcome,
  type ChatRoomIndexLink,
  type ChatRoomLink,
  type ChatRoomMetadata,
  type ChatRoomPolicy,
  epochNsecFromMsec,
  type ProfileCell,
  type TitleRecord,
} from "./schemas.tsx";
import type { SharedSpaceCatalogStorage } from "../shared-space/shared-space-catalog.ts";

/** The profile's one writer supplies its current-principal label. */
type OwnProfile = RepresentsCurrentUser<
  WriteAuthorizedBy<ChatManagerProfile, typeof writeProfile>
>;

/** The profile written by its acting principal. */
interface ProfileWriteState {
  profile: Writable<OwnProfile>;
  inbox: Cell<{ [NAME]?: string }>;
}

/** Writes a profile whose label attests the acting person. */
const writeProfile = handler<void, ProfileWriteState>(
  (_, { profile, inbox }) => {
    profile.set({ name: "Member", inbox: { piece: inbox } });
  },
);

/** The label carried by the manager's room navigation control. */
const roomLabel = (view: unknown): unknown =>
  readValue(
    propsOf(findNode(
      view,
      (node) =>
        readValue((node as { name?: unknown })?.name) === "cf-cell-link",
    ))?.label,
  );

export default pattern(() => {
  const about = Writable.of<AboutRecord>({ kind: "group", title: "Original" });
  const titles = Writable.of<TitleRecord[]>([]);
  const roster = Writable.of<{ items?: ProfileCell[] }>({});
  const profile = new Writable<OwnProfile>();
  const inbox = Writable.of<{ [NAME]?: string }>({ [NAME]: "Member inbox" });
  const metadata = new Writable<ChatRoomMetadata>();
  const room = new Writable<ChatRoomIndexLink>();
  const policy = new Writable<ChatRoomPolicy>();
  const absentRoom = new Writable<ChatRoomLink>();
  const requests = Writable.of<Record<string, ChatRequestOutcome>>({});
  const replacementAbout = Writable.of<AboutRecord>({
    kind: "group",
    title: "Replacement",
  });
  const replacement = new Writable<ChatRoomMetadata>();
  const uninitialized = new Writable<ChatRoomMetadata>();
  const setup = action(() => {
    requests.set({
      pending: { status: "pending" },
      refused: {
        status: "refused",
        reason: "Missing declaration",
        code: "space-own-chat",
      },
      historical: {
        status: "done",
        delivery: "noticed",
        entry: { room: absentRoom, kind: "group", since: epochNsecFromMsec(1) },
      },
    });
    metadata.set({
      kind: "group",
      title: "Stale copied title",
      roster: [],
      sources: { about, titles, roster },
    });
    room.set({
      about: { kind: "group", title: "Legacy title", record: about, policy },
      roster: [],
      metadata,
    });
    replacement.set({
      kind: "group",
      roster: [],
      sources: { about: replacementAbout },
    });
  });
  const manager = FabriChatManagerCore({
    myProfile: undefined,
    sharedSpaceCatalog: Writable.of<SharedSpaceCatalogStorage>({
      entries: {
        "did:key:z6MkBob": {
          space: "did:key:z6MkBob",
          host: "https://example.test",
          kind: "project",
          state: "archived",
          revision: "catalog-hint",
          title: "Catalog hint",
        },
      },
      offers: {},
    }),
    direct: Writable.of<Record<string, ChatIndexEntry>>({}),
    requests,
    outgoingNotices: Writable.of<ChatManagerNotice[]>([]),
  });
  const rename = action(() => {
    titles.elementById(TITLE_KEY).set({ title: "Old writer retitled" });
    roster.key("items").set([profile]);
  });
  const removeDescriptor = action(() => room.key("metadata").set(undefined));
  const useUninitialized = action(() =>
    room.key("metadata").set(uninitialized)
  );
  const initializeDescriptor = action(() =>
    uninitialized.set({
      kind: "group",
      roster: [],
      sources: { about: replacementAbout },
    })
  );
  const replaceDescriptor = action(() => room.key("metadata").set(replacement));

  return {
    [TESTS]: [
      { action: writeProfile({ profile, inbox }) },
      { action: setup },
      { action: manager.joinRoom, event: { room, requestId: "join" } },
      {
        assertion: assert(() =>
          manager.rooms.length === 1 &&
          equals(manager.list?.rooms[0]?.metadata, metadata) &&
          equals(manager.list?.rooms[0]?.room, room) &&
          manager.list?.rooms[0]?.title === "Original" &&
          manager.list?.sharedSpaceCatalog.entries["did:key:z6MkBob"]?.kind ===
            "project" &&
          manager.list?.sharedSpaceCatalog.entries["did:key:z6MkBob"]?.title ===
            "Catalog hint" &&
          Object.keys(
              manager.list?.sharedSpaceCatalog.entries["did:key:z6MkBob"] ?? {},
            ).length === 2 &&
          !("offers" in (manager.list?.sharedSpaceCatalog ?? {})) &&
          manager.list?.requests.pending?.status === "pending" &&
          manager.list?.requests.refused?.status === "refused" &&
          manager.list?.requests.refused.reason === "Missing declaration" &&
          manager.list?.requests.refused.code === "space-own-chat" &&
          manager.list?.requests.historical?.status === "done" &&
          manager.list?.requests.historical.delivery === "noticed" &&
          equals(manager.list?.requests.historical.entry?.room, absentRoom) &&
          manager.requests.join?.status === "done" &&
          manager.list?.requests.join?.status === "done" &&
          equals(manager.list?.requests.join.entry?.room, room) &&
          roomLabel(manager[UI]) === "Original" &&
          Object.keys(manager.people).length === 0
        ),
      },
      { action: rename },
      {
        assertion: assert(() =>
          metadata.get().title === "Stale copied title" &&
          metadata.get().roster.length === 0 &&
          roomLabel(manager[UI]) === "Old writer retitled" &&
          manager.list?.rooms[0]?.title === "Old writer retitled" &&
          Object.keys(manager.people).length === 1 &&
          equals(Object.values(manager.people)[0]?.[0], profile) &&
          equals(
            Object.values(manager.people)[0]?.[0].key("inbox").get()?.piece,
            inbox,
          )
        ),
      },
      { action: removeDescriptor },
      {
        assertion: assert(() =>
          manager.list?.rooms[0]?.metadata === undefined &&
          manager.list?.rooms[0]?.title === "Legacy title" &&
          roomLabel(manager[UI]) === "Legacy title" &&
          Object.keys(manager.people).length === 0
        ),
      },
      { action: useUninitialized },
      {
        assertion: assert(() =>
          manager.rooms.length === 1 &&
          manager.list?.rooms[0]?.metadata === undefined &&
          manager.list?.rooms[0]?.title === "Legacy title" &&
          roomLabel(manager[UI]) === "Legacy title"
        ),
      },
      { action: initializeDescriptor },
      {
        assertion: assert(() =>
          equals(manager.list?.rooms[0]?.metadata, uninitialized) &&
          manager.list?.rooms[0]?.title === "Replacement" &&
          roomLabel(manager[UI]) === "Replacement"
        ),
      },
      { action: replaceDescriptor },
      {
        assertion: assert(() =>
          equals(manager.list?.rooms[0]?.metadata, replacement) &&
          manager.list?.rooms[0]?.title === "Replacement" &&
          roomLabel(manager[UI]) === "Replacement" &&
          Object.keys(manager.people).length === 0
        ),
      },
    ],
  };
});
