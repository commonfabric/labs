/**
 * A FabriChat room's composer attaching files: the attach control adds each
 * file it stored to the space's store and lists it, a send attaches the files
 * the store added and leaves out any it refused, and a file can be taken out
 * before the send, which removes its entry from the store again, at once or,
 * for one still being added, at the composer's next handler run after the
 * store adds it. A send keeps the files it attaches, a file attached again is
 * added again, and a removal the store refuses is shown once and never sent
 * again. A send waits while a file is still being added, a change attaching
 * more than the room's policy allows is refused, and so is one in a space
 * that keeps no store, whose attach control creates the store when it opens
 * its picker. The store here records what it is asked to add and to remove,
 * and answers by the file's name: it adds a file, refuses a name starting
 * `bad`, never answers for a name starting `slow`, and holds a name starting
 * `late` until the test lands it; it removes a file, refuses to remove a name
 * starting `kept` as not permitted, and one starting `gone` as not found. So
 * each of the composer's paths can be reached without a blob store. The test
 * requires exactly the refusals below, each by its reason.
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
  type Stream,
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
  isButton,
  propValue,
  readValue,
  textContent,
} from "../../tools/test-support/vnode-helpers.ts";
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

/** What the stand-in store's `add` and `land` are bound to. */
interface StandInAddState {
  entries: Writable<FileEntry[]>;
  requests: Writable<Record<string, FileRequestOutcome>>;
  profile: Cell<TestProfile>;

  /** The adds of a name starting `late`, held until `land`. */
  held: Writable<AddFileEvent[]>;
}

/** Adds the file `event` names to `entries`, recording that it did. */
const addEntry = (
  { entries, requests, profile }: StandInAddState,
  event: AddFileEvent,
): void => {
  const name = event.name ?? "";
  entries.push({
    name,
    mediaType: event.mediaType ?? "",
    blob: event.blob ?? { space: "", id: "" },
    size: event.size ?? 0,
    addedAt: epochNsecFromMsec(0),
    addedBy: profile,
  });
  requests.key(event.requestId ?? "").set({
    status: "done",
    entry: entries.key(entries.get().length - 1),
    name,
  });
};

/**
 * Answers an `add` by the file's name: adds it, refuses a name starting
 * `bad`, leaves a name starting `slow` with no outcome, and holds a name
 * starting `late` until `land`.
 */
const standInAdd = handler<AddFileEvent, StandInAddState>((event, state) => {
  const name = event?.name ?? "";
  if (name.startsWith("slow")) return;
  if (name.startsWith("late")) {
    state.held.push(event);
    return;
  }
  if (name.startsWith("bad")) {
    state.requests.key(event?.requestId ?? "").set({
      status: "refused",
      reason: "That name isn't allowed.",
      code: "invalid-name",
    });
    return;
  }
  addEntry(state, event);
});

/** Adds every file `standInAdd` holds. */
const standInLand = handler<void, StandInAddState>((_event, state) => {
  for (const event of state.held.get()) addEntry(state, event);
  state.held.set([]);
});

/** What the stand-in store's `remove` is bound to. */
interface StandInRemoveState {
  requests: Writable<Record<string, FileRequestOutcome>>;

  /** The name of each entry a `remove` named, in the order they came. */
  removals: Writable<string[]>;
}

/**
 * Answers a `remove` by the entry's name, after logging it: refuses a name
 * starting `kept` as not permitted, and one starting `gone` as not found, and
 * otherwise marks the entry removed.
 */
const standInRemove = handler<RemoveFileEvent, StandInRemoveState>(
  (event, { requests, removals }) => {
    const entry = event?.entry;
    const name = entry?.get()?.name ?? "";
    const outcome = requests.key(event?.requestId ?? "");
    removals.push(name);
    if (entry === undefined || name.startsWith("gone")) {
      outcome.set({
        status: "refused",
        reason: "That file isn't here.",
        code: "not-found",
      });
    } else if (name.startsWith("kept")) {
      outcome.set({
        status: "refused",
        reason: "Only whoever added a file, or an owner, can remove it.",
        code: "not-permitted",
      });
    } else {
      entry.key("removedAt").set(epochNsecFromMsec(1));
      outcome.set({ status: "done", entry, name });
    }
  },
);

/** Renames nothing: the composer sends no rename. */
const ignoreRename = handler<RenameFileEvent, Record<PropertyKey, never>>(
  () => {},
);

/** What the stand-in store offers, beside a store's own face. */
interface StandInStoreOutput extends FileStoreOutput {
  /** Adds every file the store holds. */
  land: Stream<void>;

  /** The name of each entry a `remove` named, in the order they came. */
  removals: string[];
}

/** A store answering `add` and `remove` as the stand-in handlers do. */
const StandInStore = pattern<
  { profile: Cell<TestProfile> },
  StandInStoreOutput
