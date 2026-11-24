/**
 * Builds a pager {@link Document} from a unified diff, plus the offset maps the
 * semantic layer needs to answer type/definition queries against the CURRENT
 * workspace files the diff names.
 *
 * Source rendering keeps the diff text verbatim. Rendered mode replaces the
 * body of files whose languages provide a rendered representation while
 * retaining every diff marker and source line. Context and addition lines
 * whose content matches the workspace file reuse that complete file. Removed
 * lines use the complete old file, loaded from Git or reconstructed from the
 * complete new file. Lines without either complete file use a per-hunk
 * fragment. Complete files are parsed only for the file sections a build
 * cannot reuse from an earlier build.
 *
 * The structure tree is: file (a `section` node) → hunk → the workspace file's
 * own structure nodes, clamped and remapped into diff coordinates. So WASD and
 * the info card navigate the same patterns/builders/schemas the source view
 * would show, scoped to what the diff touches.
 */

import { dirname, isAbsolute, join, relative } from "@std/path";

import { spawnSync } from "@node/child_process";

import { spliceAll } from "@commonfabric/collections/splice";

import { cpLen } from "./ansi.ts";
import type { PendingParses } from "./backgroundparse.ts";
import type { DiffFile, DiffHunk, DiffModel } from "./diff.ts";
import type { DeclaredTests } from "./fold.ts";
import type { Language } from "./languages/language.ts";
import {
  canRenderDiffLines,
  decodeLanguageInput,
  languageForFile,
  languageMatchingFilename,
  languageMatchingSources,
  readOnlyReasonFor,
  renderedLinesFor,
} from "./languages/language.ts";
import { plainTextLanguage } from "./languages/plain-text/language.ts";
import {
  codePointColumns,
  type ColumnOf,
  computeLineStarts,
  lineIndexOf,
} from "./lines.ts";
import type {
  Definition,
  Document,
  Line,
  Span,
  StructureNode,
  ViewMode,
} from "./model.ts";
import { flattenStructure } from "./model.ts";

/** How the diff document reaches the workspace. Injectable for tests. */
export interface DiffWorkspace {
  /** Resolve a diff-relative path to an absolute workspace path, or null. */
  resolve(path: string): string | null;

  /** Read an absolute path's current content, or null. */
  read(absPath: string): string | null;

  /** Report the UTF-8 BOM state recorded by the latest successful read. */
  hasUtf8Bom?(absPath: string): boolean | undefined;

  /** Write decoded text back with the encoding observed by {@link read}. */
  write?(absPath: string, text: string): void;

  /** Read a Git blob by object name, or null when it is unavailable. */
  readBlob?(object: string): string | null;

  /** Report the UTF-8 BOM state recorded for a successfully read Git blob. */
  blobHasUtf8Bom?(object: string): boolean | undefined;

  /** Read available Git blobs in bounded local Git batches. */
  readBlobs?(
    objects: readonly string[],
  ): ReadonlyMap<string, string>;

  /** The repository's `test` Git attribute for diff paths: a path where the
   * attribute is set is a test, one where it is unset is not, and one where it
   * is unspecified is absent from the result. */
  declaredTests?: DeclaredTests;
}

/**
 * The real workspace, rooted at the enclosing git repository (git emits paths
 * relative to the repo root) with the invocation directory as fallback (for
 * `git diff --relative` or plain `diff -u` output). Both resolution and reads
 * are bounded to those roots, so a crafted diff cannot name files outside the
 * workspace.
 */
