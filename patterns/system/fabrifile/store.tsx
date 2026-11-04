/**
 * `FileStore`, a space's set of files (`docs/specs/fabrifile/FileStore.md`),
 * with the records it stores and the handlers that write them. The records and
 * their writers are one module because each record's write policy names the
 * handlers that may write it.
 *
 * Nothing here renders: this module, and everything it imports, imports no
 * module that does, so a client that draws natively uses a store with no
 * rendering code loaded. `view.tsx` renders a store for hosts that render VDOM,
 * and nothing here imports it.
 *
 * An entry is an object pushed onto the store's list, a document of its own,
 * identified by its cell. Its `addedBy` is labeled `authored-by` the principal
 * who added it, by the one handler that writes it, so a rename, which writes
 * the entry's name and blob, leaves who added it as it was.
 */
import {
  type AuthoredByCurrentUser,
  type Cell,
  computed,
  currentPrincipal,
  type Default,
  equals,
  eventKey,
  handler,
  NAME,
  nameBlob,
  pattern,
  type PerSpace,
  principalOf,
  spaceAccess,
  spaceOf,
  VIEWS,
  wish,
  type Writable,
  type WriteAuthorizedBy,
  type WritePolicyAnyOf,
} from "commonfabric";
import { freeName, isValidName } from "./names.ts";
import {
  type AddFileEvent,
  epochNsecFromMsec,
  type FileEntry,
  type FileProfile,
  type FileProfileCell,
  type FileRefusalCode,
  type FileRequestOutcome,
  type FileStoreFiles,
  type FileStoreOutput,
  type RemoveFileEvent,
  type RenameFileEvent,
} from "./schemas.tsx";

//
// Stored records
//

/**
 * The profile of whoever added an entry. Only `commitAdd` writes it, and the
 * runtime labels the field `authored-by` the principal that write acts for,
 * which is how `remove` and `rename` know who added the entry.
 */
export type EntryAdder = AuthoredByCurrentUser<
  WriteAuthorizedBy<FileProfileCell, typeof commitAdd>
>;

/** An entry as the store keeps it: a `FileEntry` whose adder is attested. */
export interface StoredEntryValue extends Omit<FileEntry, "addedBy"> {
  /** The profile of whoever added the file. */
  addedBy: EntryAdder;
}

/**
 * A stored entry. The policy is the element's, so it sits at the element's
 * position in the list, and names every handler that writes an entry or takes
 * one out of the list: `commitAdd` writes a whole entry, `commitRename` its
 * name and blob, and `commitRemove` its `removedAt` and its place in the list.
 */
export type StoredEntry = WritePolicyAnyOf<StoredEntryValue, [
  WriteAuthorizedBy<unknown, typeof commitAdd>,
  WriteAuthorizedBy<unknown, typeof commitRename>,
  WriteAuthorizedBy<unknown, typeof commitRemove>,
]>;

/** The cell holding a store's entries, in the order they were added. */
export type EntriesCell = Writable<StoredEntry[] | Default<[]>>;

/** The cell holding the outcome of each request, by its `requestId`. */
export type RequestsCell = Writable<
  Record<string, FileRequestOutcome> | Default<Record<PropertyKey, never>>
>;

//
// Helpers
//

/** A handler clock reading as a recorded time. */
const now = () => epochNsecFromMsec(Date.now());

/**
 * Records a refusal of the request `requestId` in `requests`, with `code` and
 * `reason`.
 */
const refuse = (
  requests: RequestsCell,
  requestId: string,
  code: FileRefusalCode,
  reason: string,
): void => {
  requests.key(requestId).set({ status: "refused", code, reason });
};

/**
 * Indicates whether the principal the running event acts for may change the
 * store: anyone but a principal its space admits with less than `WRITE`. A
 * level not known yet is left to the space's own access list, which refuses
 * the write where it does not admit it.
 */
const mayWrite = (entries: EntriesCell): boolean => {
  const level = spaceAccess(entries);
  return currentPrincipal() !== undefined && level !== "none" &&
    level !== "READ";
};

