/**
 * `FileStoreView`, a store's rendering for hosts that render VDOM
 * (`docs/specs/fabrifile/FileStoreView.md`). It is a module of its own so that
 * nothing that uses a store loads it: `store.tsx` never imports this module.
 * It decides nothing about the store's files that the store does not already
 * say, and every change it offers goes to the store's own streams.
 *
 * What the view keeps for itself is per session: the requests it has sent,
 * so that it can say what came of them.
 */
import {
  type AnyCell,
  type Cell,
  computed,
  equals,
  handler,
  NAME,
  pattern,
  type PerSession,
  spaceAccess,
  spaceOf,
  type Stream,
  UI,
  VIEWS,
  type VNode,
  wish,
  Writable,
} from "commonfabric";
import type {
  AddFileEvent,
  FileEntry,
  FileProfile,
  FileProfileCell,
  FileStoreFiles,
  RemoveFileEvent,
  RenameFileEvent,
} from "./schemas.tsx";

/** One file `cf-file-input` reports it has stored. */
interface UploadedFile {
  /** The blob's id. */
  id: string;

  /** The name the file had. */
  name: string;

  /** The media type the blob was stored with. */
  mediaType: string;

  /** The size of the file, in bytes. */
  size: number;
}

/** The `cf-change` event `cf-file-input` fires after storing files. */
interface UploadEvent {
  detail?: { files?: UploadedFile[] };
}

/** The `cf-submit` event of a rename's input. */
interface RenameSubmitEvent {
  detail?: { value?: string };
}

/** A request this session sent, and the name it asked for. */
interface SentRequest {
  /** The request's id, under which the store records its outcome. */
  requestId: string;

  /** The name the request asked for. */
  name: string;
}

/** The cell of the requests this session sent. */
type SentCell = Writable<SentRequest[]>;

/**
 * How a control offered to some viewers and not others is displayed. The
 * view's tree is one for every viewer, so a control is shown or hidden by its
 * `display` rather than built for some viewers only, and starts out `hidden`
 * until its display has a value.
 */
type ControlDisplay = "block" | "none";

/** What a view renders: a store's files group. */
export interface FileStoreViewInput {
  /** The store. */
  store: FileStoreFiles;
}

/**
 * What a view offers: its rendering, the store it renders, and that store's
 * files group as its own, so that a host asking the piece a container holds
 * for its view groups finds the store's.
 */
export interface FileStoreViewOutput {
  [NAME]: string;
  [UI]: VNode;

  /** The store the view renders. */
  store: FileStoreFiles;

  [VIEWS]: { files: FileStoreFiles };
}

