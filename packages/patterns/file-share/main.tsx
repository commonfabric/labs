/**
 * File Share
 *
 * A shared list of files for everyone in a space: upload, download, remove.
 * It shows the shape every file-carrying pattern takes. The bytes never live
 * in a pattern's cells: `cf-file-input` uploads them to the space's blob
 * store and reports a small descriptor (name, media type, size, URL), and
 * that descriptor is what the shared list holds. A download is a plain link
 * to the URL. `docs/common/capabilities/files.md` describes the store the
 * descriptor points into and the limits a pattern inherits from it.
 *
 * Every record names its uploader with a link to their profile, rendered with
 * `cf-profile-badge`. A viewer without a profile is shown how to make one
 * instead of the upload control, so no file is ever stored unattributed.
 */

import {
  type Cell,
  computed,
  Default,
  handler,
  hasError,
  hasSchemaMismatch,
  isPending,
  isSyncing,
  NAME,
  pattern,
  type PerSpace,
  type PerUser,
  resultOf,
  Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";

/** The part of a profile a shared-file row reads. */
export type UploaderProfileCell = Cell<{ name?: string; avatar?: string }>;

/** The fields this pattern keeps from what `cf-file-input` reports. */
export interface UploadedFile {
  /** Hash of the media type and bytes, prefixed `fid1:`. */
  id: string;
  name: string;
  mediaType: string;
  size: number;
  /** Absolute URL the bytes are served from. */
  url: string;
}

/** One file in the shared list. */
export interface SharedFile extends UploadedFile {
  uploadedBy: UploaderProfileCell;
}

/**
 * The `cf-change` event `cf-file-input` fires after an upload: `files` holds
 * the files it just stored.
 */
export interface AddFilesEvent {
  detail?: { files?: UploadedFile[] };
}

/**
 * Test seam: a claimed viewer identity standing in for the `#profile` wish,
 * which has no resolving environment in a unit test. The claim is per user,
 * so a multi-user test claims one identity per runtime on one shared piece.
 * Production UI never sends it. A claim always carries a name, and the name
 * is what the pattern gates on: an absent cell-typed field reads as an empty
 * cell handle rather than as absent, so `profile` alone cannot say whether a
 * claim was made.
 */
export interface ViewerClaim {
  profile?: UploaderProfileCell;
  name?: string;
}

const DEFAULT_VIEWER: ViewerClaim = {};

type ViewerValue = ViewerClaim | Default<typeof DEFAULT_VIEWER>;

type ViewerCell = Writable<ViewerValue>;

type FilesCell = Writable<SharedFile[] | Default<[]>>;

export interface FileShareInput {
  files?: PerSpace<FilesCell>;
  viewer?: PerUser<ViewerValue>;
}

export interface FileShareOutput {
  [NAME]: string;
  [UI]: VNode;
  /** The shared list, as a read-only view. */
  files: PerSpace<SharedFile[] | Default<[]>>;
  fileCount: number;
  addFiles: Stream<AddFilesEvent>;
  claimViewer: Stream<ViewerClaim>;
}

/**
 * Adds every file the event reports, each attributed to the bound profile. A
 * handler rather than an action so the profile can be bound in as a cell,
 * which is what the record stores. With no resolved profile the upload is
 * refused: the UI withholds the input in that state, and this guard covers
 * the stream.
 */
const addFiles = handler<AddFilesEvent, {
  files: FilesCell;
  profile: UploaderProfileCell | undefined;
}>(({ detail }, { files, profile }) => {
  const uploader = profile?.resolveAsCell();
  if (uploader === undefined || uploader.get() === undefined) return;
  (detail?.files ?? []).forEach((file) => {
    files.push({
      id: file.id,
      name: file.name,
      mediaType: file.mediaType,
      size: file.size,
      url: file.url,
      uploadedBy: uploader,
    });
  });
});

/**
 * Removes the row it is bound to. Each row binds its own element cell, so the
 * removal names that row alone even when another row holds the same id, and
 * removing the element rather than writing back a filtered list lets two
 * people's edits merge instead of overwriting each other.
 */
const removeFile = handler<void, { files: FilesCell; file: Cell<SharedFile> }>(
  (_, { files, file }) => {
    files.removeByValue(file);
  },
);

const claimViewer = handler<ViewerClaim, { viewer: ViewerCell }>(
  ({ profile, name }, { viewer }) => {
    viewer.set({
      ...(profile !== undefined ? { profile } : {}),
      ...(name !== undefined ? { name } : {}),
    });
  },
);

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default pattern<FileShareInput, FileShareOutput>(
  ({ files, viewer }) => {
    const profileWish = wish<UploaderProfileCell>({
      query: "#profile",
    });

    // A claim takes precedence over the wish.
    const hasViewerClaim = computed(() => (viewer.name ?? "").trim() !== "");
    const wishedProfile = hasError(profileWish.result) ||
        isPending(profileWish.result) || isSyncing(profileWish.result) ||
        hasSchemaMismatch(profileWish.result)
      ? undefined
      : resultOf(profileWish.result);
    const uploaderProfile = hasViewerClaim ? viewer.profile : wishedProfile;
    // Uploads open once the profile document itself has resolved, which is
    // the condition `addFiles` requires, so the input never shows while an
    // upload would still be refused. An unclaimed `viewer.profile` reads as
    // an empty cell, whose value is undefined, so the wish decides then.
    const hasProfile = computed(() =>
      (uploaderProfile?.get()?.name ?? "").trim() !== ""
    );

    const boundAddFiles = addFiles({ files, profile: uploaderProfile });

    const fileCount = computed(() => files.get().length);

    return {
      [NAME]: computed(() => `File Share (${fileCount})`),
      [UI]: (
        <cf-screen>
          <cf-vstack slot="header" gap="1">
            <cf-heading level={4}>File Share</cf-heading>
          </cf-vstack>

          <cf-vstack gap="3" padding="4">
            {
              /* Without previews the input has no remove buttons of its own,
                so its `cf-change` event only ever reports an upload. */
            }
            {hasProfile
              ? (
                <cf-file-input
                  multiple
                  showPreview={false}
                  buttonText="Upload files"
                  oncf-change={boundAddFiles}
                />
              )
              : (
                <cf-text tone="muted">
                  Create a profile in your home space to share files.
                </cf-text>
              )}

            {fileCount === 0
              ? <cf-text tone="muted">No files shared yet.</cf-text>
              : null}

            {files.map((file) => (
              <cf-card>
                <cf-hstack gap="3" align="center">
                  <cf-vstack gap="0" style="flex: 1; min-width: 0;">
                    <a
                      href={file.url}
                      download={file.name}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {file.name}
                    </a>
                    <cf-text variant="caption" tone="muted">
                      {formatSize(file.size)} · {file.mediaType}
                    </cf-text>
                  </cf-vstack>
                  <cf-profile-badge $profile={file.uploadedBy} size="xs" />
                  <cf-button
                    size="sm"
                    variant="ghost"
                    onClick={removeFile({ files, file })}
                  >
                    Remove
                  </cf-button>
                </cf-hstack>
              </cf-card>
            ))}
          </cf-vstack>
        </cf-screen>
      ),
      files,
      fileCount,
      addFiles: boundAddFiles,
      claimViewer: claimViewer({ viewer }),
    };
  },
);