>(({ profile }) => {
  const list = Writable.of<FileEntry[]>([]);
  const requests = Writable.of<Record<string, FileRequestOutcome>>({});
  const held = Writable.of<AddFileEvent[]>([]);
  const removals = Writable.of<string[]>([]);
  const entries = computed((): Cell<FileEntry>[] =>
    list.get().map((_, i) => list.key(i))
  );
  const addState = { entries: list, requests, profile, held };
  const files = {
    entries,
    byName: {},
    requests,
    add: standInAdd(addState),
    remove: standInRemove({ requests, removals }),
    rename: ignoreRename({}),
  };
  return {
    ...files,
    [VIEWS]: { files },
    land: standInLand(addState),
    removals,
  };
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

/**
 * The text of each row under `root` with a `control` button: a listed
 * attachment's status, for "Remove", and a refused removal's, for "Dismiss".
 */
const rowsWith = (root: unknown, control: string): string[] =>
  collect(root, (node) => {
    const value = readValue(node);
    return typeof value === "object" && value !== null &&
      readValue((value as Record<string, unknown>).name) === "cf-hstack" &&
      findNode(value, isButton(control)) !== undefined;
  }).map((row) => textContent(findElement(row, "cf-text")).trim());

/** The composer's listed attachments, as each row's status text. */
const listed = (root: unknown): string[] => rowsWith(root, "Remove");

/** The removals the composer shows as refused, as each row's text. */
const unremoved = (root: unknown): string[] => rowsWith(root, "Dismiss");

/** The entries named `name` in `entries`, in the order they were added. */
const named = (
  entries: readonly Cell<FileEntry>[],
  name: string,
): FileEntry[] =>
  entries.map((entry) => entry.get()).filter((entry) => entry.name === name);

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
      // A refused send keeps its files, in the composer and in the store.
      {
        action: alice.composerSend,
        event: typed("Waiting"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          all(messages).length === 0 && listed(alice[UI]).length === 3 &&
          standIn.removals.length === 0
        ),
      },
      { press: alice[UI], control: "Remove", within: "slow.txt" },
      {
        action: alice.composerSend,
        event: typed("Here"),
        trustedUi: sendGesture,
      },

      // The send attaches the added file and keeps it in the store; nothing
      // is removed, the file taken out having added nothing yet.
      {
        assertion: assert(() => {
          const sent = all(messages)[0];
          const store = record.get().store?.get();
          return all(messages).length === 1 && sent?.body === "Here" &&
            sent.attachments?.length === 1 &&
            store !== undefined &&
            equals(sent.attachments[0], store.entries[0]) &&
            store.entries[0].get().removedAt === undefined &&
            listed(alice[UI]).length === 0 &&
            standIn.removals.length === 0;
        }),
      },

      // A file the store has added, taken out, is removed from the store at
      // once.
      {
        action: action(() =>
          fire(alice[UI], "oncf-change", changed(["draft.txt"]))
        ),
      },
      { assertion: assert(() => listed(alice[UI]).join() === "draft.txt") },
      { press: alice[UI], control: "Remove", within: "draft.txt" },
      {
        assertion: assert(() => {
          const drafts = named(standIn.entries, "draft.txt");
          return listed(alice[UI]).length === 0 &&
            standIn.removals.join() === "draft.txt" &&
            drafts.length === 1 && drafts[0].removedAt !== undefined;
        }),
      },

      // Attached again, it is added again, as a new entry, which the next
      // send attaches, and which stays.
      {
        action: action(() =>
          fire(alice[UI], "oncf-change", changed(["draft.txt"]))
        ),
      },
      {
        action: alice.composerSend,
        event: typed("Again"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() => {
          const sent = all(messages)[1];
          const entries = standIn.entries;
          const drafts = named(entries, "draft.txt");
          return all(messages).length === 2 && sent?.body === "Again" &&
            sent.attachments?.length === 1 &&
            equals(sent.attachments[0], entries[entries.length - 1]) &&
            drafts.length === 2 && drafts[0].removedAt !== undefined &&
            drafts[1].removedAt === undefined &&
            standIn.removals.join() === "draft.txt";
        }),
      },

      // A file taken out before the store adds it is removed by the
      // composer's next handler run after the store adds it, here a send.
      {
        action: action(() =>
          fire(alice[UI], "oncf-change", changed(["late.txt"]))
        ),
      },
      {
        assertion: assert(() =>
          listed(alice[UI]).join() === "late.txt: attaching…"
        ),
      },
      { press: alice[UI], control: "Remove", within: "late.txt" },
      { action: standIn.land },
      {
        assertion: assert(() => {
          const lates = named(standIn.entries, "late.txt");
          return listed(alice[UI]).length === 0 && lates.length === 1 &&
            lates[0].removedAt === undefined &&
            standIn.removals.join() === "draft.txt";
        }),
      },
      {
        action: alice.composerSend,
        event: typed("Later"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() => {
          const lates = named(standIn.entries, "late.txt");
          return all(messages).length === 3 &&
            all(messages)[2].attachments === undefined &&
            lates.length === 1 && lates[0].removedAt !== undefined &&
            standIn.removals.join() === "draft.txt,late.txt";
        }),
      },

      // A removal the store refuses is shown once, and never sent again; one
      // that finds no entry counts as done, and isn't shown.
      {
        action: action(() =>
          fire(alice[UI], "oncf-change", changed(["kept.txt", "gone.txt"]))
        ),
      },
      { press: alice[UI], control: "Remove", within: "kept.txt" },
      { press: alice[UI], control: "Remove", within: "gone.txt" },
      {
        assertion: assert(() =>
          unremoved(alice[UI]).join(" | ") ===
            "kept.txt stays in this chat's files: Only whoever added a " +
              "file, or an owner, can remove it." &&
          standIn.removals.join() === "draft.txt,late.txt,kept.txt,gone.txt"
        ),
      },
      {
        action: alice.composerSend,
        event: typed("More"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          all(messages).length === 4 && unremoved(alice[UI]).length === 1 &&
          standIn.removals.join() === "draft.txt,late.txt,kept.txt,gone.txt"
        ),
      },
      { press: alice[UI], control: "Dismiss", within: "kept.txt" },
      {
        action: alice.composerSend,
        event: typed("Done"),
        trustedUi: sendGesture,
      },
      {
        assertion: assert(() =>
          all(messages).length === 5 && unremoved(alice[UI]).length === 0 &&
          named(standIn.entries, "kept.txt")[0]?.removedAt === undefined &&
          standIn.removals.join() === "draft.txt,late.txt,kept.txt,gone.txt"
        ),
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