/** Returns a new request id, for one request this session sends. */
const newRequestId = (): string =>
  `view-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Adds every file `cf-file-input` reports it stored, under the name it had or
 * a free one, recording each request in `sent`.
 */
const addUploads = handler<
  UploadEvent,
  { add: Stream<AddFileEvent>; anchor: Cell<unknown>; sent: SentCell }
>((event, { add, anchor, sent }) => {
  const space = spaceOf(anchor);
  if (space === undefined) return;
  (event?.detail?.files ?? []).forEach((file) => {
    const requestId = newRequestId();
    sent.push({ requestId, name: file.name });
    add.send({
      requestId,
      name: file.name,
      mediaType: file.mediaType,
      blob: { space, id: file.id },
      size: file.size,
      onConflict: "rename",
    });
  });
});

/** Removes the entry it is bound to. */
const removeEntry = handler<
  void,
  { remove: Stream<RemoveFileEvent>; entry: Cell<FileEntry>; sent: SentCell }
>((_, { remove, entry, sent }) => {
  const requestId = newRequestId();
  sent.push({ requestId, name: entry.get().name });
  remove.send({ requestId, entry });
});

/** Renames the entry it is bound to, to the name its input submits. */
const renameEntry = handler<
  RenameSubmitEvent,
  { rename: Stream<RenameFileEvent>; entry: Cell<FileEntry>; sent: SentCell }
>((event, { rename, entry, sent }) => {
  const name = event?.detail?.value?.trim() ?? "";
  if (name === "") return;
  const requestId = newRequestId();
  sent.push({ requestId, name });
  rename.send({ requestId, entry, name, onConflict: "refuse" });
});

/** Returns `bytes` as a size a person reads. */
const formatSize = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * Indicates whether the viewer is offered a change to the store `anchor` is
 * in: one its space admits with `WRITE` or `OWNER`. The store decides, and a
 * level not known yet offers nothing.
 */
const mayWriteIn = (anchor: AnyCell<unknown>): boolean => {
  const level = spaceAccess(anchor);
  return level === "WRITE" || level === "OWNER";
};

/** What one row of the view renders. */
interface FileRowInput {
  /** The entry. */
  entry: Cell<FileEntry>;

  /** The store the entry is in. */
  store: FileStoreFiles;

  /** The requests this session sent. */
  sent: SentCell;

  /** The viewer's profile, which holds no value while it is unknown. */
  viewer: FileProfileCell | undefined;
}

/**
 * One file: a preview where it is an image, a link that downloads it, what it
 * is, who added it, and the controls that rename and remove it.
 */
const FileRow = pattern<FileRowInput, { [UI]: VNode }>(
  ({ entry, store, sent, viewer }) => {
    const name = computed(() => entry.get().name);
    const mediaType = computed(() => entry.get().mediaType);
    const blob = computed(() => entry.get().blob);
    const isImage = computed(() => entry.get().mediaType.startsWith("image/"));
    const caption = computed(() =>
      `${formatSize(entry.get().size)} · ${entry.get().mediaType}`
    );
    const addedBy = computed(() => entry.get().addedBy);
    // Offered to its adder, as the viewer's profile names them, and to an
    // OWNER; the store decides who may change an entry, by who wrote it.
    const changeDisplay = computed((): ControlDisplay =>
      spaceAccess(entry) === "OWNER" ||
        (mayWriteIn(entry) && viewer?.get() !== undefined &&
          equals(entry.get().addedBy, viewer))
        ? "block"
        : "none"
    );
    return {
      [UI]: (
        <cf-card>
          <cf-hstack gap="3" align="center">
            {isImage
              ? (
                <cf-image
                  blob={blob}
                  media-type={mediaType}
                  alt={name}
                  style="width: 3rem; height: 3rem;"
                />
              )
              : null}
            <cf-vstack gap="0" style="flex: 1; min-width: 0;">
              <cf-blob-link blob={blob} name={name}>{name}</cf-blob-link>
              <cf-text variant="caption" tone="muted">{caption}</cf-text>
              <div
                className="fabrifile-rename"
                hidden
                style={{ display: changeDisplay }}
              >
                <cf-input
                  placeholder="Rename to…"
                  oncf-submit={renameEntry({
                    rename: store.rename,
                    entry,
                    sent,
                  })}
                />
              </div>
            </cf-vstack>
            <cf-profile-badge $profile={addedBy} size="xs" />
            <div
              className="fabrifile-remove"
              hidden
              style={{ display: changeDisplay }}
            >
              <cf-button
                size="sm"
                variant="ghost"
                onClick={removeEntry({ remove: store.remove, entry, sent })}
              >
                Remove
              </cf-button>
            </div>
          </cf-hstack>
        </cf-card>
      ),
    };
  },
);

/** A store's files, for a person to look at, add to, rename, and remove. */
export const FileStoreView = pattern<FileStoreViewInput, FileStoreViewOutput>(
  ({ store }) => {
    const sent = new Writable.perSession<SentRequest[]>([]);
    const viewerWish = wish<FileProfile>({ query: "#profile" });
    // The store's `add` is a cell in the store's own space.
    const addDisplay = computed((): ControlDisplay =>
      mayWriteIn(store.add) ? "block" : "none"
    );
    const count = computed(() => store.entries.length);
    // What came of this session's requests, where that is not what was asked:
    // a refusal, or a file added under a name other than its own.
    const notices = computed((): PerSession<string[]> =>
      sent.get().flatMap(({ requestId, name }) => {
        const outcome = store.requests[requestId];
        if (outcome === undefined) return [];
        if (outcome.status === "refused") {
          return [`${name}: ${outcome.reason}`];
        }
        return outcome.name === name
          ? []
          : [`${name} was added as ${outcome.name}.`];
      })
    );

    return {
      [NAME]: computed(() => `Files (${count})`),
      [UI]: (
        <cf-screen>
          <cf-vstack slot="header" gap="1">
            <cf-heading level={4}>Files</cf-heading>
          </cf-vstack>

          <cf-vstack gap="3" padding="4">
            <div
              className="fabrifile-add"
              hidden
              style={{ display: addDisplay }}
            >
              <cf-file-input
                multiple
                showPreview={false}
                buttonText="Add files"
                oncf-change={addUploads({
                  add: store.add,
                  anchor: store,
                  sent,
                })}
              />
            </div>

            {notices.map((notice) => <cf-text tone="muted">{notice}</cf-text>)}

            {count === 0 ? <cf-text tone="muted">No files yet.</cf-text> : null}

            {store.entries.map((entry) =>
              FileRow({ entry, store, sent, viewer: viewerWish.result })
            )}
          </cf-vstack>
        </cf-screen>
      ),
      store,
      [VIEWS]: { files: store },
    };
  },
);

export default FileStoreView;
