/**
 * What a store records for each request it refuses or carries out, as the one
 * owner of its space, and how its view reports the outcomes of the requests it
 * sent. A pattern test cannot hold a blob, since nothing a pattern runs writes
 * a blob's record, so every request here that reaches `nameBlob()` is refused
 * for want of one; `patterns/integration/fabrifile-store.test.ts` adds and
 * renames files over blobs its space really holds.
 */
import {
  action,
  assert,
  type Cell,
  NAME,
  pattern,
  spaceOf,
  type Stream,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  findElement,
  findNodeByProp,
  fireEvent,
  hasText,
} from "../../tools/test-support/vnode-helpers.ts";
import {
  type AddFileEvent,
  epochNsecFromMsec,
  type FileEntry,
  type FileProfile,
  type FileRequestOutcome,
} from "./schemas.tsx";
import { FileStoreCore } from "./store.tsx";
import { FileStoreView } from "./view.tsx";

/** What came of a request: the code it was refused with, or `done`. */
const outcomeOf = (outcome: FileRequestOutcome | undefined) =>
  outcome === undefined
    ? undefined
    : outcome.status === "refused"
    ? outcome.code
    : outcome.status;

/** The name a request that was carried out gave its entry. */
const nameOf = (outcome: FileRequestOutcome | undefined) =>
  outcome?.status === "done" ? outcome.name : undefined;

/** An entry as the store would have recorded it, for a blob in `space`. */
const entryFor = (
  name: string,
  mediaType: string,
  space: string,
  addedBy: Cell<FileProfile>,
): FileEntry => ({
  name,
  mediaType,
  blob: { space, id: `fid1:${name}` },
  size: 4,
  addedAt: epochNsecFromMsec(0),
  addedBy,
});

/**
 * Sends `add` a well-formed request for bytes `space` does not hold, with
 * `fields` changed.
 */
const sendAdd = (
  add: Stream<AddFileEvent>,
  space: string,
  requestId: string,
  fields: Partial<AddFileEvent> = {},
): void =>
  add.send({
    requestId,
    name: "new.png",
    mediaType: "image/png",
    blob: { space, id: "fid1:missing" },
    size: 4,
    ...fields,
  });