/**
 * Returns the cell of the entry in `entries` that `target` names, or
 * `undefined` when `target` names none of them.
 */
const entryIn = (
  entries: EntriesCell,
  target: Cell<FileEntry> | undefined,
): Cell<StoredEntryValue> | undefined => {
  if (target === undefined) return undefined;
  const index = entries.get().findIndex((_, i) =>
    equals(entries.key(i), target)
  );
  if (index < 0) return undefined;
  const entry: Cell<StoredEntryValue> = entries.key(index).resolveAsCell();
  return entry;
};

/** Returns the stored entry `entry` as the `FileEntry` a client reads. */
const asFileEntry = (entry: Cell<StoredEntryValue>): Cell<FileEntry> => entry;

/** Indicates whether a name other than `except`'s is taken in `entries`. */
const takenIn = (
  entries: EntriesCell,
  except?: Cell<StoredEntryValue>,
): (name: string) => boolean => {
  const names = new Set(
    entries.get().flatMap((entry, i) =>
      except !== undefined && equals(entries.key(i), except) ? [] : [entry.name]
    ),
  );
  return (name) => names.has(name);
};

/**
 * Indicates whether the principal the running event acts for may change the
 * entry `entry`: its adder, as its `addedBy` attests, or an OWNER of the
 * store's space.
 */
const mayChange = (
  entries: EntriesCell,
  entry: Cell<StoredEntryValue>,
): boolean => {
  if (spaceAccess(entries) === "OWNER") return true;
  const adder = principalOf(entry.key("addedBy"), "authored-by", {
    label: "written",
  });
  return adder !== undefined && adder === currentPrincipal();
};

/**
 * Indicates whether `target`, a request's `entry`, holds what an entry holds,
 * in any store: something other than an entry is a request of the wrong type,
 * where an entry of another store is one the store does not hold.
 */
const namesAnEntry = (target: Cell<FileEntry> | undefined): boolean =>
  typeof target?.get()?.name === "string";

/** Indicates whether `value` is what a request may name as its `onConflict`. */
const isNameConflict = (value: unknown): boolean =>
  value === undefined || value === "refuse" || value === "rename";

/**
 * The name an entry is to have: `name` itself, or a free one where `name` is
 * taken and `onConflict` is `rename`, or `undefined` where it is taken and the
 * request is to be refused.
 */
const nameToUse = (
  name: string,
  onConflict: string | undefined,
  isTaken: (name: string) => boolean,
): string | undefined =>
  !isTaken(name)
    ? name
    : onConflict === "rename"
    ? freeName(name, isTaken)
    : undefined;

//
// Handlers
//

/** What `commitAdd` is bound to. */
export interface AddState {
  /** The store's entries. */
  entries: EntriesCell;

  /** The outcome of each request. */
  requests: RequestsCell;

  /** The adder's profile, which holds no value while it is unknown. */
  myProfile: FileProfileCell | undefined;
}

/**
 * Adds an entry for a blob already in the store's space, under the request's
 * name or, with `onConflict: "rename"`, a free one, storing the blob's bytes
 * again under that name where it is not the name the blob was stored under
 * (`nameBlob()`).
 */
