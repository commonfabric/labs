/**
 * The FabriFile contracts and the records they hold, under the names
 * `docs/specs/fabrifile/` states them: a blob reference, a file entry, the
 * part of a profile a store reads, the requests a store takes and their
 * outcomes, and `FileStoreOutput`, what a space's store offers. Nothing here
 * renders, and nothing here depends on how a store keeps its entries, which is
 * `store.tsx`'s business.
 *
 * Every recorded time is a `FabricEpochNsec`, the handler clock's reading when
 * the store made the record.
 */
import { type Cell, FabricEpochNsec, type Stream, VIEWS } from "commonfabric";

//
// Records
//

/** The blob holding a file's bytes: its space, and its id there. */
export interface BlobRef {
  /** The DID of the space whose blob store holds the bytes. */
  space: string;

  /** The blob's id: `fid1:` and the hash of its name, media type and bytes. */
  id: string;
}

/** The part of a profile a store reads. */
export interface FileProfile {
  /** The name the person goes by. */
  name?: string;

  /** A URL of their picture. */
  avatar?: string;
}

/** The cell of a profile a store reads. */
export type FileProfileCell = Cell<FileProfile>;

/**
 * One file in a store (`docs/specs/fabrifile/FileEntry.md`): its name, which
 * its blob is stored under too, its media type, the blob holding its bytes,
 * and who added it when.
 */
export interface FileEntry {
  /** The name the store finds this file by, and its blob's name. */
  name: string;

  /** The media type of the bytes. */
  mediaType: string;

  /** The blob holding the bytes. */
  blob: BlobRef;

  /** The size of the file, in bytes. */
  size: number;

  /** When the file was added. */
  addedAt: FabricEpochNsec;

  /** The profile of whoever added it. */
  addedBy: FileProfileCell;

  /** When the file was removed from its store, if it has been. */
  removedAt?: FabricEpochNsec;
}

/** A handler clock reading, in milliseconds, as a recorded time. */
export const epochNsecFromMsec = (msec: number): FabricEpochNsec =>
  new FabricEpochNsec(BigInt(Math.floor(msec)) * 1_000_000n);

//
// Requests
//

/** Why a store refused a request, which stays the same whatever its reason. */
export type FileRefusalCode =
  | "invalid-request"
  | "invalid-name"
  | "name-taken"
  | "other-space"
  | "no-blob"
  | "not-found"
  | "not-permitted";

/** The outcome a store records for a request, under its `requestId`. */
export type FileRequestOutcome =
  | {
    status: "done";

    /** The entry the request added or changed. */
    entry: Cell<FileEntry>;

    /** The name the request gave the entry. */
    name: string;
  }
  | {
    status: "refused";

    /** Why, as prose for a person. */
    reason: string;

    /** Why, as a code a client can act on. */
    code: FileRefusalCode;
  };

/** What a store does when a request names a name another entry has. */
export type NameConflict = "refuse" | "rename";

//
// Each event's keys are optional to its stream, so that a request missing one
// reaches the handler, which refuses it saying which, rather than being dropped.
//

/** An event on a store's `add`. */
export interface AddFileEvent {
  /** Chosen by the sender; the event's own key when there is none. */
  requestId?: string;

  /** The new entry's name, the name its blob was stored under. */
  name?: string;

  /** The media type the blob was stored with. */
  mediaType?: string;

  /** The blob holding the bytes. */
  blob?: BlobRef;

  /** The size of the file, in bytes. */
  size?: number;

  /** What to do when `name` is taken; `refuse` when absent. */
  onConflict?: NameConflict;
}

/** An event on a store's `remove`. */
export interface RemoveFileEvent {
  /** Chosen by the sender; the event's own key when there is none. */
  requestId?: string;

  /** The entry to remove. */
  entry?: Cell<FileEntry>;
}

/** An event on a store's `rename`. */
export interface RenameFileEvent {
  /** Chosen by the sender; the event's own key when there is none. */
  requestId?: string;

  /** The entry to rename. */
  entry?: Cell<FileEntry>;

  /** The entry's new name. */
  name?: string;

  /** What to do when `name` is taken; `refuse` when absent. */
  onConflict?: NameConflict;
}

//
// The contract
//

/**
 * A store's data face (`docs/specs/fabrifile/FileStoreOutput.md`): its facts
 * and the streams that change them. A client that draws natively reads this,
 * as the store's `files` view group.
 */
export interface FileStoreFiles {
  /** Every file in the store, in the order they were added. */
  entries: Cell<FileEntry>[];

  /** The same files, by name. */
  byName: Record<string, Cell<FileEntry>>;

  /** The outcome of each request, by its `requestId`. */
  requests: Record<string, FileRequestOutcome>;

  /** Adds a file, for a blob already in the store's space. */
  add: Stream<AddFileEvent>;

  /** Takes a file out of the store, and marks it removed. */
  remove: Stream<RemoveFileEvent>;

  /** Changes a file's name, and its blob with it. */
  rename: Stream<RenameFileEvent>;
}

/** What a space's file store offers: its data face, and that as a view group. */
export interface FileStoreOutput extends FileStoreFiles {
  [VIEWS]: { files: FileStoreFiles };
}