export default pattern(() => {
  const profile = Writable.of<FileProfile>({ name: "Ada" });
  const list = Writable.of<FileEntry[]>([]);
  // A list of another store's, whose entry this store does not hold.
  const elsewhere = Writable.of<FileEntry[]>([]);
  const store = FileStoreCore({
    entries: list,
    requests: {},
    myProfile: profile,
  });
  // A store whose viewer has no profile yet.
  const anonymous = FileStoreCore({
    entries: [],
    requests: {},
    myProfile: undefined,
  });
  const view = FileStoreView({ store });

  const photo: Cell<FileEntry> = list.key(0);
  const notes: Cell<FileEntry> = list.key(1);
  const foreign: Cell<FileEntry> = elsewhere.key(0);

  const action_seed = action(() => {
    const space = spaceOf(list)!;
    list.push(entryFor("photo.png", "image/png", space, profile));
    list.push(entryFor("notes.txt", "text/plain", space, profile));
    list.push(entryFor("doc.pdf", "application/pdf", space, profile));
    elsewhere.push(entryFor("photo.png", "image/png", space, profile));
  });

  const action_adds = action(() => {
    anonymous.add.send({ requestId: "add-anonymous", name: "new.png" });
    store.add.send({ requestId: "add-invalid", name: "new.png" });
    const space = spaceOf(list)!;
    sendAdd(store.add, space, "add-invalid-name", { name: ".hidden" });
    sendAdd(store.add, space, "add-other-space", {
      blob: { space: "did:key:z6Mk-elsewhere", id: "fid1:missing" },
    });
    sendAdd(store.add, space, "add-taken", { name: "photo.png" });
    sendAdd(store.add, space, "add-renamed", {
      name: "photo.png",
      onConflict: "rename",
    });
    sendAdd(store.add, space, "add-no-blob");
    // A request under an id already answered is not answered again.
    sendAdd(store.add, space, "add-invalid");
  });

  const action_renames = action(() => {
    store.rename.send({ requestId: "rename-no-entry", name: "x.png" });
    store.rename.send({
      requestId: "rename-not-found",
      entry: foreign,
      name: "x.png",
    });
    store.rename.send({ requestId: "rename-no-name", entry: photo });
    store.rename.send({
      requestId: "rename-invalid-name",
      entry: photo,
      name: "a/b.png",
    });
    store.rename.send({
      requestId: "rename-same",
      entry: photo,
      name: "photo.png",
    });
    store.rename.send({
      requestId: "rename-taken",
      entry: photo,
      name: "doc.pdf",
    });
    store.rename.send({
      requestId: "rename-no-blob",
      entry: photo,
      name: "holiday.png",
    });
  });

  const action_removes = action(() => {
    store.remove.send({ requestId: "remove-no-entry" });
    store.remove.send({ requestId: "remove-not-found", entry: foreign });
    store.remove.send({ requestId: "remove-notes", entry: notes });
  });

  // The view's own requests: an upload of bytes the space does not hold, and
  // a rename to the name the file already has.
  const action_view_upload = action(() =>
    fireEvent(findElement(view[UI], "cf-file-input"), "oncf-change", {
      detail: {
        files: [{
          id: "fid1:upload",
          name: "upload.png",
          mediaType: "image/png",
          size: 4,
        }],
      },
    })
  );
  const action_view_rename = action(() =>
    fireEvent(
      findNodeByProp(view[UI], "placeholder", "Rename to…"),
      "oncf-submit",
      { detail: { value: "photo.png" } },
    )
  );

  return {
    [TESTS]: [
      { action: action_seed },
      { assertion: assert(() => store.entries.length === 3) },
      {
        assertion: assert(() =>
          store.byName["notes.txt"]?.get().mediaType === "text/plain"
        ),
      },
      { assertion: assert(() => view[NAME] === "Files (3)") },

      { action: action_adds },
      {
        assertion: assert(() =>
          outcomeOf(anonymous.requests["add-anonymous"]) === "not-permitted"
        ),
      },
      {
        assertion: assert(() =>
          outcomeOf(store.requests["add-invalid"]) === "invalid-request"
        ),
      },
      {
        assertion: assert(() =>
          outcomeOf(store.requests["add-invalid-name"]) === "invalid-name"
        ),
      },
      {
        assertion: assert(() =>
          outcomeOf(store.requests["add-other-space"]) === "other-space"
        ),
      },
      {
        assertion: assert(() =>
          outcomeOf(store.requests["add-taken"]) === "name-taken"
        ),
      },
      // Asked to rename on a conflict, it takes a free name rather than
      // refusing the one asked for; the bytes are what it then lacks.
      {
        assertion: assert(() =>
          outcomeOf(store.requests["add-renamed"]) === "no-blob"
        ),
      },
      {
        assertion: assert(() =>
          outcomeOf(store.requests["add-no-blob"]) === "no-blob"
        ),
      },
      { assertion: assert(() => store.entries.length === 3) },

      { action: action_renames },
      {
        assertion: assert(() =>
          outcomeOf(store.requests["rename-no-entry"]) === "invalid-request"
        ),
      },
      {
        assertion: assert(() =>
          outcomeOf(store.requests["rename-not-found"]) === "not-found"
        ),
      },
      {
        assertion: assert(() =>
          outcomeOf(store.requests["rename-no-name"]) === "invalid-request"
        ),
      },
      {
        assertion: assert(() =>
          outcomeOf(store.requests["rename-invalid-name"]) === "invalid-name"
        ),
      },
      {
        assertion: assert(() =>
          nameOf(store.requests["rename-same"]) === "photo.png"
        ),
      },
      {
        assertion: assert(() =>
          outcomeOf(store.requests["rename-taken"]) === "name-taken"
        ),
      },
      {
        assertion: assert(() =>
          outcomeOf(store.requests["rename-no-blob"]) === "no-blob"
        ),
      },
      { assertion: assert(() => list.get()[0]?.name === "photo.png") },

      { action: action_removes },
      {
        assertion: assert(() =>
          outcomeOf(store.requests["remove-no-entry"]) === "invalid-request"
        ),
      },
      {
        assertion: assert(() =>
          outcomeOf(store.requests["remove-not-found"]) === "not-found"
        ),
      },
      {
        assertion: assert(() =>
          nameOf(store.requests["remove-notes"]) === "notes.txt"
        ),
      },
      {
        assertion: assert(() =>
          list.get().map((file) => file.name).join(", ") ===
            "photo.png, doc.pdf"
        ),
      },
      { assertion: assert(() => view[NAME] === "Files (2)") },

      // The view says what came of an upload it sent the store, and says
      // nothing of a rename that gave the name it asked for.
      { action: action_view_upload },
      { action: action_view_rename },
      {
        assertion: assert(() =>
          hasText(view[UI], "upload.png: That file's bytes aren't here.")
        ),
      },
      {
        assertion: assert(() =>
          Object.values(store.requests).filter((outcome) =>
            nameOf(outcome) === "photo.png"
          ).length === 2
        ),
      },
      { assertion: assert(() => !hasText(view[UI], "photo.png:")) },
    ],
    store,
    view,
  };
});