export function realWorkspace(cwd: string): DiffWorkspace {
  const repoRoot = findRepoRoot(cwd);
  const bases = repoRoot && repoRoot !== cwd ? [repoRoot, cwd] : [cwd];
  // The bound is physical, not lexical: paths are canonicalized before the
  // containment check, so an in-repo symlink pointing outside the workspace
  // cannot smuggle an outside file in.
  const realBases = bases.map((b) => safeRealPath(b) ?? b);
  const within = (abs: string, base: string): boolean => {
    const rel = relative(base, abs);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  const bounded = (abs: string): boolean => {
    if (!bases.some((base) => within(abs, base))) return false; // lexical first
    const real = safeRealPath(abs);
    return real !== null && realBases.some((base) => within(real, base));
  };
  const blobCache = new Map<string, string | null>();
  const blobBomCache = new Map<string, boolean>();
  const encoders = new Map<string, (text: string) => Uint8Array>();
  const fileBomCache = new Map<string, boolean>();
  const testAttributes = new Map<string, boolean | undefined>();
  const readBlobs = (
    objects: readonly string[],
  ): ReadonlyMap<string, string> => {
    const valid = [...new Set(objects.filter(validGitObject))];
    const missing = valid.filter((object) => !blobCache.has(object));
    const loadedBomStates = new Map<string, boolean>();
    const loaded = repoRoot === null
      ? new Map<string, string>()
      : readGitBlobs(repoRoot, missing, undefined, loadedBomStates);
    for (const object of missing) {
      blobCache.set(object, loaded.get(object) ?? null);
      const hasBom = loadedBomStates.get(object);
      if (hasBom !== undefined) blobBomCache.set(object, hasBom);
    }
    const found = new Map<string, string>();
    for (const object of valid) {
      const text = blobCache.get(object);
      if (text !== null && text !== undefined) found.set(object, text);
    }
    return found;
  };
  const resolve = (path: string): string | null => {
    if (isAbsolute(path)) return null; // diff paths are repo-relative
    for (const base of bases) {
      const abs = join(base, path);
      if (!bounded(abs)) continue; // `..` escapes and symlinks out: blocked
      // bounded() canonicalized abs via realPathSync, so statSync resolves;
      // only the file-vs-directory check remains. read() guards the contents.
      if (Deno.statSync(abs).isFile) return abs;
    }
    return null;
  };
  return {
    resolve,
    read(absPath) {
      if (!bounded(absPath)) return null;
      if (readOnlyReasonFor(languageForFile(absPath)) !== undefined) {
        return null;
      }
      try {
        const decoded = decodeLanguageInput(
          absPath,
          Deno.readFileSync(absPath),
        );
        if (readOnlyReasonFor(decoded.language) !== undefined) return null;
        encoders.set(absPath, decoded.source.encode);
        fileBomCache.set(absPath, decoded.source.hasUtf8Bom);
        return decoded.source.text;
      } catch {
        return null;
      }
    },
    write(absPath, text) {
      if (!bounded(absPath)) {
        throw new Error(`Cannot write outside the workspace: ${absPath}`);
      }
      const selected = languageForFile(absPath);
      const selectedReadOnlyReason = readOnlyReasonFor(selected);
      if (selectedReadOnlyReason !== undefined) {
        throw new Error(selectedReadOnlyReason);
      }
      let encode = encoders.get(absPath);
      if (encode === undefined) {
        const decoded = decodeLanguageInput(
          absPath,
          Deno.readFileSync(absPath),
        );
        const decodedReadOnlyReason = readOnlyReasonFor(decoded.language);
        if (decodedReadOnlyReason !== undefined) {
          throw new Error(decodedReadOnlyReason);
        }
        encode = decoded.source.encode;
        encoders.set(absPath, encode);
        fileBomCache.set(absPath, decoded.source.hasUtf8Bom);
      }
      Deno.writeFileSync(absPath, encode(text));
    },
    hasUtf8Bom(absPath) {
      return fileBomCache.get(absPath);
    },
    readBlob(object) {
      return readBlobs([object]).get(object) ?? null;
    },
    blobHasUtf8Bom(object) {
      return blobBomCache.get(object);
    },
    readBlobs,
    declaredTests(paths) {
      if (repoRoot === null) return new Map();
      // Git is asked about the file resolve() finds for a path, by its
      // repository-relative path, so a diff relative to the invocation
      // directory is asked about the right files; a path naming no file is
      // taken as relative to the repository. A path that lies outside the
      // repository declares nothing.
      const unread: string[] = [];
      const repoPaths: string[] = [];
      for (const path of new Set(paths)) {
        if (testAttributes.has(path)) continue;
        testAttributes.set(path, undefined);
        const abs: string | null = resolve(path) ??
          (isAbsolute(path) ? null : join(repoRoot, path));
        if (abs !== null && abs !== repoRoot && within(abs, repoRoot)) {
          unread.push(path);
          repoPaths.push(relative(repoRoot, abs));
        }
      }
      readTestAttributes(repoRoot, repoPaths).forEach((isTest, i) =>
        testAttributes.set(unread[i], isTest)
      );
      const declared = new Map<string, boolean>();
      for (const path of paths) {
        const isTest = testAttributes.get(path);
        if (isTest !== undefined) declared.set(path, isTest);
      }
      return declared;
    },
  };
}

// Paths go to `git check-attr` as arguments, which, unlike a request written to
// its input, cannot fill a pipe before its output is read. They go a batch at a
// time, so that a diff naming many files stays within every operating system's
// command-line limit, the smallest of which is Windows's 32,767 characters.
const MAX_CHECK_ATTR_ARGUMENTS_LENGTH = 16 * 1024;

/** The `test` attribute of each path inside the repository, relative to its
 * root, in order: true where it is set, false where it is unset, and
 * undefined where it is unspecified or where Git fails on the path's batch. */
function readTestAttributes(
  repoRoot: string,
  paths: readonly string[],
): (boolean | undefined)[] {
  const declared: (boolean | undefined)[] = [];
  for (const batch of batches(paths, MAX_CHECK_ATTR_ARGUMENTS_LENGTH)) {
    const result = tryOrNull(() =>
      new Deno.Command("git", {
        args: ["check-attr", "-z", "test", "--", ...batch],
        cwd: repoRoot,
        stdout: "piped",
        stderr: "null",
      }).outputSync()
    );
    // Git writes one record per path, in order, each three fields: the path,
    // the attribute's name, and its state.
    const fields = result?.success
      ? new TextDecoder().decode(result.stdout).split("\0")
      : [];
    for (let i = 0; i < batch.length; i++) {
      const state = fields[i * 3 + 2];
      declared.push(
        state === "set" ? true : state === "unset" ? false : undefined,
      );
    }
  }
  return declared;
}

/** Splits strings into consecutive batches whose lengths, counting one more
 * for each string's separator, stay within `limit`. A string longer than the
 * limit is a batch of its own. */
function* batches(
  items: readonly string[],
  limit: number,
): Generator<string[]> {
  let batch: string[] = [];
  let length = 0;
  for (const item of items) {
    if (batch.length > 0 && length + item.length + 1 > limit) {
      yield batch;
      batch = [];
      length = 0;
    }
    batch.push(item);
    length += item.length + 1;
  }
  if (batch.length > 0) yield batch;
}

function validGitObject(object: string): boolean {
  return /^[0-9a-f]{4,64}$/.test(object) && !/^0+$/.test(object);
}

function tryOrNull<T>(operation: () => T): T | null {
  try {
    return operation();
  } catch {
    return null;
  }
}

interface GitBatchOptions {
  cwd: string;
  env: Record<string, string>;
  input: string;
  maxBuffer: number;
}

type GitBatchRunner = (
  command: string,
  args: string[],
  options: GitBatchOptions,
) => { status: number | null; stdout: Uint8Array | null };

// Deno's Node-compatible `spawnSync()` writes all of its input before draining
// the child's output. One request therefore stays within POSIX's minimum atomic
// pipe capacity, so Git can accept it when a large first blob fills its output.
const MAX_GIT_BATCH_REQUEST_BYTES = 512;

/** Read several locally available Git objects in bounded batches. */
function readGitBlobs(
  repoRoot: string,
  objects: readonly string[],
  run: GitBatchRunner = (command, args, options) =>
    spawnSync(command, args, options),
  bomStates?: Map<string, boolean>,
): Map<string, string> {
  const blobs = new Map<string, string>();
  if (objects.length === 0) return blobs;
  return tryOrNull(() => {
    const loadedBomStates = new Map<string, boolean>();
    // Object names are ASCII, so their lengths are their sizes in bytes.
    for (const batch of batches(objects, MAX_GIT_BATCH_REQUEST_BYTES)) {
      if (!readGitBlobBatch(repoRoot, batch, blobs, run, loadedBomStates)) {
        return new Map<string, string>();
      }
    }
    for (const [object, hasBom] of loadedBomStates) {
      bomStates?.set(object, hasBom);
    }
    return blobs;
  }) ?? new Map<string, string>();
}

/** Read one request small enough to fit in an empty process input pipe. */
function readGitBlobBatch(
  repoRoot: string,
  objects: readonly string[],
  blobs: Map<string, string>,
  run: GitBatchRunner,
  bomStates?: Map<string, boolean>,
): boolean {
  const result = run("git", ["cat-file", "--batch"], {
    cwd: repoRoot,
    env: { ...Deno.env.toObject(), GIT_NO_LAZY_FETCH: "1" },
    input: `${objects.join("\n")}\n`,
    maxBuffer: Number.MAX_SAFE_INTEGER,
  });
  if (result.status !== 0 || !result.stdout) return false;
  for (
    const [object, blob] of parseGitBatchOutput(
      objects,
      new Uint8Array(result.stdout),
      bomStates,
    )
  ) {
    blobs.set(object, blob);
  }
  return true;
}

function parseGitBatchOutput(
  objects: readonly string[],
  output: Uint8Array,
  bomStates?: Map<string, boolean>,
): Map<string, string> {
  const blobs = new Map<string, string>();
  const decoder = new TextDecoder();
  let offset = 0;
  for (const object of objects) {
    const headerEnd = output.indexOf(10, offset);
    if (headerEnd < 0) break;
    const header = decoder.decode(output.subarray(offset, headerEnd));
    offset = headerEnd + 1;
    const match = header.match(/^[0-9a-f]{4,64} ([^ ]+) ([0-9]+)$/);
    if (!match) continue;
    const size = Number(match[2]);
    if (
      !Number.isSafeInteger(size) ||
      offset + size >= output.length || output[offset + size] !== 10
    ) {
      break;
    }
    const content = output.subarray(offset, offset + size);
    offset += size + 1;
    if (match[1] !== "blob") continue;
    const decoded = decodeLanguageInput(undefined, content);
    if (readOnlyReasonFor(decoded.language) === undefined) {
      blobs.set(object, decoded.source.text);
      bomStates?.set(object, decoded.source.hasUtf8Bom);
    }
  }
  return blobs;
}

function safeRealPath(path: string): string | null {
  return tryOrNull(() => Deno.realPathSync(path));
}

/** Nearest ancestor of `cwd` containing `.git` (a directory or a file). */
function findRepoRoot(cwd: string): string | null {
  let dir = cwd;
  for (let depth = 0; depth < 64; depth++) {
    try {
      Deno.statSync(join(dir, ".git"));
      return dir;
    } catch {
      // keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Where a diff's editable lines write back to. A verified new-side diff line
 * (context or addition) maps to a line of its workspace file; editing it (past
 * the marker) and saving rewrites that file line. Removed lines and diff
 * structure are not present.
 */
export interface DiffEdit {
  /** The diff text used to build this edit map. Commit-only views have no file
   * mappings, so the source text is also what makes their HEAD message
   * editable. */
  readonly sourceText?: string;

  /** Diff line → the file line it edits, with its marker width (1, or 0 for a
   * trimmed empty context line). */
  readonly lines: ReadonlyMap<
    number,
    { absPath: string; newLine: number; markerLen: number }
  >;

  /** The captured new-side content of each touched file, for splicing edited
   * lines back in on save. */
  readonly fileText: ReadonlyMap<string, string>;

  /** Highlights the complete old file of the parsed diff's file at
   * `fileIndex`. The live highlighter uses these spans when an edit creates a
   * removed line. */
  readonly oldFileLines: (fileIndex: number) => readonly Line[] | null;

  /**
   * The languages of each file's two sides, aligned with the parsed diff's
   * files, which recoloring an edited line and counting changes both use.
   */
  readonly languages: readonly DiffFileLanguages[];

  /** Every hunk, in document order, with the file and new-side range it covers
   * and whether its new side matched the workspace (so the captured content is
   * known to be the hunk's new side). Save matches the edited diff's hunks to
   * these by position — robust to repeated files/ranges in `git log -p` — and
   * rewrites only the verified ones. */
  readonly hunks: readonly DiffHunkInfo[];
}

export interface DiffHunkInfo {
  /** The workspace file the hunk maps to, or null when it resolves to none. */
  readonly absPath: string | null;

  readonly newStart: number;
  readonly newCount: number;
  readonly verified: boolean;

  /** Whether the reconstructed old file is encoded with a UTF-8 BOM. */
  readonly oldFileHasUtf8Bom?: boolean;

  /** Whether the captured new file is encoded with a UTF-8 BOM. */
  readonly newFileHasUtf8Bom?: boolean;

  /** The original diff marks the old side as having no final newline. */
  readonly oldNoTrailingNewline?: boolean;

  /** The original diff marks the new side as having no final newline. */
  readonly newNoTrailingNewline?: boolean;
}

/** Maps between diff-text offsets and workspace-file offsets, for semantics. */
export interface DiffMaps {
  /**
   * Absolute paths of the workspace files whose hunks the diff shows, in diff
   * order, each with the language its new side is read in.
   */
  readonly rootFiles: ReadonlyMap<string, Language>;

  /** Diff offset → (file, file offset), when the offset sits on code that is
   * present (and unchanged) in the current workspace file. */
  toFile(diffOffset: number): { path: string; offset: number } | null;

  /** File offset → diff offset, when that file line is visible in the diff. */
  fromFile(path: string, fileOffset: number): number | null;
}

interface FileMapping {
  readonly absPath: string;
  readonly language: Language;
  readonly fileText: string;
  readonly fileLineStarts: number[];

  /** new-file line → diff line, for content-verified ctx/add lines. */
  readonly newToDiff: Map<number, number>;
}

/**
 * What the builds of one session's diff keep between them: the workspace files
 * they read, the file sections the latest build in each view mode used, the
 * complete-file parses of the section built last, and the lines of the text
 * built last. A build reuses a section whose text and languages are unchanged,
 * wherever in the diff it now sits, and reads no workspace file that an
 * earlier build read. Every other complete-file parse lives only as long as
 * the build that made it.
 */
export class WorkspaceCache {
  #files = new Map<string, WorkspaceFile>();
  #sections = new Map<ViewMode, ReadonlyMap<string, BuiltSection>>();
  #recentParses: ReadonlyMap<string, LoadedFile> = new Map();
  #lines?: TextLines;

  /**
   * Returns the lines of `text`, which a build of the same text as the last
   * reuses.
   */
  linesOf(text: string): TextLines {
    if (this.#lines?.text !== text) {
      const lineStarts = computeLineStarts(text);
      this.#lines = {
        text,
        rawLines: text.split("\n"),
        lineStarts,
        columnOf: codePointColumns(text, lineStarts),
      };
    }
    return this.#lines;
  }

  /** The workspace copy of `absPath` that a build read, if one did. */
  file(absPath: string): WorkspaceFile | undefined {
    return this.#files.get(absPath);
  }

  /** Records `file` as the workspace copy of `absPath`, and returns it. */
  rememberFile(absPath: string, file: WorkspaceFile): WorkspaceFile {
    this.#files.set(absPath, file);
    return file;
  }

  /** The sections the latest build in `viewMode` used, by key. */
  sections(viewMode: ViewMode): ReadonlyMap<string, BuiltSection> {
    return this.#sections.get(viewMode) ?? new Map();
  }

  /**
   * The section the latest build in either view mode used for `key`,
   * preferring one built once every parse it reads had finished.
   */
  section(key: string): BuiltSection | undefined {
    let waiting: BuiltSection | undefined;
    for (const sections of this.#sections.values()) {
      const section = sections.get(key);
      if (section?.waitingOn.length === 0) return section;
      waiting ??= section;
    }
    return waiting;
  }

  /** The complete-file parses of the section built last, by key. */
  get recentParses(): ReadonlyMap<string, LoadedFile> {
    return this.#recentParses;
  }

  /**
   * Records what a build in `viewMode` used: its `sections`, and the
   * `recentParses` of the section it built last, when it built one.
   */
  rememberBuild(
    viewMode: ViewMode,
    sections: ReadonlyMap<string, BuiltSection>,
    recentParses: ReadonlyMap<string, LoadedFile> | undefined,
  ): void {
    this.#sections.set(viewMode, sections);
    if (recentParses) this.#recentParses = recentParses;
  }

  /** Forgets the workspace copy of `absPath` and everything built from it,
   * so that the next build reads the file again. */
  forget(absPath: string): void {
    this.#files.delete(absPath);
    for (const [viewMode, sections] of this.#sections) {
      this.#sections.set(
        viewMode,
        new Map(
          Array.from(sections).filter(([, section]) =>
            section.absPath !== absPath
          ),
        ),
      );
    }
    this.#recentParses = new Map(
      Array.from(this.#recentParses).filter(([key]) =>
        !key.startsWith(newFileKey(absPath, ""))
      ),
    );
  }

  /** Returns a new cache holding what this one does, except `absPaths`. */
  without(absPaths: Iterable<string>): WorkspaceCache {
    const copy = new WorkspaceCache();
    copy.#files = new Map(this.#files);
    copy.#sections = new Map(this.#sections);
    copy.#recentParses = this.#recentParses;
    copy.#lines = this.#lines;
    for (const absPath of absPaths) copy.forget(absPath);
    return copy;
  }
}

/** A diff's text split into lines, with where each line starts. */
interface TextLines {
  readonly text: string;
  readonly rawLines: readonly string[];
  readonly lineStarts: readonly number[];

  /** The code point column of a diff offset on a diff line. */
  readonly columnOf: ColumnOf;
}

/** A workspace file as one read found it. */
interface WorkspaceFile {
  readonly fileText: string | null;

  /** The encoding state kept outside the BOM-stripped text. */
  readonly hasUtf8Bom?: boolean;
}

/**
 * Everything a build produced for one file section of a diff, which a later
 * build of a diff with the same section reuses. Positions are those of the
 * section starting at diff line `line` and diff offset `offset`.
 */
interface BuiltSection {
  readonly line: number;
  readonly offset: number;

  /** The workspace file the section's new side resolved to, or null. */
  readonly absPath: string | null;

  /** The section's lines, from its header to its last line, which no build
   * changes once the section is built. */
  readonly lines: readonly MutableLine[];

  /** The section's `section` structure node. */
  readonly node: StructureNode;

  /** The names the section's structure declares, each in document order. */
  readonly definitions: ReadonlyMap<string, readonly Definition[]>;

  /** The section's hunks, in document order. */
  readonly hunks: readonly DiffHunkInfo[];

  /** The workspace file's verified lines in this section, when it has some. */
  readonly mapping: FileMapping | undefined;

  /** Highlights the complete old file the section's removed lines came from,
   * returning null while its parse is pending. */
  readonly oldFileLines: () => readonly Line[] | null;

  /**
   * The keys of the complete-file parses that were pending when the section
   * was built, whose files its lines show as plain text. A build reuses the
   * section while any of them is still pending, and builds it again once none
   * is, so that the section takes each finished parse once.
   */
  readonly waitingOn: readonly string[];
}

/**
 * Moves `section` to start at diff line `line` and diff offset `offset`,
 * returning it unchanged when it already starts there.
 */
function placedSection(
  section: BuiltSection,
  line: number,
  offset: number,
): BuiltSection {
  const lines = line - section.line;
  const offsets = offset - section.offset;
  if (lines === 0 && offsets === 0) return section;
  const top: StructureNode[] = [];
  const pending: [StructureNode, StructureNode[]][] = [[section.node, top]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [node, into] = next;
    const children: StructureNode[] = [];
    into.push({
      ...node,
      ...(node.nameOffset === undefined
        ? {}
        : { nameOffset: node.nameOffset + offsets }),
      startLine: node.startLine + lines,
      endLine: node.endLine + lines,
      startOffset: node.startOffset + offsets,
      endOffset: node.endOffset + offsets,
      children,
    });
    for (let at = node.children.length - 1; at >= 0; at--) {
      pending.push([node.children[at], children]);
    }
  }
  return {
    ...section,
    line,
    offset,
    node: top[0],
    definitions: new Map(
      Array.from(section.definitions, ([name, list]) => [
        name,
        list.map((definition) => ({
          ...definition,
          startLine: definition.startLine + lines,
          endLine: definition.endLine + lines,
          startOffset: definition.startOffset + offsets,
          endOffset: definition.endOffset + offsets,
        })),
      ]),
    ),
    mapping: section.mapping && {
      ...section.mapping,
      newToDiff: new Map(
        Array.from(
          section.mapping.newToDiff,
          ([fileLine, diffLine]) => [fileLine, diffLine + lines],
        ),
      ),
    },
  };
}

/**
 * Parses the complete file `key` names with `parse`, or returns a parse that
 * a section built earlier made of it.
 */
type SharedParse = (key: string, parse: () => LoadedFile) => LoadedFile;

/**
 * Shares complete-file parses between the sections of one build, starting
 * from `recent`. A parse is kept only until the last of the uses `keys`
 * counts, so a build holds the parses that later sections still need and no
 * others.
 *
 * @throws {Error} When asked for a key `keys` does not count.
 */
function sharedParse(
  keys: readonly string[],
  recent: ReadonlyMap<string, LoadedFile>,
): SharedParse {
  const remaining = new Map<string, number>();
  for (const key of keys) remaining.set(key, (remaining.get(key) ?? 0) + 1);
  const parsed = new Map<string, LoadedFile>();
  return (key, parse) => {
    const left = remaining.get(key);
    if (left === undefined) {
      throw new Error(`A diff build parsed ${key}, which it did not count.`);
    }
    const file = parsed.get(key) ?? recent.get(key) ?? parse();
    remaining.set(key, left - 1);
    if (left > 1) {
      parsed.set(key, file);
    } else {
      parsed.delete(key);
    }
    return file;
  };
}

/** The complete files that building one file section parses. */
interface SectionParses {
  /** The section's new side, read from its workspace file. */
  readonly newFile?: { readonly key: string; readonly absPath: string };

  /** The section's old side, read from its Git blob. */
  readonly oldBlob?: { readonly key: string; readonly object: string };
}

/** The key of the parse of workspace file `absPath` in the language whose
 * identifier is `languageId`. */
function newFileKey(absPath: string, languageId: string): string {
  return `${absPath}\0${languageId}`;
}

/** The key of the parse of Git blob `object`, named `fileName`, in
 * `language`. */
function oldBlobKey(
  fileName: string | undefined,
  object: string,
  language: Language,
): string {
  return `\0diff-old-blob:${JSON.stringify([fileName, object, language.id])}`;
}

/** A complete file a build parsed, which lives only as long as that build. */
interface LoadedFile {
  fileText: string | null;
  fileDoc: Document | null;
  fileLineStarts: number[];

  /** The encoding state kept outside the BOM-stripped parser text. */
  hasUtf8Bom?: boolean;

  /** Syntax-only lines used by complete old files. */
  highlightedLines?: readonly Line[] | null;

  /** Alternate rendered lines, computed once when that view is opened. */
  renderedLines?: readonly Line[] | null;

  /** Set when the file's parse is still pending, so that its lines are
   * plain text. */
  pending?: true;

  /** The key the parse of a complete old file is named by. */
  key?: string;
}

/**
 * Parses workspace file `absPath` in `language` under `key`, as plain text
 * while the parse `build.pending` names `key` is pending. Two sections of
 * `git log -p` output can read one workspace file in two languages when each
 * shows a different first line, so a parse serves only the language it was
 * made in.
 */
function loadFile(
  { key, absPath }: NonNullable<SectionParses["newFile"]>,
  language: Language,
  build: SectionBuild,
): LoadedFile {
  return build.parse(key, () => {
    const { fileText, hasUtf8Bom } = build.cache.file(absPath) ??
      build.cache.rememberFile(absPath, readWorkspaceFile(build.ws, absPath));
    if (fileText === null) {
      return { fileText, fileDoc: null, fileLineStarts: [], hasUtf8Bom };
    }
    const fileDoc = build.pending
      ? build.pending.document(key, language, fileText, absPath)
      : language.parseDocument(fileText, absPath);
    return {
      fileText,
      fileDoc: fileDoc ?? plainTextLanguage.parseDocument(fileText, absPath),
      fileLineStarts: computeLineStarts(fileText),
      hasUtf8Bom,
      ...(fileDoc === null ? { pending: true } : {}),
    };
  });
}

/** Reads workspace file `absPath` with its encoding state. */
function readWorkspaceFile(ws: DiffWorkspace, absPath: string): WorkspaceFile {
  const fileText = ws.read(absPath);
  return {
    fileText,
    hasUtf8Bom: fileText === null ? undefined : ws.hasUtf8Bom?.(absPath),
  };
}

function isNoNewlineMarker(line: string | undefined): boolean {
  return line?.replace(/\r$/, "") === "\\ No newline at end of file";
}

/** A hunk body line without its diff marker. */
function diffBodyText(
  rawLines: readonly string[],
  hunk: DiffHunk,
  line: number,
  stripTransport = false,
): string {
  let text = rawLines[line].slice(1);
  if (
    rawLines[hunk.headerLine].endsWith("\r") &&
    (stripTransport || isNoNewlineMarker(rawLines[line + 1])) &&
    text.endsWith("\r")
  ) {
    text = text.slice(0, -1);
  }
  return text;
}

function diffBodyMatches(
  sourceText: string,
  rawLines: readonly string[],
  hunk: DiffHunk,
  line: number,
  sourceLine?: number,
  sourceHasUtf8Bom?: boolean,
): boolean {
  const exactBody = diffBodyText(rawLines, hunk, line);
  if (
    sourceLine === 0 && sourceHasUtf8Bom !== undefined &&
    exactBody.startsWith("\uFEFF") !== sourceHasUtf8Bom
  ) {
    return false;
  }
  const exact = decodedInitialDiffBodyLine(
    exactBody,
    sourceLine,
  );
  const transportStripped = decodedInitialDiffBodyLine(
    diffBodyText(rawLines, hunk, line, true),
    sourceLine,
  );
  return sourceText === exact || sourceText === transportStripped;
}

/** Remove the encoding marker while reading an original diff body. */
function decodedInitialDiffBodyLine(
  body: string,
  sourceLine: number | undefined,
): string {
  return sourceLine === 0 ? body.replace(/^\uFEFF/, "") : body;
}

function contentLines(text: string, hasUtf8Bom = false): string[] {
  if (text.length === 0) return hasUtf8Bom ? [""] : [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

function belongsToSide(
  kind: DiffModel["lines"][number]["kind"] | undefined,
  side: "old" | "new",
): boolean {
  return kind === "ctx" || kind === (side === "old" ? "del" : "add");
}

function noTrailingNewline(
  hunk: DiffHunk,
  side: "old" | "new",
  rawLines: readonly string[],
  modelLines: DiffModel["lines"],
): boolean {
  for (let i = hunk.headerLine + 1; i <= hunk.endLine; i++) {
    if (!isNoNewlineMarker(rawLines[i])) continue;
    const previous = modelLines[i - 1]?.kind;
    if (belongsToSide(previous, side)) return true;
  }
  return false;
}

/** The BOM state declared by a side when a hunk includes its first line. */
function hunkSideHasUtf8Bom(
  hunk: DiffHunk,
  side: "old" | "new",
  rawLines: readonly string[],
  modelLines: DiffModel["lines"],
): boolean | undefined {
  for (let i = hunk.headerLine + 1; i <= hunk.endLine; i++) {
    const entry = modelLines[i];
    if (!belongsToSide(entry?.kind, side)) continue;
    const sourceLine = side === "old" ? entry.oldLine : entry.newLine;
    if (sourceLine === 0) {
      return diffBodyText(rawLines, hunk, i).startsWith("\uFEFF");
    }
  }
  return undefined;
}

function fileSideHasUtf8Bom(
  file: DiffFile,
  side: "old" | "new",
  rawLines: readonly string[],
  modelLines: DiffModel["lines"],
): boolean | undefined {
  for (const hunk of file.hunks) {
    const hasBom = hunkSideHasUtf8Bom(hunk, side, rawLines, modelLines);
    if (hasBom !== undefined) return hasBom;
  }
  return undefined;
}

/** Whether every visible line on one side agrees with a complete file. */
function fileMatchesSide(
  file: DiffFile,
  side: "old" | "new",
  text: string,
  rawLines: readonly string[],
  modelLines: DiffModel["lines"],
  hasUtf8Bom?: boolean,
): boolean {
  if (
    text.length === 0 && hasUtf8Bom &&
    fileSideHasUtf8Bom(file, side, rawLines, modelLines) !== true
  ) {
    return false;
  }
  const sourceLines = contentLines(text, hasUtf8Bom);
  for (const hunk of file.hunks) {
    for (let i = hunk.headerLine + 1; i <= hunk.endLine; i++) {
      const entry = modelLines[i];
      if (!belongsToSide(entry?.kind, side)) continue;
      const sourceLine = side === "old" ? entry.oldLine : entry.newLine;
      if (
        sourceLine === undefined ||
        !diffBodyMatches(
          sourceLines[sourceLine],
          rawLines,
          hunk,
          i,
          sourceLine,
          hasUtf8Bom,
        )
      ) {
        return false;
      }
    }
    if (
      noTrailingNewline(hunk, side, rawLines, modelLines) &&
      text.endsWith("\n")
    ) {
      return false;
    }
  }
  return true;
}

function hunkSideLines(
  hunk: DiffHunk,
  side: "old" | "new",
  rawLines: readonly string[],
  modelLines: DiffModel["lines"],
  stripTransport = false,
): string[] {
  const out: string[] = [];
  for (let i = hunk.headerLine + 1; i <= hunk.endLine; i++) {
    const kind = modelLines[i]?.kind;
    if (belongsToSide(kind, side)) {
      const sourceLine = side === "old"
        ? modelLines[i]?.oldLine
        : modelLines[i]?.newLine;
      const text = diffBodyText(rawLines, hunk, i, stripTransport);
      out.push(decodedInitialDiffBodyLine(text, sourceLine));
    }
  }
  return out;
}

function hunkStart(start: number, count: number): number {
  return count === 0 ? start : start - 1;
}

/**
 * Reverse every hunk against a verified complete new file. Applying from the
 * bottom preserves the line numbers of the hunks above.
 */
function reconstructOldFile(
  file: DiffFile,
  newText: string,
  rawLines: readonly string[],
  modelLines: DiffModel["lines"],
  newHasUtf8Bom?: boolean,
): string | null {
  if (
    !fileMatchesSide(
      file,
      "new",
      newText,
      rawLines,
      modelLines,
      newHasUtf8Bom,
    )
  ) return null;

  const lines = contentLines(newText, newHasUtf8Bom);
  let trailingNewline = newText.endsWith("\n");
  const hunks = [...file.hunks].sort((a, b) => {
    const byStart = hunkStart(b.newStart, b.newCount) -
      hunkStart(a.newStart, a.newCount);
    return byStart || b.headerLine - a.headerLine;
  });
  for (const hunk of hunks) {
    let oldSide = hunkSideLines(hunk, "old", rawLines, modelLines);
    let newSide = hunkSideLines(hunk, "new", rawLines, modelLines);
    if (
      oldSide.length !== hunk.oldCount || newSide.length !== hunk.newCount
    ) {
      return null;
    }
    const start = hunkStart(hunk.newStart, hunk.newCount);
    if (
      start < 0 || start + newSide.length > lines.length
    ) {
      return null;
    }
    const current = lines.slice(start, start + newSide.length);
    if (current.some((line, i) => line !== newSide[i])) {
      newSide = hunkSideLines(hunk, "new", rawLines, modelLines, true);
      if (current.some((line, i) => line !== newSide[i])) return null;
      oldSide = hunkSideLines(hunk, "old", rawLines, modelLines, true);
    }
    const touchesEnd = start + newSide.length === lines.length;
    spliceAll(lines, start, newSide.length, oldSide);
    if (touchesEnd) {
      trailingNewline = !noTrailingNewline(
        hunk,
        "old",
        rawLines,
        modelLines,
      );
    }
  }
  const oldText = lines.length === 0
    ? ""
    : lines.join("\n") + (trailingNewline ? "\n" : "");
  const oldHasUtf8Bom = fileSideHasUtf8Bom(
    file,
    "old",
    rawLines,
    modelLines,
  ) ?? newHasUtf8Bom;
  return fileMatchesSide(
      file,
      "old",
      oldText,
      rawLines,
      modelLines,
      oldHasUtf8Bom,
    )
    ? oldText
    : null;
}

/**
 * Highlights the complete old file `fileText`, as plain text while the parse
 * `pending` names `key` is pending.
 */
function highlightedFile(
  key: string,
  fileText: string | null,
  fileName: string | undefined,
  language: Language,
  hasUtf8Bom: boolean | undefined,
  pending: PendingParses | undefined,
): LoadedFile {
  const lines = fileText === null
    ? null
    : oldFileHighlight(key, fileText, fileName, language, pending);
  return {
    fileText,
    fileDoc: null,
    fileLineStarts: [],
    hasUtf8Bom,
    key,
    highlightedLines: fileText !== null && lines === null
      ? plainTextLanguage.highlightLines(fileText, fileName)
      : lines,
    ...(fileText !== null && lines === null ? { pending: true } : {}),
  };
}

/**
 * Highlights the complete old file `text` as `language` reads it, or returns
 * null while the parse `pending` names `key` is pending.
 */
function oldFileHighlight(
  key: string,
  text: string,
  fileName: string | undefined,
  language: Language,
  pending: PendingParses | undefined,
): readonly Line[] | null {
  return pending
    ? pending.lines(key, language, text, fileName)
    : language.highlightLines(text, fileName);
}

/** The key of the parse of the old side of the diff's file at `fileIndex`,
 * reconstructed from its new side, in `language`. */
function reconstructedOldKey(
  file: DiffFile,
  fileIndex: number,
  language: Language,
): string {
  return `\0diff-old:${
    JSON.stringify([fileIndex, file.oldPath, file.newPath, language.id])
  }`;
}

/** The complete file lines to show for one view mode. */
function displayedFileLines(
  file: LoadedFile | null,
  language: Language,
  fileName: string | undefined,
  mode: ViewMode,
): readonly Line[] | null {
  if (!file) return null;
  const source = file.fileDoc?.lines ?? file.highlightedLines ?? null;
  if (
    mode === "source" || !canRenderDiffLines(language) ||
    file.fileText === null
  ) {
    return source;
  }
  if (file.renderedLines === undefined) {
    file.renderedLines = renderedLinesFor(language, file.fileText, fileName) ??
      null;
  }
  return file.renderedLines ?? source;
}

/**
 * Load and highlight the complete old side represented by one diff file, from
 * `oldBlob` when that matches the diff and otherwise by reversing the diff
 * against `newFile`.
 */
function loadOldFile(
  file: DiffFile,
  language: Language,
  newFile: LoadedFile | null,
  oldBlob: SectionParses["oldBlob"],
  reconstructedKey: string,
  build: SectionBuild,
): LoadedFile {
  const { rawLines, modelLines, ws } = build;
  if (file.hunks.length === 0 || readOnlyReasonFor(language) !== undefined) {
    return {
      fileText: null,
      fileDoc: null,
      fileLineStarts: [],
      highlightedLines: null,
    };
  }
  const fileName = file.oldPath ?? file.newPath;
  const inferredOldHasUtf8Bom = fileSideHasUtf8Bom(
    file,
    "old",
    rawLines,
    modelLines,
  ) ?? newFile?.hasUtf8Bom;
  if (oldBlob !== undefined) {
    const { key, object } = oldBlob;
    const blob = build.parse(key, () => {
      const blobText = oldBlobText(object, build.oldBlobs, ws);
      return highlightedFile(
        key,
        blobText,
        fileName,
        language,
        blobText === null
          ? undefined
          : ws.blobHasUtf8Bom?.(object) ?? inferredOldHasUtf8Bom,
        build.pending,
      );
    });
    if (
      blob.fileText !== null &&
      fileMatchesSide(
        file,
        "old",
        blob.fileText,
        rawLines,
        modelLines,
        blob.hasUtf8Bom,
      )
    ) {
      return blob;
    }
  }

  const newText = newFile?.fileText ?? null;
  const fileText = newText === null ? null : reconstructOldFile(
    file,
    newText,
    rawLines,
    modelLines,
    newFile?.hasUtf8Bom,
  );
  return highlightedFile(
    reconstructedKey,
    fileText,
    fileName,
    language,
    inferredOldHasUtf8Bom,
    build.pending,
  );
}

/**
 * The text of the old Git blob `object`, or null when it is not a blob name or
 * the workspace cannot read it.
 */
function oldBlobText(
  object: string,
  oldBlobs: ReadonlyMap<string, string> | undefined,
  ws: DiffWorkspace,
): string | null {
  if (!validGitObject(object)) return null;
  return oldBlobs
    ? oldBlobs.get(object) ?? null
    : ws.readBlob?.(object) ?? null;
}

/** The languages the two sides of one diff file are read in. */
export interface DiffFileLanguages {
  readonly oldLanguage: Language;
  readonly newLanguage: Language;
}

/**
 * Decides the language of both sides of every file in a diff, aligned with
 * `model.files`. A language that claims a side's path settles that side.
 * Otherwise the side's content does: a hunk that starts at its first line,
 * which shows that side exactly, and then, for a file with hunks, its complete
 * file when `ws` has one (the workspace file for the new side, the old Git blob
 * for the old side). A side that neither settles takes the other side's
 * language, and plain text when that is unsettled too.
 */
export function diffLanguages(
  text: string,
  model: DiffModel,
  ws: DiffWorkspace = { resolve: () => null, read: () => null },
): DiffFileLanguages[] {
  const rawLines = text.split("\n");
  const oldBlobs = ws.readBlobs?.(
    oldObjects(
      model,
      (file) =>
        languageMatchingFilename(file.oldPath ?? file.newPath) === undefined,
    ),
  );
  const firstLines = function* (file: DiffFile, side: "old" | "new") {
    const hunk = file.hunks.find((hunk) =>
      side === "old"
        ? hunk.oldStart === 1 && hunk.oldCount > 0
        : hunk.newStart === 1 && hunk.newCount > 0
    );
    if (hunk) {
      yield hunkSideLines(hunk, side, rawLines, model.lines).join("\n");
    }
  };
  const newSources = function* (file: DiffFile) {
    yield* firstLines(file, "new");
    const absPath = file.hunks.length > 0 && file.newPath
      ? ws.resolve(file.newPath)
      : null;
    const fileText = absPath ? ws.read(absPath) : null;
    if (fileText !== null) yield fileText;
  };
  const oldSources = function* (file: DiffFile) {
    yield* firstLines(file, "old");
    const blob = file.oldObject
      ? oldBlobText(file.oldObject, oldBlobs, ws)
      : null;
    if (blob !== null) yield blob;
  };
  return model.files.map((file) => {
    const newLanguage = languageMatchingSources(
      file.newPath ?? file.oldPath,
      newSources(file),
    );
    const oldLanguage = languageMatchingSources(
      file.oldPath ?? file.newPath,
      oldSources(file),
    );
    return {
      oldLanguage: oldLanguage ?? newLanguage ?? plainTextLanguage,
      newLanguage: newLanguage ?? oldLanguage ?? plainTextLanguage,
    };
  });
}

/**
 * The old Git objects of the files `wanted` selects whose old side a hunk
 * shows.
 */
function oldObjects(
  model: DiffModel,
  wanted: (file: DiffFile, fileIndex: number) => boolean,
): string[] {
  return model.files.flatMap((file, fileIndex) => {
    const object = shownOldObject(file);
    return object !== undefined && wanted(file, fileIndex) ? [object] : [];
  });
}

/** The old Git object of `file`, when it names one and a hunk shows it. */
function shownOldObject(file: DiffFile): string | undefined {
  return file.hunks.length > 0 && file.oldObject !== undefined &&
      validGitObject(file.oldObject)
    ? file.oldObject
    : undefined;
}

/**
 * Builds the document, semantic maps, and edit targets for a diff, reading
 * each file side in the language `languages` gives it. The maps and the edit
 * targets are built when first read. A file section that `cache` holds from
 * an earlier build is reused rather than built again. A complete file whose
 * parse `pending` leaves pending is shown as plain text, and a section that
 * reads it is built again by the first build after every such parse it reads
 * has finished.
 *
 * @throws {Error} When `languages` does not hold one entry for each of the
 * diff's files.
 */
export function buildDiffDocument(
  text: string,
  model: DiffModel,
  ws: DiffWorkspace,
  cache: WorkspaceCache = new WorkspaceCache(),
  viewMode: ViewMode = "source",
  languages: readonly DiffFileLanguages[] = diffLanguages(text, model, ws),
  pending?: PendingParses,
): { doc: Document; maps: DiffMaps; edit: DiffEdit } {
  if (languages.length !== model.files.length) {
    throw new Error(
      `A diff of ${model.files.length} files was given languages for ${languages.length}.`,
    );
  }
  const { rawLines, lineStarts: diffLineStarts, columnOf } = cache.linesOf(
    text,
  );
  // A file section's lines are its own; every other line is plain text.
  const lines = new Array<MutableLine>(rawLines.length);
  const plain = (from: number, to: number) => {
    for (let i = from; i < to; i++) {
      lines[i] = plainLine(rawLines[i], model.lines[i]?.kind);
    }
  };
  let unclaimed = 0;
  for (const file of model.files) {
    plain(unclaimed, file.headerLine);
    unclaimed = file.endLine + 1;
  }
  plain(unclaimed, rawLines.length);
  const sections = model.files.map((file, fileIndex) => {
    const { oldLanguage, newLanguage } = languages[fileIndex];
    const sectionText = text.slice(
      diffLineStarts[file.headerLine],
      lineEndOffset(diffLineStarts, text, file.endLine),
    );
    // A section that neither side renders builds alike in both view modes.
    const mode =
      canRenderDiffLines(oldLanguage) || canRenderDiffLines(newLanguage)
        ? viewMode
        : "";
    const key = `${oldLanguage.id}\0${newLanguage.id}\0${mode}\0${sectionText}`;
    const known = cache.section(key);
    const reused = known?.waitingOn.length === 0 ||
        known?.waitingOn.some((parse) => pending?.waiting(parse))
      ? known
      : undefined;
    return reused
      ? { key, reused }
      : { key, reused, parses: sectionParses(file, languages[fileIndex], ws) };
  });
  const build: SectionBuild = {
    text,
    rawLines,
    modelLines: model.lines,
    lines,
    diffLineStarts,
    diffColumnOf: columnOf,
    ws,
    cache,
    viewMode,
    pending,
    oldBlobs: ws.readBlobs?.(
      sections.flatMap((section) =>
        section.reused === undefined && section.parses.oldBlob
          ? [section.parses.oldBlob.object]
          : []
      ),
    ),
    parse: sharedParse(
      sections.flatMap((section) =>
        section.reused === undefined
          ? [section.parses.newFile?.key, section.parses.oldBlob?.key].filter(
            (key) => key !== undefined,
          )
          : []
      ),
      cache.recentParses,
    ),
  };

  const used = new Map<string, BuiltSection>();
  let recentParses: Map<string, LoadedFile> | undefined;
  const structure: StructureNode[] = [];
  const definitions = new Map<string, Definition[]>();
  const sectionMappings: FileMapping[] = [];
  const hunks: DiffHunkInfo[] = [];
  const oldFileLines: (() => readonly Line[] | null)[] = [];
  for (const [fileIndex, file] of model.files.entries()) {
    const source = sections[fileIndex];
    let section: BuiltSection;
    if (source.reused === undefined) {
      // A section colors its lines in place, starting from plain text.
      plain(file.headerLine, file.endLine + 1);
      const recorded = new Map<string, LoadedFile>();
      section = buildSection(
        file,
        fileIndex,
        languages[fileIndex],
        source.parses,
        { ...build, parse: recordedParse(build.parse, recorded) },
      );
      if (section.waitingOn.length === 0) recentParses = recorded;
    } else {
      section = placedSection(
        source.reused,
        file.headerLine,
        diffLineStarts[file.headerLine],
      );
      for (const [i, line] of section.lines.entries()) {
        lines[file.headerLine + i] = line;
      }
    }
    used.set(source.key, section);
    structure.push(section.node);
    for (const [name, list] of section.definitions) {
      const all = definitions.get(name) ?? [];
      for (const definition of list) all.push(definition);
      definitions.set(name, all);
    }
    for (const hunk of section.hunks) hunks.push(hunk);
    if (section.mapping) sectionMappings.push(section.mapping);
    oldFileLines.push(section.oldFileLines);
  }
  cache.rememberBuild(viewMode, used, recentParses);

  const flatStructure = flattenStructure(structure);

  const doc: Document = {
    text,
    lines,
    structure,
    flatStructure,
    definitions,
  };
  let mappings: Map<string, FileMapping> | undefined;
  let maps: DiffMaps | undefined;
  let edit: DiffEdit | undefined;
  return {
    doc,
    get maps() {
      return maps ??= buildMaps(
        diffLineStarts,
        rawLines,
        mappings ??= mergedMappings(sectionMappings),
      );
    },
    get edit() {
      return edit ??= buildEdit(
        text,
        rawLines,
        mappings ??= mergedMappings(sectionMappings),
        hunks,
        latestOldFileLines(oldFileLines),
        languages,
      );
    },
  };
}

/**
 * The verified lines of each workspace file across the sections that show it,
 * from each section's own, by path. A file that several sections show keeps
 * its first verified occurrence of each line, as each section does within
 * itself.
 */
function mergedMappings(
  sectionMappings: readonly FileMapping[],
): Map<string, FileMapping> {
  const mappings = new Map<string, FileMapping>();
  for (const sectionMapping of sectionMappings) {
    const { absPath, newToDiff } = sectionMapping;
    const mapping = mappings.get(absPath) ??
      { ...sectionMapping, newToDiff: new Map() };
    for (const [fileLine, diffLine] of newToDiff) {
      if (!mapping.newToDiff.has(fileLine)) {
        mapping.newToDiff.set(fileLine, diffLine);
      }
    }
    mappings.set(absPath, mapping);
  }
  return mappings;
}

/** What every file section of one build reads. */
interface SectionBuild {
  readonly text: string;
  readonly rawLines: readonly string[];
  readonly modelLines: DiffModel["lines"];

  /** The build's lines, indexed by diff line, which a section colors. */
  readonly lines: MutableLine[];

  readonly diffLineStarts: readonly number[];
  readonly diffColumnOf: ColumnOf;
  readonly ws: DiffWorkspace;
  readonly cache: WorkspaceCache;
  readonly viewMode: ViewMode;

  /** The parses left to finish in the background, which show as plain text
   * until they do. */
  readonly pending: PendingParses | undefined;

  readonly oldBlobs: ReadonlyMap<string, string> | undefined;
  readonly parse: SharedParse;
}

/** A diff line with no color beyond the plain text of an unclaimed line. */
function plainLine(
  text: string,
  kind: DiffModel["lines"][number]["kind"] | undefined,
): MutableLine {
  return {
    text,
    spans: (kind ?? "other") === "other" && text.length > 0
      ? [{ col: 0, text, cls: "plain" }]
      : [],
  };
}

/** Like `parse`, except that it also records each parse it returns. */
function recordedParse(
  parse: SharedParse,
  record: Map<string, LoadedFile>,
): SharedParse {
  return (key, parseFile) => {
    const file = parse(key, parseFile);
    record.set(key, file);
    return file;
  };
}

/**
 * The complete files that building `file` parses: its workspace file, where
 * `ws` resolves one, and its old Git blob, in the languages `languages` gives.
 * A read-only language and a section without hunks parse nothing.
 */
function sectionParses(
  file: DiffFile,
  { oldLanguage, newLanguage }: DiffFileLanguages,
  ws: DiffWorkspace,
): SectionParses {
  if (file.hunks.length === 0) return {};
  const absPath = file.newPath && readOnlyReasonFor(newLanguage) === undefined
    ? ws.resolve(file.newPath)
    : null;
  const object = shownOldObject(file);
  return {
    ...(absPath
      ? { newFile: { key: newFileKey(absPath, newLanguage.id), absPath } }
      : {}),
    ...(object !== undefined && readOnlyReasonFor(oldLanguage) === undefined
      ? {
        oldBlob: {
          key: oldBlobKey(file.oldPath ?? file.newPath, object, oldLanguage),
          object,
        },
      }
      : {}),
  };
}

/**
 * Builds one file section of a diff, the diff's file at `fileIndex`, reading
 * its two sides in `languages` and parsing the complete files `parses` names.
 */
function buildSection(
  file: DiffFile,
  fileIndex: number,
  { oldLanguage, newLanguage }: DiffFileLanguages,
  parses: SectionParses,
  build: SectionBuild,
): BuiltSection {
  const { rawLines, modelLines, lines, diffLineStarts, viewMode } = build;
  // Every operation on a file side — parsing the workspace copy, coloring
  // fragments, projecting structure — dispatches through its language.
  const loaded = parses.newFile
    ? loadFile(parses.newFile, newLanguage, build)
    : null;
  const absPath = parses.newFile?.absPath ?? null;
  const fileText = loaded?.fileText ?? null;
  const fileDoc = loaded?.fileDoc ?? null;
  const fileLineStarts = loaded?.fileLineStarts ?? [];
  const oldFile = loadOldFile(
    file,
    oldLanguage,
    loaded,
    parses.oldBlob,
    reconstructedOldKey(file, fileIndex, oldLanguage),
    build,
  );
  const newFileLines = displayedFileLines(
    loaded,
    newLanguage,
    file.newPath ?? file.oldPath,
    viewMode,
  );
  const oldDisplayedLines = displayedFileLines(
    oldFile,
    oldLanguage,
    file.oldPath ?? file.newPath,
    viewMode,
  );
  const newSourceLines = loaded?.fileDoc?.lines ??
    loaded?.highlightedLines ??
    null;
  const oldSourceLines = oldFile.highlightedLines ??
    oldFile.fileDoc?.lines ??
    null;
  const mapping = absPath && fileText !== null
    ? {
      absPath,
      language: newLanguage,
      fileText,
      fileLineStarts,
      newToDiff: new Map<number, number>(),
    }
    : undefined;

  // file header lines
  for (let i = file.headerLine; i <= file.endLine; i++) {
    const kind = modelLines[i]?.kind;
    if (kind !== "meta") continue;
    const t = rawLines[i];
    if (t.length === 0) continue;
    lines[i].spans = [{
      col: 0,
      text: t,
      cls: t.startsWith("diff --git ") ? "sectionHeader" : "diffMeta",
    }];
  }

  const definitions = new Map<string, Definition[]>();
  const hunks: DiffHunkInfo[] = [];
  const hunkNodes: StructureNode[] = [];
  for (const hunk of file.hunks) {
    hunkNodes.push(buildHunk(hunk, {
      rawLines,
      modelLines,
      lines,
      diffLineStarts,
      diffColumnOf: build.diffColumnOf,
      fileDoc,
      fileText,
      fileLineStarts,
      oldFileHasUtf8Bom: oldFile.hasUtf8Bom,
      newFileHasUtf8Bom: loaded?.hasUtf8Bom,
      newFileLines,
      oldFileLines: oldDisplayedLines,
      newSourceLines,
      oldSourceLines,
      mapping,
      definitions,
      hunks,
      newLanguage,
      oldLanguage,
      newFileName: file.newPath ?? file.oldPath,
      oldFileName: file.oldPath ?? file.newPath,
      viewMode,
    }));
  }

  const label = file.newPath ?? file.oldPath ?? "(unknown file)";
  return {
    line: file.headerLine,
    offset: diffLineStarts[file.headerLine],
    absPath,
    lines: lines.slice(file.headerLine, file.endLine + 1),
    node: {
      kind: "section",
      label: `▸ ${label}`,
      name: file.newPath,
      startLine: file.headerLine,
      endLine: file.endLine,
      startCol: 0,
      endCol: cpLen(rawLines[file.endLine] ?? ""),
      startOffset: diffLineStarts[file.headerLine],
      endOffset: lineEndOffset(diffLineStarts, build.text, file.endLine),
      depth: 0,
      children: hunkNodes,
    },
    definitions,
    hunks,
    mapping,
    oldFileLines: oldFileLinesOf(
      oldFile,
      file.oldPath ?? file.newPath,
      oldLanguage,
      build.pending,
    ),
    waitingOn: [
      loaded?.pending ? parses.newFile?.key : undefined,
      oldFile.pending ? oldFile.key : undefined,
    ].filter((key) => key !== undefined),
  };
}

/**
 * Returns a function that highlights the complete old file `oldFile` again
 * each time it is called, so that a section keeps only the old file's text and
 * not a highlighting of every old line. The function keeps nothing else alive.
 */
function oldFileLinesOf(
  oldFile: LoadedFile,
  fileName: string | undefined,
  language: Language,
  pending: PendingParses | undefined,
): () => readonly Line[] | null {
  const { key, fileText } = oldFile;
  if (key === undefined || fileText === null) return () => null;
  return () => oldFileHighlight(key, fileText, fileName, language, pending);
}

/**
 * Highlights the complete old file of the file at an index with
 * `oldFileLines`, keeping only the latest highlighting, so that one whose
 * parse is pending is asked for again. An edit works in one file at a time.
 */
function latestOldFileLines(
  oldFileLines: readonly (() => readonly Line[] | null)[],
): (fileIndex: number) => readonly Line[] | null {
  let latest: { fileIndex: number; lines: readonly Line[] } | undefined;
  return (fileIndex) => {
    if (latest?.fileIndex === fileIndex) return latest.lines;
    const lines = oldFileLines[fileIndex]?.() ?? null;
    if (lines !== null) latest = { fileIndex, lines };
    return lines;
  };
}

/** Per-diff-line edit targets: each file's verified new-side lines, keyed by
 * diff line, plus that file's captured content for save-time splicing and the
 * verified hunks that save rewrites. */
function buildEdit(
  sourceText: string,
  rawLines: readonly string[],
  mappings: Map<string, FileMapping>,
  hunks: DiffHunkInfo[],
  oldFileLines: (fileIndex: number) => readonly Line[] | null,
  languages: readonly DiffFileLanguages[],
): DiffEdit {
  const lines = new Map<
    number,
    { absPath: string; newLine: number; markerLen: number }
  >();
  const fileText = new Map<string, string>();
  for (const m of mappings.values()) {
    fileText.set(m.absPath, m.fileText);
    for (const [newLine, diffLine] of m.newToDiff) {
      const markerLen = (rawLines[diffLine] ?? "").length === 0 ? 0 : 1;
      lines.set(diffLine, { absPath: m.absPath, newLine, markerLen });
    }
  }
  return { sourceText, lines, fileText, oldFileLines, languages, hunks };
}

//
// hunk rendering + structure
//

interface MutableLine {
  text: string;
  spans: Span[];
  bg?: "add" | "del";
  renderedSourceHidden?: boolean;
}

interface FragmentLine {
  diffLine: number;
  code: string;

  /** Whether decoding removed a BOM before parsing this source line. */
  omitsUtf8Bom?: boolean;

  /** Context can establish old-side state without replacing new-side colors. */
  render?: boolean;
}

interface HunkCtx {
  rawLines: readonly string[];
  modelLines: DiffModel["lines"];
  lines: MutableLine[];
  diffLineStarts: readonly number[];
  diffColumnOf: ColumnOf;
  fileDoc: Document | null;
  fileText: string | null;
  fileLineStarts: number[];
  oldFileHasUtf8Bom?: boolean;
  newFileHasUtf8Bom?: boolean;
  newFileLines: readonly Line[] | null;
  oldFileLines: readonly Line[] | null;
  newSourceLines: readonly Line[] | null;
  oldSourceLines: readonly Line[] | null;
  mapping: FileMapping | undefined;
  definitions: Map<string, Definition[]>;
  hunks: DiffHunkInfo[];

  /** The new side's language. It colors that side's fragments, and it is the
   * one that projects the hunk's structure. */
  newLanguage: Language;

  /** The old side's language, which colors its own fragments. Differs from
   * `newLanguage` across a rename that changes the extension. */
  oldLanguage: Language;

  /**
   * New-side path, whose extension the parsers use to pick a script variant.
   */
  newFileName: string | undefined;

  /** Old-side path, read the same way. */
  oldFileName: string | undefined;

  viewMode: ViewMode;
}

function buildHunk(hunk: DiffHunk, ctx: HunkCtx): StructureNode {
  const { rawLines, modelLines, lines, diffLineStarts } = ctx;

  // Header line.
  lines[hunk.headerLine].spans = [{
    col: 0,
    text: rawLines[hunk.headerLine],
    cls: "diffHunk",
  }];

  // Verify the hunk as a whole, the way `git apply` validates context: EVERY
  // context/addition line must match the workspace file at its stated new-side
  // line number. New-side no-newline metadata must match the file ending too.
  // A stale diff (the workspace gained or lost lines above the
  // hunk) can coincidentally match a single shifted line — blank lines, lone
  // braces, duplicated boilerplate — and per-line acceptance would then answer
  // type/definition queries about the wrong occurrence. All-or-nothing keeps
  // the maps honest: an unverified hunk renders via fragments and maps to
  // nothing.
  const oldNoTrailingNewline = noTrailingNewline(
    hunk,
    "old",
    rawLines,
    modelLines,
  );
  const newNoTrailingNewline = noTrailingNewline(
    hunk,
    "new",
    rawLines,
    modelLines,
  );

  const diffHasUtf8Bom = hunkSideHasUtf8Bom(
    hunk,
    "new",
    rawLines,
    modelLines,
  );
  let verified = ctx.fileDoc !== null &&
    !(
      ctx.fileText === "" && ctx.newFileHasUtf8Bom &&
      diffHasUtf8Bom !== true
    );
  for (let i = hunk.headerLine + 1; verified && i <= hunk.endLine; i++) {
    const entry = modelLines[i];
    if (entry?.kind !== "ctx" && entry?.kind !== "add") continue;
    const fileText = fileLineText(ctx, entry.newLine!);
    if (
      fileText === null ||
      !diffBodyMatches(
        fileText,
        rawLines,
        hunk,
        i,
        entry.newLine,
        ctx.newFileHasUtf8Bom,
      )
    ) {
      verified = false;
    }
  }
  if (verified && newNoTrailingNewline && ctx.fileText!.endsWith("\n")) {
    verified = false;
  }
  // Record every hunk in document order so save can match the edited diff's
  // hunks to these by position and rewrite only the verified ones.
  ctx.hunks.push({
    absPath: ctx.mapping?.absPath ?? null,
    newStart: hunk.newStart,
    newCount: hunk.newCount,
    verified,
    oldFileHasUtf8Bom: ctx.oldFileHasUtf8Bom,
    newFileHasUtf8Bom: ctx.newFileHasUtf8Bom,
    oldNoTrailingNewline,
    newNoTrailingNewline,
  });

  // Mapping of this hunk's visible new-file lines → diff lines, and lazily-
  // parsed fragments for lines the workspace cannot vouch for.
  const newToDiff = new Map<number, number>();
  const newFragment: FragmentLine[] = [];
  const oldFragment: FragmentLine[] = [];
  const sourceFallbacks = new Map<number, Line>();

  for (let i = hunk.headerLine + 1; i <= hunk.endLine; i++) {
    const entry = modelLines[i];
    const t = rawLines[i];
    if (!entry) continue;
    if (entry.kind === "meta") {
      if (t.length > 0) {
        lines[i].spans = [{ col: 0, text: t, cls: "diffMeta" }];
      }
      continue;
    }
    if (entry.kind !== "ctx" && entry.kind !== "add" && entry.kind !== "del") {
      continue;
    }
    const body = t.slice(1);
    const oldCode = decodedInitialDiffBodyLine(body, entry.oldLine);
    const newCode = decodedInitialDiffBodyLine(body, entry.newLine);
    if (entry.kind === "add") lines[i].bg = "add";
    if (entry.kind === "del") lines[i].bg = "del";

    if (entry.kind === "ctx") {
      oldFragment.push({
        diffLine: i,
        code: oldCode,
        omitsUtf8Bom: oldCode !== body,
        render: false,
      });
    }
    if (entry.kind === "del") {
      const fragment = {
        diffLine: i,
        code: oldCode,
        omitsUtf8Bom: oldCode !== body,
        render: false,
      };
      oldFragment.push(fragment);
      const sourceLine = ctx.oldSourceLines?.[entry.oldLine!];
      if (sourceLine) sourceFallbacks.set(i, sourceLine);
      const oldSpans = ctx.oldFileLines?.[entry.oldLine!]?.spans;
      const displayed = ctx.oldFileLines?.[entry.oldLine!];
      const lineText = displayed && ctx.viewMode === "rendered" &&
          canRenderDiffLines(ctx.oldLanguage)
        ? `${t.slice(0, 1)}${displayed.text}`
        : t;
      if (ctx.viewMode === "rendered" && displayed?.renderedSourceHidden) {
        lines[i].renderedSourceHidden = true;
      }
      const shown = oldSpans
        ? completeFileLine(lines[i], lineText, oldSpans)
        : null;
      if (shown) {
        lines[i] = shown;
      } else {
        fragment.render = true;
      }
      continue;
    }
    const n = entry.newLine!;
    const fileDoc = verified ? ctx.fileDoc : null;
    if (fileDoc) {
      newToDiff.set(n, i);
      const sourceLine = ctx.newSourceLines?.[n];
      if (sourceLine) sourceFallbacks.set(i, sourceLine);
      // The global map feeds semantics. Keep the FIRST verified occurrence:
      // `git log -p` repeats a file across commits (newest first), and the
      // newest occurrence is the one the user is reading.
      if (ctx.mapping && !ctx.mapping.newToDiff.has(n)) {
        ctx.mapping.newToDiff.set(n, i);
      }
    }
    const rendered = ctx.viewMode === "rendered" &&
        canRenderDiffLines(ctx.newLanguage)
      ? ctx.newFileLines?.[n]
      : undefined;
    const lineText = rendered ? `${t.slice(0, 1)}${rendered.text}` : t;
    const shown = fileDoc
      ? completeFileLine(
        lines[i],
        lineText,
        ctx.newFileLines?.[n]?.spans ?? fileDoc.lines[n].spans,
      )
      : null;
    if (shown) {
      if (rendered?.renderedSourceHidden) shown.renderedSourceHidden = true;
      lines[i] = shown;
    } else {
      newFragment.push({
        diffLine: i,
        code: newCode,
        omitsUtf8Bom: newCode !== body,
      });
    }
  }

  const newParsed = applyFragmentSpans(
    newFragment,
    lines,
    rawLines,
    ctx.newLanguage,
    ctx.newFileName,
    ctx.viewMode,
    verified || hunk.newStart <= 1,
  );
  if (newParsed) {
    newFragment.forEach((fragment, index) => {
      const sourceLine = newParsed.lines[index];
      if (sourceLine) sourceFallbacks.set(fragment.diffLine, sourceLine);
    });
  }
  let oldParsed: Document | null = null;
  if (oldFragment.some((fragment) => fragment.render)) {
    oldParsed = applyFragmentSpans(
      oldFragment,
      lines,
      rawLines,
      ctx.oldLanguage,
      ctx.oldFileName,
      ctx.viewMode,
      ctx.oldFileLines !== null || hunk.oldStart <= 1,
    );
  }
  if (oldParsed) {
    oldFragment.forEach((fragment, index) => {
      const sourceLine = oldParsed.lines[index];
      if (sourceLine) sourceFallbacks.set(fragment.diffLine, sourceLine);
    });
  }
  if (ctx.viewMode === "rendered") {
    restoreLossyRenderedChanges(hunk, ctx, sourceFallbacks);
  }

  // structure
  // Verified hunks remap the workspace file's own nodes (precise ranges, live
  // semantics). Unverified hunks — drifted workspace, missing file — still get
  // navigable structure from the fragment parse of their new side: the nodes
  // come from the diff text itself, so navigation always works; only the
  // semantic extras (types, definitions) stay silent there. Either way the
  // new-side language projects its own structure into the hunk's coordinates.
  const children: StructureNode[] = [];
  let source:
    | {
      doc: Document;
      lineToDiff: Map<number, number>;
      lineStarts: readonly number[];
      omitsUtf8Bom: boolean;
    }
    | null = null;
  if (ctx.fileDoc && newToDiff.size > 0) {
    source = {
      doc: ctx.fileDoc,
      lineToDiff: newToDiff,
      lineStarts: ctx.fileLineStarts,
      omitsUtf8Bom: ctx.newFileHasUtf8Bom === true,
    };
  } else if (newParsed && newFragment.length > 0) {
    // Fragment line i is the i-th ctx/add line of the hunk, in order.
    source = {
      doc: newParsed,
      lineToDiff: new Map(newFragment.map((f, i) => [i, f.diffLine])),
      lineStarts: computeLineStarts(newFragment.map((f) => f.code).join("\n")),
      omitsUtf8Bom: newFragment.some((fragment) => fragment.omitsUtf8Bom),
    };
  }
  if (source) {
    const structure = ctx.newLanguage.hunkStructure({
      doc: source.doc,
      lineToDiff: source.lineToDiff,
      sourceOmitsUtf8Bom: source.omitsUtf8Bom,
      sourceLineStarts: source.lineStarts,
      hunkEnd: hunk.endLine,
      diffLineStarts,
      diffColumnOf: ctx.diffColumnOf,
      rawLines,
      definitions: ctx.definitions,
    });
    for (const node of structure) children.push(node);
  }

  // Tell the user when the workspace could not vouch for this hunk (and the
  // semantic features are therefore off): the note rides the label, visible in
  // the status bar and breadcrumbs.
  const note = ctx.fileDoc === null
    ? "  (no workspace file)"
    : verified
    ? ""
    : "  (workspace differs)";
  const label =
    (hunk.context.length > 0
      ? `@@ ${hunk.context}`
      : `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount}`) +
    note;
  return {
    kind: "hunk",
    label,
    startLine: hunk.headerLine,
    endLine: hunk.endLine,
    startCol: 0,
    endCol: cpLen(rawLines[hunk.endLine] ?? ""),
    startOffset: diffLineStarts[hunk.headerLine],
    endOffset: diffLineStarts[hunk.endLine] +
      (rawLines[hunk.endLine] ?? "").length,
    depth: 1,
    children,
  };
}

function fileLineText(ctx: HunkCtx, n: number): string | null {
  if (ctx.fileText === null || n >= ctx.fileLineStarts.length) return null;
  const start = ctx.fileLineStarts[n];
  const end = n + 1 < ctx.fileLineStarts.length
    ? ctx.fileLineStarts[n + 1] - 1
    : ctx.fileText.length;
  return ctx.fileText.slice(start, end);
}

function restoreLossyRenderedChanges(
  hunk: DiffHunk,
  ctx: HunkCtx,
  sourceFallbacks: ReadonlyMap<number, Line>,
): void {
  let deletions: number[] = [];
  let additions: number[] = [];
  const flush = () => {
    if (deletions.length === 0 && additions.length === 0) return;
    restoreLossyChangeGroup(
      deletions,
      additions,
      ctx,
      sourceFallbacks,
    );
    deletions = [];
    additions = [];
  };

  for (let line = hunk.headerLine + 1; line <= hunk.endLine; line++) {
    const kind = ctx.modelLines[line]?.kind;
    if (kind === "del") {
      deletions.push(line);
    } else if (kind === "add") {
      additions.push(line);
    } else if (kind === "meta" && isNoNewlineMarker(ctx.rawLines[line])) {
      continue;
    } else {
      flush();
    }
  }
  flush();
}

function restoreLossyChangeGroup(
  deletions: readonly number[],
  additions: readonly number[],
  ctx: HunkCtx,
  sourceFallbacks: ReadonlyMap<number, Line>,
): void {
  const restore = new Set<number>();
  for (const line of [...deletions, ...additions]) {
    if (
      ctx.lines[line].renderedSourceHidden ||
      (ctx.rawLines[line].slice(1).length > 0 &&
        ctx.lines[line].text.slice(1).length === 0)
    ) {
      restore.add(line);
    }
  }

  for (const deletion of deletions) {
    for (const addition of additions) {
      if (
        ctx.rawLines[deletion].slice(1) !==
          ctx.rawLines[addition].slice(1) &&
        ctx.lines[deletion].text.slice(1) ===
          ctx.lines[addition].text.slice(1)
      ) {
        restore.add(deletion);
        restore.add(addition);
      }
    }
  }

  for (const line of restore) {
    const raw = ctx.rawLines[line];
    const source = sourceFallbacks.get(line);
    ctx.lines[line].text = raw;
    ctx.lines[line].renderedSourceHidden = undefined;
    const shown = source
      ? completeFileLine(ctx.lines[line], raw, source.spans)
      : null;
    if (shown) {
      ctx.lines[line] = shown;
    } else {
      ctx.lines[line].spans = shiftSpans(markerSpan(raw), [{
        col: 0,
        text: raw.slice(1),
        cls: "plain",
      }]);
    }
  }
}

function markerSpan(lineText: string): Span {
  const marker = lineText.slice(0, 1);
  return {
    col: 0,
    text: marker,
    cls: marker === "+" ? "diffAdd" : marker === "-" ? "diffDel" : "whitespace",
  };
}

/** Marker span + the code spans shifted one column right past the marker. */
function shiftSpans(marker: Span, spans: readonly Span[]): Span[] {
  const out: Span[] = [marker];
  for (const s of spans) out.push({ ...s, col: s.col + 1 });
  return out;
}

/**
 * Like `line`, except that it shows the diff line `lineText` colored by
 * `spans` of the complete file, or null when `spans` do not describe that
 * line. Its spans are `spans` shifted one column right past the marker, with
 * a carriage return the diff's CRLF transport added kept as whitespace. They
 * are made when first read, so that a build makes only the spans something
 * reads.
 */
function completeFileLine(
  line: MutableLine,
  lineText: string,
  spans: readonly Span[],
): MutableLine | null {
  // The spans describe the line when their texts, in order, make up the line
  // after its marker, after a byte order mark the decoding removed, and before
  // a carriage return the diff's CRLF transport added.
  const restoresUtf8Bom = lineText.startsWith("\uFEFF", 1) &&
    spansEnd(lineText, spans, 2) !== null;
  const end = spansEnd(lineText, spans, restoresUtf8Bom ? 2 : 1);
  if (end === null) return null;
  let source: readonly Span[] | null = spans;
  let shifted: Span[] | null = null;
  return {
    ...line,
    text: lineText,
    get spans(): Span[] {
      if (shifted === null) {
        shifted = shiftFragmentSpans(lineText, source ?? [], restoresUtf8Bom);
        if (end < lineText.length) {
          shifted.push({
            col: cpLen(lineText.slice(1, end)) + 1,
            text: lineText.slice(end),
            cls: "whitespace",
          });
        }
        source = null;
      }
      return shifted;
    },
    set spans(value: Span[]) {
      shifted = value;
      source = null;
    },
  };
}

/**
 * Helper for {@link completeFileLine}, which returns where the texts of
 * `spans` end when, in order, they appear in `lineText` from offset `start`
 * and leave nothing after them but a carriage return, or null otherwise.
 */
function spansEnd(
  lineText: string,
  spans: readonly Span[],
  start: number,
): number | null {
  let at = start;
  for (const span of spans) {
    if (!lineText.startsWith(span.text, at)) return null;
    at += span.text.length;
  }
  return at === lineText.length ||
      (at === lineText.length - 1 && lineText.endsWith("\r"))
    ? at
    : null;
}

/**
 * Syntax-highlight diff lines the workspace cannot vouch for by parsing their
 * joined content as one fragment — good token-level classification for the old
 * side and for drifted/new files, without any file on disk. Returns the parsed
 * fragment so its structure tree can be remapped too.
 */
function applyFragmentSpans(
  fragment: FragmentLine[],
  lines: MutableLine[],
  rawLines: readonly string[],
  language: Language,
  fileName: string | undefined,
  viewMode: ViewMode,
  completeFileContext: boolean,
): Document | null {
  if (fragment.length === 0) return null;
  const text = fragment.map((f) => f.code).join("\n");
  const parsed = language.parseDocument(text, fileName);
  const sourceLines = language.renderLineTopology === "independent"
    ? language.highlightLines(text, fileName)
    : parsed.lines;
  const rendered = viewMode === "rendered" &&
    canRenderDiffLines(language) &&
    (!language.renderNeedsCompleteFile || completeFileContext);
  const displayed = rendered
    ? renderedLinesFor(language, text, fileName) ?? sourceLines
    : sourceLines;
  for (let i = 0; i < fragment.length; i++) {
    if (fragment[i].render === false) continue;
    const { diffLine } = fragment[i];
    const decodedBom = fragment[i].omitsUtf8Bom === true ? "\uFEFF" : "";
    const lineText = rendered
      ? `${rawLines[diffLine].slice(0, 1)}${decodedBom}${
        displayed[i]?.text ?? ""
      }`
      : rawLines[diffLine];
    lines[diffLine].text = lineText;
    if (rendered && displayed[i]?.renderedSourceHidden) {
      lines[diffLine].renderedSourceHidden = true;
    }
    lines[diffLine].spans = shiftFragmentSpans(
      lineText,
      displayed[i]?.spans ?? [],
      fragment[i].omitsUtf8Bom === true,
    );
  }
  return parsed;
}

function shiftFragmentSpans(
  lineText: string,
  spans: readonly Span[],
  omitsUtf8Bom: boolean,
): Span[] {
  if (!omitsUtf8Bom) return shiftSpans(markerSpan(lineText), spans);
  return shiftSpans(markerSpan(lineText), [
    { col: 0, text: "\uFEFF", cls: "whitespace" },
    ...spans.map((span) => ({ ...span, col: span.col + 1 })),
  ]);
}

//
// offset maps for semantics
//

function buildMaps(
  diffLineStarts: readonly number[],
  rawLines: readonly string[],
  mappings: Map<string, FileMapping>,
): DiffMaps {
  // diff line → its file mapping + new-file line, for verified lines.
  const byDiffLine = new Map<number, { m: FileMapping; newLine: number }>();
  for (const m of mappings.values()) {
    for (const [newLine, diffLine] of m.newToDiff) {
      byDiffLine.set(diffLine, { m, newLine });
    }
  }
  return {
    rootFiles: new Map(
      [...mappings.values()].map((m) => [m.absPath, m.language]),
    ),
    toFile(diffOffset) {
      const d = lineIndexOf(diffLineStarts, diffOffset);
      const hit = byDiffLine.get(d);
      if (!hit) return null;
      const col = diffOffset - diffLineStarts[d];
      if (col < 1) return null; // the marker column belongs to the diff
      const bomWidth = hit.newLine === 0 && rawLines[d]?.[1] === "\uFEFF"
        ? 1
        : 0;
      return {
        path: hit.m.absPath,
        offset: hit.m.fileLineStarts[hit.newLine] +
          Math.max(0, col - 1 - bomWidth),
      };
    },
    fromFile(path, fileOffset) {
      const m = mappings.get(path);
      if (!m) return null;
      const n = lineIndexOf(m.fileLineStarts, fileOffset);
      const diffLine = m.newToDiff.get(n);
      if (diffLine === undefined) return null;
      const col = fileOffset - m.fileLineStarts[n];
      // A trimmed empty context line has no marker character at all.
      const marker = (rawLines[diffLine] ?? "").length === 0 ? 0 : 1;
      const bomWidth = n === 0 && rawLines[diffLine]?.[marker] === "\uFEFF"
        ? 1
        : 0;
      return diffLineStarts[diffLine] + marker + bomWidth + col;
    },
  };
}

//
// small helpers
//

function lineEndOffset(
  lineStarts: readonly number[],
  text: string,
  line: number,
): number {
  if (line + 1 < lineStarts.length) return lineStarts[line + 1] - 1;
  return text.length;
}

export const _internal = {
  completeFileLine,
  parseGitBatchOutput,
  readGitBlobs,
  reconstructOldFile,
  restoreLossyChangeGroup,
  sharedParse,
};
