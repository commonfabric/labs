/**
 * A FabriChat room's files: a room that is its space's root and has a store
 * offers a control that opens the store's view for the session that presses
 * it, and a room with none, or one that isn't its space's root, offers no such
 * control. Until a session opens it, the room holds no view,
 * and shows none of the store's entries, though the store has one. Opened, the
 * view lists the entry, with its controls for an OWNER, who may change every
 * entry, and without them for a member who didn't add it. The store here
 * answers nothing, since what the room shows is what these tests are about,
 * and it is the store, not the room, that decides what a request does.
 */
import {
  action,
  assert,
  type Cell,
  computed,
  handler,
  multiUserTest,
  pattern,
  TESTS,
  UI,
  VIEWS,
  Writable,
} from "commonfabric";
import {
  type AddFileEvent,
  epochNsecFromMsec,
  type FileEntry,
  type FileProfile,
  type FileStoreOutput,
  type RemoveFileEvent,
  type RenameFileEvent,
} from "../fabrifile/schemas.tsx";
import type { FileStoreRecord } from "../fabrifile/store.tsx";
import {
  countElements,
  findNodeById,
  findNodes,
  propValue,
  readValue,
} from "../../tools/test-support/vnode-helpers.ts";
import type { MessagesValue } from "./room-records.tsx";
import { FabriChatRoomCore, type FabriChatRoomCoreOutput } from "./room.tsx";
import type { ChatProfile } from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];

const SPACE = "did:key:z6Mk-fabrichat-room-files";

/** Answers nothing; the room's rendering is what these tests are about. */
const ignoreAdd = handler<AddFileEvent, Record<string, never>>(() => {});
const ignoreRemove = handler<RemoveFileEvent, Record<string, never>>(() => {});
const ignoreRename = handler<RenameFileEvent, Record<string, never>>(() => {});

/** A store whose entries are `list`'s, and whose streams answer nothing. */
const StandInStore = pattern<{ list: Writable<FileEntry[]> }, FileStoreOutput>(
  ({ list }) => {
    const files = {
      entries: computed((): Cell<FileEntry>[] =>
        list.get().map((_, i) => list.key(i))
      ),
      byName: {},
      requests: {},
      add: ignoreAdd({}),
      remove: ignoreRemove({}),
      rename: ignoreRename({}),
    };
    return { ...files, [VIEWS]: { files } };
  },
);

/** The entries everyone in the space shares. */
interface Setup {
  list: Writable<FileEntry[]>;
}

export const setup = pattern(() => ({
  list: Writable.of<FileEntry[]>([]),
}));

/** A room that is its space's root, keeping its store in `record`. */
const RootRoom = pattern<
  { record: Writable<FileStoreRecord> },
  FabriChatRoomCoreOutput
>(({ record }) =>
  FabriChatRoomCore({
    myProfile: Writable.of<ChatProfile>({ name: "Viewer" }),
    about: { kind: "group" as const, title: "Team" },
    messages: Writable.of<MessagesValue>([] as MessagesValue),
    fileStore: record,
  } as RoomArg)
);

/** A room that isn't its space's root, whose root is `container`. */
const InnerRoom = pattern<
  { container: FabriChatRoomCoreOutput },
  FabriChatRoomCoreOutput
>(({ container }) =>
  FabriChatRoomCore({
    myProfile: Writable.of<ChatProfile>({ name: "Viewer" }),
    container,
    messages: Writable.of<MessagesValue>([] as MessagesValue),
    fileStore: Writable.of<FileStoreRecord>({}),
  } as RoomArg)
);

/** Every node under `root` whose `className` is `name`. */
const withClass = (root: unknown, name: string): unknown[] =>
  findNodes(root, (node) => readValue(propValue(node, "className")) === name);

/**
 * The store views under `root`: one per add control a view renders, which it
 * renders for every viewer, whether or not that viewer is offered it.
 */
const viewCount = (root: unknown): number =>
  withClass(root, "fabrifile-add").length;

