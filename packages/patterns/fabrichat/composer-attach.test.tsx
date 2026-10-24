/**
 * A FabriChat room's composer attaching files: the attach control adds each
 * file it stored to the space's store and lists it, a send attaches the files
 * the store added and leaves out any it refused, and a file can be taken out
 * before the send. A send waits while a file is still being added, a change
 * attaching more than the room's policy allows is refused, and so is one in a
 * space that keeps no store, whose attach control creates the store when it
 * opens its picker. The store here records what it is asked to add, and
 * answers by the file's name: it adds a file, refuses a name starting `bad`,
 * and never answers for a name starting `slow`, so that each of the
 * composer's paths can be reached without a blob store. The test requires
 * exactly the refusals below, each by its reason.
 */
import {
  action,
  type AddIntegrity,
  assert,
  type Cell,
  computed,
  equals,
  handler,
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
  type FileRequestOutcome,
  type FileStoreOutput,
  type RemoveFileEvent,
  type RenameFileEvent,
} from "../fabrifile/schemas.tsx";
import type { FileStoreRecord } from "../fabrifile/store.tsx";
import {
  childNodes,
  findElement,
  findNode,
  hasText,
  isButton,
  propsOf,
  propValue,
  readValue,
  textContent,
} from "../test/vnode-helpers.ts";
import { type MessageRecord, type MessagesValue } from "./room-records.tsx";
import { FabriChatRoomCore } from "./room.tsx";
import {
  CHAT_SEND_ACTION,
  CHAT_SEND_SURFACE,
  type ChatProfile,
} from "./schemas.tsx";

type RoomArg = Parameters<typeof FabriChatRoomCore>[0];

// A labeled stand-in for a viewer's `#profile`.
type TestProfile = AddIntegrity<
  ChatProfile,
  readonly ["fabrichat-test-profile"]
>;

const sendGesture = { surface: CHAT_SEND_SURFACE, action: CHAT_SEND_ACTION };

const typed = (text: string) => ({ type: "click", target: { value: text } });

/** What the stand-in store's `add` is bound to. */
interface StandInAddState {
  entries: Writable<FileEntry[]>;
  requests: Writable<Record<string, FileRequestOutcome>>;
  profile: Cell<TestProfile>;
}

/**
 * Answers an `add` by the file's name: adds it, refuses a name starting
 * `bad`, and leaves a name starting `slow` with no outcome.
 */
const standInAdd = handler<AddFileEvent, StandInAddState>(
  (event, { entries, requests, profile }) => {
    const name = event?.name ?? "";
    const requestId = event?.requestId ?? "";
    if (name.startsWith("slow")) return;
    if (name.startsWith("bad")) {
      requests.key(requestId).set({
        status: "refused",
        reason: "That name isn't allowed.",
        code: "invalid-name",
      });
      return;
    }
    entries.push({
      name,
      mediaType: event?.mediaType ?? "",
      blob: event?.blob ?? { space: "", id: "" },
      size: event?.size ?? 0,
      addedAt: epochNsecFromMsec(0),
      addedBy: profile,
    });
    requests.key(requestId).set({
      status: "done",
      entry: entries.key(entries.get().length - 1),
      name,
    });
  },
);

/** Takes nothing out, and renames nothing: the composer sends neither. */
const ignoreRemove = handler<RemoveFileEvent, Record<PropertyKey, never>>(
  () => {},
);
const ignoreRename = handler<RenameFileEvent, Record<PropertyKey, never>>(
  () => {},
);

/** A store answering `add` as `standInAdd` does. */
const StandInStore = pattern<
  { profile: Cell<TestProfile> },
  FileStoreOutput
>(({ profile }) => {
  const list = Writable.of<FileEntry[]>([]);
  const requests = Writable.of<Record<string, FileRequestOutcome>>({});
  const entries = computed((): Cell<FileEntry>[] =>
    list.get().map((_, i) => list.key(i))
  );
  const files = {
    entries,
    byName: {},
    requests,
    add: standInAdd({ entries: list, requests, profile }),
    remove: ignoreRemove({}),
    rename: ignoreRename({}),
  };
  return { ...files, [VIEWS]: { files } };
});

/** One file as `cf-file-input` reports storing it. */
const uploaded = (name: string) => ({
  id: `fid1:${name}`,
  name,
  mediaType: name.endsWith(".png") ? "image/png" : "text/plain",
  size: 16,
});

/** The event `cf-file-input` fires once it has stored files named `names`. */
const changed = (names: string[]) => ({
  detail: { files: names.map(uploaded) },
});

/** The room's attach control: the `cf-file-input` its composer renders. */
const attachControl = (root: unknown): unknown =>
  findElement(root, "cf-file-input");