export const commitAdd = handler<AddFileEvent, AddState>(
  (event, { entries, requests, myProfile }) => {
    if (!mayWrite(entries)) return;
    const requestId = event?.requestId ?? eventKey();
    if (requests.key(requestId).get() !== undefined) return;
    const profile = myProfile?.resolveAsCell();
    if (profile === undefined || profile.get() === undefined) {
      refuse(requests, requestId, "not-permitted", "You have no profile yet.");
      return;
    }
    const { name, mediaType, blob, size } = event ?? {};
    if (
      typeof name !== "string" || typeof mediaType !== "string" ||
      typeof size !== "number" || typeof blob?.id !== "string" ||
      blob.id === "" || typeof blob?.space !== "string" ||
      !isNameConflict(event.onConflict)
    ) {
      refuse(
        requests,
        requestId,
        "invalid-request",
        "An add needs a `name`, a `mediaType`, a `size`, and a `blob` with a " +
          "`space` and an `id`, and takes an `onConflict` of `refuse` or " +
          "`rename`.",
      );
      return;
    }
    if (!isValidName(name)) {
      refuse(requests, requestId, "invalid-name", "That isn't a file name.");
      return;
    }
    if (blob.space !== spaceOf(entries)) {
      refuse(
        requests,
        requestId,
        "other-space",
        "That file's bytes are in another space.",
      );
      return;
    }
    const given = nameToUse(name, event.onConflict, takenIn(entries));
    if (given === undefined) {
      refuse(requests, requestId, "name-taken", "That name is taken.");
      return;
    }
    const blobId = nameBlob(entries, blob.id, given);
    if (blobId === undefined) {
      refuse(requests, requestId, "no-blob", "That file's bytes aren't here.");
      return;
    }
    entries.push({
      name: given,
      mediaType,
      blob: { space: blob.space, id: blobId },
      size,
      addedAt: now(),
      addedBy: profile,
    } as StoredEntry);
    const entry: Cell<FileEntry> = entries.key(entries.get().length - 1)
      .resolveAsCell();
    requests.key(requestId).set({ status: "done", entry, name: given });
  },
);

/** What `commitRemove` and `commitRename` are bound to. */
export interface ChangeState {
  /** The store's entries. */
  entries: EntriesCell;

  /** The outcome of each request. */
  requests: RequestsCell;
}

/**
 * Takes an entry out of the store and marks it removed, for its adder or an
 * OWNER of the store's space. The blob stays in the blob store.
 */
export const commitRemove = handler<RemoveFileEvent, ChangeState>(
  (event, { entries, requests }) => {
    if (!mayWrite(entries)) return;
    const requestId = event?.requestId ?? eventKey();
    if (requests.key(requestId).get() !== undefined) return;
    if (!namesAnEntry(event?.entry)) {
      refuse(requests, requestId, "invalid-request", "This names no `entry`.");
      return;
    }
    const entry = entryIn(entries, event.entry);
    if (entry === undefined) {
      refuse(requests, requestId, "not-found", "That file isn't here.");
      return;
    }
    if (!mayChange(entries, entry)) {
      refuse(
        requests,
        requestId,
        "not-permitted",
        "Only whoever added a file, or an owner, can remove it.",
      );
      return;
    }
    const name = entry.get().name;
    entry.key("removedAt").set(now());
    entries.removeByValue(entry);
    requests.key(requestId).set({
      status: "done",
      entry: asFileEntry(entry),
      name,
    });
  },
);

/**
 * Renames an entry, for its adder or an OWNER of the store's space, storing
 * its bytes again under the new name (`nameBlob()`), so that its blob carries
 * the name too.
 */
export const commitRename = handler<RenameFileEvent, ChangeState>(
  (event, { entries, requests }) => {
    if (!mayWrite(entries)) return;
    const requestId = event?.requestId ?? eventKey();
    if (requests.key(requestId).get() !== undefined) return;
    if (!namesAnEntry(event?.entry)) {
      refuse(requests, requestId, "invalid-request", "This names no `entry`.");
      return;
    }
    const entry = entryIn(entries, event.entry);
    if (entry === undefined) {
      refuse(requests, requestId, "not-found", "That file isn't here.");
      return;
    }
    if (!mayChange(entries, entry)) {
      refuse(
        requests,
        requestId,
        "not-permitted",
        "Only whoever added a file, or an owner, can rename it.",
      );
      return;
    }
    const name = event?.name;
    if (typeof name !== "string" || !isNameConflict(event?.onConflict)) {
      refuse(
        requests,
        requestId,
        "invalid-request",
        "A rename needs a `name`, and takes an `onConflict` of `refuse` or " +
          "`rename`.",
      );
      return;
    }
    if (!isValidName(name)) {
      refuse(requests, requestId, "invalid-name", "That isn't a file name.");
      return;
    }
    const current = entry.get();
    if (name === current.name) {
      requests.key(requestId).set({
        status: "done",
        entry: asFileEntry(entry),
        name,
      });
      return;
    }
    const given = nameToUse(name, event.onConflict, takenIn(entries, entry));
    if (given === undefined) {
      refuse(requests, requestId, "name-taken", "That name is taken.");
      return;
    }
    const blobId = nameBlob(entries, current.blob.id, given);
    if (blobId === undefined) {
      refuse(requests, requestId, "no-blob", "That file's bytes aren't here.");
      return;
    }
    entry.key("name").set(given);
    entry.key("blob").set({ space: current.blob.space, id: blobId });
    requests.key(requestId).set({
      status: "done",
      entry: asFileEntry(entry),
      name: given,
    });
  },
);