/** The entries a view under `root` lists, one link to each. */
const rowCount = (root: unknown): number => countElements(root, "cf-blob-link");

/** How each node under `root` whose `className` is `name` is displayed. */
const displays = (root: unknown, name: string): string =>
  withClass(root, name).map((node) =>
    readValue((propValue(node, "style") as { display?: unknown }).display)
  ).join(",");

/** How the room's files control is displayed. */
const toggleDisplay = (root: unknown): unknown =>
  readValue(
    (propValue(findNodeById(root, "fabrichat-files-toggle"), "style") as {
      display?: unknown;
    }).display,
  );

export const owner = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<FileProfile>({ name: "Owen" });
  const record = Writable.of<FileStoreRecord>({});
  const room = RootRoom({ record });
  const store = StandInStore({ list: setup.list });
  // A room that is its space's root and keeps no store.
  const bare = RootRoom({ record: Writable.of<FileStoreRecord>({}) });
  // A room whose space's root is `room`, which uses `room`'s store.
  const inner = InnerRoom({ container: room });

  return {
    [TESTS]: [
      { action: action(() => record.key("store").set(store)) },
      {
        action: action(() => {
          setup.list.push({
            name: "photo.png",
            mediaType: "image/png",
            blob: { space: SPACE, id: "fid1:photo" },
            size: 4,
            addedAt: epochNsecFromMsec(0),
            addedBy: profile,
          });
        }),
      },
      { label: "seeded" },

      // A room with no store offers no files control.
      { assertion: assert(() => toggleDisplay(bare[UI]) === "none") },

      // Nor does a room that isn't its space's root, though it uses the
      // root's store, whose files are the root's to show.
      {
        assertion: assert(() =>
          inner.fileStore?.key("entries").get()?.length === 1
        ),
      },
      { assertion: assert(() => toggleDisplay(inner[UI]) === "none") },

      // Unopened, the room holds no view, and lists none of the entries.
      { assertion: assert(() => toggleDisplay(room[UI]) === "block") },
      { assertion: assert(() => viewCount(room[UI]) === 0) },
      { assertion: assert(() => rowCount(room[UI]) === 0) },

      // Opened, it lists the entry, with the controls an OWNER is offered.
      { press: room[UI], control: "Files" },
      { assertion: assert(() => viewCount(room[UI]) === 1) },
      { assertion: assert(() => rowCount(room[UI]) === 1) },
      {
        assertion: assert(() =>
          displays(room[UI], "fabrifile-remove") === "block"
        ),
      },
      {
        assertion: assert(() =>
          displays(room[UI], "fabrifile-rename") === "block"
        ),
      },

      // Closed again, it holds no view.
      { press: room[UI], control: "Hide files" },
      { assertion: assert(() => viewCount(room[UI]) === 0) },
      { assertion: assert(() => rowCount(room[UI]) === 0) },
    ],
  };
});

export const member = pattern<{ setup: Setup }>(({ setup }) => {
  const record = Writable.of<FileStoreRecord>({});
  const room = RootRoom({ record });
  const store = StandInStore({ list: setup.list });

  return {
    [TESTS]: [
      { action: action(() => record.key("store").set(store)) },
      { await: "seeded" },

      { assertion: assert(() => viewCount(room[UI]) === 0) },
      { assertion: assert(() => rowCount(room[UI]) === 0) },

      // Opened, it lists the entry another person added, without the
      // controls that change it, and with the one that adds a file.
      { press: room[UI], control: "Files" },
      { assertion: assert(() => rowCount(room[UI]) === 1) },
      {
        assertion: assert(() =>
          displays(room[UI], "fabrifile-remove") === "none"
        ),
      },
      {
        assertion: assert(() =>
          displays(room[UI], "fabrifile-rename") === "none"
        ),
      },
      {
        assertion: assert(() =>
          displays(room[UI], "fabrifile-add") === "block"
        ),
      },
    ],
  };
});

export default multiUserTest({
  setup,
  participants: { owner, member },
});