/** Sends `event` on the attach control's handler for `name`. */
const fire = (root: unknown, name: string, event: unknown): void => {
  const stream = propValue(attachControl(root), name) as {
    send: (event: unknown) => void;
  };
  stream.send(event);
};

/** Every node under `root` that `matches`, in the tree's order. */
const collect = (
  root: unknown,
  matches: (node: unknown) => boolean,
): unknown[] => {
  const value = readValue(root);
  if (matches(value)) return [value];
  return childNodes(value).flatMap((child) => collect(child, matches));
};

/** Whether `node` is a listed attachment: a row with a "Remove" control. */
const isListedRow = (node: unknown): boolean => {
  const value = readValue(node);
  return typeof value === "object" && value !== null &&
    readValue((value as Record<string, unknown>).name) === "cf-hstack" &&
    findNode(value, isButton("Remove")) !== undefined;
};

/** The composer's listed attachments, as each row's status text. */
const listed = (root: unknown): string[] =>
  collect(root, isListedRow).map((row) =>
    textContent(findElement(row, "cf-text")).trim()
  );

/** The room's messages, in the order they were recorded. */
const all = (messages: Cell<MessagesValue>): MessageRecord[] =>
  (messages.get() ?? []) as MessageRecord[];

export default pattern(() => {
  const aliceProfile = Writable.of<TestProfile>({ name: "Alice" });

  // A room that is its space's root, whose store answers as above.
  const messages = Writable.of<MessagesValue>([] as MessagesValue);
  const record = Writable.of<FileStoreRecord>({});
  const alice = FabriChatRoomCore({
    myProfile: aliceProfile,
    about: { kind: "group" as const, title: "Team" },
    messages,
    fileStore: record,
  } as RoomArg);
  const standIn = StandInStore({ profile: aliceProfile });
  const keepStandIn = action(() => record.key("store").set(standIn));

  // A room that is its space's root and keeps no store yet.
  const bareRecord = Writable.of<FileStoreRecord>({});
  const bare = FabriChatRoomCore({
    myProfile: aliceProfile,
    about: { kind: "group" as const, title: "Bare" },
    messages: Writable.of<MessagesValue>([] as MessagesValue),
    fileStore: bareRecord,
  } as RoomArg);

  return {
    [TESTS]: [
      { action: keepStandIn },

      // Three files picked: one the store adds, one it refuses, and one it
      // has yet to answer for. The composer lists each as the store has it.
      {
        action: action(() =>
          fire(
            alice[UI],
            "oncf-change",
            changed(["photo.png", "bad.txt", "slow.txt"]),
          )
        ),
      },
      {
        assertion: assert(() =>
          listed(alice[UI]).join(" | ") ===
            "photo.png | bad.txt: That name isn't allowed. | slow.txt: attaching…"
        ),
      },

      // A send waits for the file still being added. Taken out, it no longer
      // holds the send up, and the send attaches the added file alone.
      {
        action: alice.composerSend,
        event: typed("Waiting"),
        trustedUi: sendGesture,
      },
      { assertion: assert(() => all(messages).length === 0) },
      {
        action: action(() => {
          const row = collect(alice[UI], isListedRow).find((node) =>
            hasText(node, "slow.txt")
          );
          const button = findNode(row, isButton("Remove"));
          (propsOf(button)?.onClick as { send: (event: unknown) => void })
            .send({});
        }),
      },
      {
        action: alice.composerSend,
        event: typed("Here"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() => {
          const sent = all(messages)[0];
          const store = record.get().store?.get();
          return all(messages).length === 1 && sent?.body === "Here" &&
            sent.attachments?.length === 1 &&
            store !== undefined &&
            equals(sent.attachments[0], store.entries[0]) &&
            listed(alice[UI]).length === 0;
        }),
      },

      // Eleven files at once are more than the policy allows.
      {
        action: action(() =>
          fire(
            alice[UI],
            "oncf-change",
            changed([
              "a1.txt",
              "a2.txt",
              "a3.txt",
              "a4.txt",
              "a5.txt",
              "a6.txt",
              "a7.txt",
              "a8.txt",
              "a9.txt",
              "a10.txt",
              "a11.txt",
            ]),
          )
        ),
      },
      { assertion: assert(() => listed(alice[UI]).length === 0) },

      // In a space with no store, a file can't be attached; opening the
      // picker creates the store.
      {
        action: action(() =>
          fire(bare[UI], "oncf-change", changed(["note.txt"]))
        ),
      },
      { assertion: assert(() => bareRecord.get().store === undefined) },
      { action: action(() => fire(bare[UI], "oncf-click", {})) },
      { assertion: assert(() => bareRecord.get().store !== undefined) },
    ],
    expectRuntimeErrors: [
      "A file is still being attached.",
      "A message can have at most 10 attachments.",
      "This chat has nowhere to keep files yet.",
    ],
  };
});