//
// The patterns
//

/** Returns the cell of the entry at `index` in `entries`. */
const entryAt = (entries: EntriesCell, index: number): Cell<FileEntry> => {
  const entry: Cell<FileEntry> = entries.key(index).resolveAsCell();
  return entry;
};

/** What a store keeps, and who is adding to it. */
export interface FileStoreCoreInput {
  /** The store's entries. */
  entries: PerSpace<EntriesCell>;

  /** The outcome of each request. */
  requests: PerSpace<RequestsCell>;

  /** The viewer's profile, which holds no value while it is unknown. */
  myProfile: FileProfileCell | undefined;
}

/**
 * A store whose viewer's profile is an input, so that a test can name one: the
 * whole of `FileStoreOutput`. `FileStore` resolves the viewer's own.
 */
export const FileStoreCore = pattern<FileStoreCoreInput, FileStoreOutput>(
  ({ entries, requests, myProfile }) => {
    const entryCells = computed((): Cell<FileEntry>[] =>
      entries.get().map((_, i) => entryAt(entries, i))
    );
    const byName = computed((): Record<string, Cell<FileEntry>> =>
      Object.fromEntries(
        entries.get().map((entry, i) => [entry.name, entryAt(entries, i)]),
      )
    );
    const view: FileStoreFiles = {
      entries: entryCells,
      byName,
      requests: computed(() => requests.get()),
      add: commitAdd({ entries, requests, myProfile }),
      remove: commitRemove({ entries, requests }),
      rename: commitRename({ entries, requests }),
    };
    return {
      [NAME]: "Files",
      [VIEWS]: { files: view },
      ...view,
    };
  },
);

/** What a store keeps. Each has a default, so a new store starts empty. */
export interface FileStoreInput {
  /** The store's entries. */
  entries?: PerSpace<EntriesCell>;

  /** The outcome of each request. */
  requests?: PerSpace<RequestsCell>;
}

/** A space's file store, whose viewer is the person using it. */
const FileStore = pattern<FileStoreInput, FileStoreOutput>(
  ({ entries, requests }) => {
    const profileWish = wish<FileProfile>({ query: "#profile" });
    return FileStoreCore({
      entries,
      requests,
      myProfile: profileWish.result,
    });
  },
);

//
// A root's store
//

/**
 * Where a space's root keeps its store: a link to a store piece in the root's
 * own space, in `store`, absent until the store is first needed. It holds a
 * record rather than the link itself because a handler's cell for a field
 * holding a link writes through the link, so replacing the link there would
 * write into the store it names.
 */
export interface FileStoreRecord {
  /** The store; absent while the root names none. */
  store?: Cell<FileStoreOutput>;
}

/** The cell a root keeps its store in; a root naming none holds `{}`. */
export type FileStoreRecordCell = Writable<
  FileStoreRecord | Default<Record<PropertyKey, never>>
>;

/**
 * Names a new store as the root's, unless the root names one already, in which
 * case it changes nothing, as it does bound to no record at all. The store is
 * a piece in the root's own space, as a pattern a handler calls is. Whatever
 * may write the root may call this; the space's access list decides.
 */
export const ensureFileStore = handler<
  void,
  { fileStore?: FileStoreRecordCell }
>((_, { fileStore }) => {
  if (fileStore === undefined || fileStore.get().store !== undefined) return;
  fileStore.set({ store: FileStore({}) });
});

export default FileStore;
