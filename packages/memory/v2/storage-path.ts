import * as Path from "@std/path";
import type { MemorySpace } from "../interface.ts";

export const encodeStoreSubject = (subject: MemorySpace): string => {
  const value = String(subject);
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("/") ||
    value.includes("\\") ||
    value === "." ||
    value === ".."
  ) {
    throw new Error(`Invalid memory space identifier for store path: ${value}`);
  }

  try {
    return encodeURIComponent(value);
  } catch {
    throw new Error(`Invalid memory space identifier for store path: ${value}`);
  }
};

/** Whether a store URL is a single-file (`*.sqlite` DB_PATH) store, as opposed
 *  to the default directory-mode store. The two modes realize per-space
 *  filenames differently — see resolveSpaceStoreUrl. */
const isSingleFileStore = (store: URL): boolean => {
  const storePath = store.protocol === "file:"
    ? Path.fromFileUrl(store)
    : store.pathname;
  return Path.extname(storePath) !== "";
};

/**
 * A configured store location as a filesystem path.
 *
 * `MEMORY_DIR` reaches a server as a URL — `packages/toolshed/env.ts` defaults
 * it to one, and the server hands it to `new URL()` — while a person setting it
 * writes a plain path, and `DB_PATH` is a path by its own rule. All three name
 * the same kind of place. A tool that walks the filesystem for the store a
 * server is serving needs the path, and composes this rather than testing for a
 * scheme itself: a `file:` URL left as it stands names no directory that exists,
 * so the tool finds nothing and reports the store as absent.
 *
 * The path comes back as the URL spells it, trailing separator and all, because
 * a directory path is what a caller asked for and tidying its shape is the job
 * of whatever joins onto it. A location this cannot read as a local path — a
 * `file:` URL that does not parse, or any other scheme — comes back as it
 * stands, for the caller to report as a location holding nothing rather than to
 * throw over.
 */
export const configuredStorePath = (location: string): string => {
  if (!location.startsWith("file:")) return location;
  try {
    return Path.fromFileUrl(location);
  } catch {
    return location;
  }
};

/**
 * The engine store root a server derives from its configured store location
 * (`MEMORY_DIR`, or `DB_PATH` in single-file mode).
 *
 * Lives here, beside {@link resolveSpaceStoreUrl}, because the two compose into
 * the on-disk layout and must be read together: this appends `engine-v3`, and
 * `resolveSpaceStoreUrl` then appends it AGAIN, so the realized directory-mode
 * path is `<MEMORY_DIR>/engine-v3/engine-v3/<did>.sqlite`. That doubling is
 * almost certainly unintentional, but every existing store depends on it, so it
 * cannot be removed without migrating them; `state-inspector/discover.ts` works
 * around it when hunting for stores.
 *
 * Anything that needs to READ or WRITE a store the server will serve must
 * compose these two functions rather than restating `engine-v3` — a third
 * spelling of the layout is how a tool ends up writing where nothing looks.
 */
export const resolveMemoryEngineStoreRootUrl = (
  storeUrl: URL,
  options: { singleFileMode?: boolean } = {},
): URL => {
  const storePath = Path.fromFileUrl(storeUrl);
  const isSingleFile = options.singleFileMode ?? Path.extname(storePath) !== "";
  const rootPath = isSingleFile
    ? Path.join(
      Path.dirname(storePath),
      `${Path.basename(storePath, Path.extname(storePath))}.engine-v3`,
    )
    : Path.join(storePath, "engine-v3");
  return Path.toFileUrl(`${rootPath}/`);
};

export const resolveSpaceStoreUrl = (
  store: URL,
  subject: MemorySpace,
): URL => {
  const filename = `${encodeStoreSubject(subject)}.sqlite`;
  const storePath = store.protocol === "file:"
    ? Path.fromFileUrl(store)
    : store.pathname;

  // NOTE: the two modes intentionally differ in how the filename is realized on
  // disk and this MUST NOT change — existing stores depend on it:
  //   * directory mode resolves the (percent-encoded) filename as a URL segment,
  //     so the encoding decodes away → `…/engine-v3/did:key:….sqlite` (the stem
  //     is the LITERAL space id).
  //   * single-file mode joins it as a literal path component, so the
  //     percent-encoding is preserved → `<stem>.engine-v3/did%3Akey%3A….sqlite`.
  // Changing either silently forks data into new per-space files on upgrade.
  // `spaceFromStoreFilename` below is the mode-aware inverse.
  if (!isSingleFileStore(store)) {
    return new URL(`./engine-v3/${filename}`, store);
  }

  const ext = Path.extname(storePath);
  const stem = ext === "" ? storePath : storePath.slice(0, -ext.length);
  return Path.toFileUrl(Path.join(`${stem}.engine-v3`, filename));
};

/**
 * The directory that holds per-space sqlite files for a given store. Directory
 * mode nests under `engine-v3/`; single-file mode (a `*.sqlite` DB_PATH) nests
 * under a sibling `<stem>.engine-v3/`. The directory itself is unambiguous in
 * both modes; per-file name encoding differs (see resolveSpaceStoreUrl), so
 * map filenames back to space ids with `spaceFromStoreFilename` — NOT a blanket
 * `decodeURIComponent`, which corrupts directory-mode ids containing literal
 * percent-sequences (e.g. a `did:web:…%3A8080`).
 */
export const resolveSpaceStoreDirUrl = (store: URL): URL => {
  const storePath = store.protocol === "file:"
    ? Path.fromFileUrl(store)
    : store.pathname;

  if (!isSingleFileStore(store)) {
    return new URL("./engine-v3/", store);
  }

  const ext = Path.extname(storePath);
  const stem = ext === "" ? storePath : storePath.slice(0, -ext.length);
  return Path.toFileUrl(`${stem}.engine-v3/`);
};

/**
 * Mode-aware inverse of the filename encoding in `resolveSpaceStoreUrl`: map an
 * on-disk `.sqlite` filename stem (from the store's space dir) back to the
 * space id. Directory-mode stems are the LITERAL id (the URL resolution already
 * decoded them); single-file-mode stems are still percent-encoded. Returns null
 * for a stem that cannot be a store filename we wrote (bad encoding).
 */
export const spaceFromStoreFilename = (
  store: URL,
  stem: string,
): string | null => {
  if (!isSingleFileStore(store)) return stem;
  try {
    return decodeURIComponent(stem);
  } catch {
    return null;
  }
};
