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
 * fragment.
 *
 * The structure tree is: file (a `section` node) → hunk → the workspace file's
 * own structure nodes, clamped and remapped into diff coordinates. So WASD and
 * the info card navigate the same patterns/builders/schemas the source view
 * would show, scoped to what the diff touches.
 */

import { dirname, isAbsolute, join, relative } from "@std/path";

import { spawnSync } from "@node/child_process";

import { cpLen } from "./ansi.ts";
import { type DiffFile, type DiffHunk, type DiffModel } from "./diff.ts";
import type { Language } from "./languages/language.ts";
import {
  canRenderDiffLines,
  decodeLanguageInput,
  languageForFile,
  readOnlyReasonFor,
  renderedLinesFor,
} from "./languages/language.ts";
import { computeLineStarts, lineIndexOf } from "./lines.ts";
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
  return {
    resolve(path) {
      if (isAbsolute(path)) return null; // diff paths are repo-relative
      for (const base of bases) {
        const abs = join(base, path);
        if (!bounded(abs)) continue; // `..` escapes and symlinks out: blocked
        // bounded() canonicalized abs via realPathSync, so statSync resolves;
        // only the file-vs-directory check remains. read() guards the contents.
        if (Deno.statSync(abs).isFile) return abs;
      }
      return null;
    },
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
  };
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
    let batch: string[] = [];
    let inputBytes = 0;
    for (const object of objects) {
      const objectBytes = object.length + 1;
      if (
        batch.length > 0 &&
        inputBytes + objectBytes > MAX_GIT_BATCH_REQUEST_BYTES
      ) {
        if (!readGitBlobBatch(repoRoot, batch, blobs, run, loadedBomStates)) {
          return new Map<string, string>();
        }
        batch = [];
        inputBytes = 0;
      }
      batch.push(object);
      inputBytes += objectBytes;
    }
    if (!readGitBlobBatch(repoRoot, batch, blobs, run, loadedBomStates)) {
      return new Map<string, string>();
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

  /** Complete highlighted old files, aligned with the parsed diff's files.
   * The live highlighter uses these spans when an edit creates a removed line. */
  readonly oldFileLines: readonly (readonly Line[] | null)[];

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
  /** Absolute paths of the diff's files that exist in the workspace. */
  readonly rootFiles: readonly string[];

  /** Diff offset → (file, file offset), when the offset sits on code that is
   * present (and unchanged) in the current workspace file. */
  toFile(diffOffset: number): { path: string; offset: number } | null;

  /** File offset → diff offset, when that file line is visible in the diff. */
  fromFile(path: string, fileOffset: number): number | null;
}

interface FileMapping {
  readonly absPath: string;
  readonly fileText: string;
  readonly fileLineStarts: number[];

  /** new-file line → diff line, for content-verified ctx/add lines. */
  readonly newToDiff: Map<number, number>;
}

/**
 * Per-session cache of complete new and old files. New files use their absolute
 * paths as keys. Old Git files use their path and object name. Reconstructed
 * old files use their stable file-section position and paths. File headers are
 * not editable, so repeated versions remain distinct while a deferred re-parse
 * can reuse both highlighted files.
 */
export type WorkspaceCache = Map<string, LoadedFile>;

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
}

function loadFile(
  absPath: string,
  language: Language,
  ws: DiffWorkspace,
  cache?: WorkspaceCache,
): LoadedFile {
  const hit = cache?.get(absPath);
  if (hit) return hit;
  const fileText = ws.read(absPath);
  const fileDoc = fileText !== null
    ? language.parseDocument(fileText, absPath)
    : null;
  const fileLineStarts = fileText !== null ? computeLineStarts(fileText) : [];
  const entry: LoadedFile = {
    fileText,
    fileDoc,
    fileLineStarts,
    hasUtf8Bom: fileText === null ? undefined : ws.hasUtf8Bom?.(absPath),
  };
  cache?.set(absPath, entry);
  return entry;
}

function isNoNewlineMarker(line: string | undefined): boolean {
  return line?.replace(/\r$/, "") === "\\ No newline at end of file";
}

/** A hunk body line without its diff marker. */
function diffBodyText(
  rawLines: string[],
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
  rawLines: string[],
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
  rawLines: string[],
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
  rawLines: string[],
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
  rawLines: string[],
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
  rawLines: string[],
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
  rawLines: string[],
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
  rawLines: string[],
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
    lines.splice(start, newSide.length, ...oldSide);
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

function reconstructedOldFileCacheKey(
  file: DiffFile,
  fileIndex: number,
): string {
  return `\0diff-old:${
    JSON.stringify([
      fileIndex,
      file.oldPath,
      file.newPath,
      file.oldObject,
    ])
  }`;
}

function highlightedFile(
  fileText: string | null,
  fileName: string | undefined,
  language: Language,
  hasUtf8Bom?: boolean,
): LoadedFile {
  return {
    fileText,
    fileDoc: null,
    fileLineStarts: [],
    hasUtf8Bom,
    highlightedLines: fileText === null
      ? null
      : language.highlightLines(fileText, fileName),
  };
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

/** Load and highlight the complete old side represented by one diff file. */
function loadOldFile(
  file: DiffFile,
  fileIndex: number,
  language: Language,
  newFile: LoadedFile | null,
  oldBlobs: ReadonlyMap<string, string> | undefined,
  ws: DiffWorkspace,
  rawLines: string[],
  modelLines: DiffModel["lines"],
  cache?: WorkspaceCache,
): LoadedFile {
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
  if (
    file.oldObject && validGitObject(file.oldObject) &&
    (oldBlobs !== undefined || ws.readBlob)
  ) {
    const blobKey = `\0diff-old-blob:${
      JSON.stringify([fileName, file.oldObject])
    }`;
    let blob = cache?.get(blobKey);
    if (!blob) {
      const blobText = oldBlobs
        ? oldBlobs.get(file.oldObject) ?? null
        : ws.readBlob!(file.oldObject);
      blob = highlightedFile(
        blobText,
        fileName,
        language,
        blobText === null
          ? undefined
          : ws.blobHasUtf8Bom?.(file.oldObject) ?? inferredOldHasUtf8Bom,
      );
      cache?.set(blobKey, blob);
    }
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

  const key = reconstructedOldFileCacheKey(file, fileIndex);
  const hit = cache?.get(key);
  if (hit) return hit;
  const newText = newFile?.fileText ?? null;
  const fileText = newText === null ? null : reconstructOldFile(
    file,
    newText,
    rawLines,
    modelLines,
    newFile?.hasUtf8Bom,
  );
  const entry = highlightedFile(
    fileText,
    fileName,
    language,
    inferredOldHasUtf8Bom,
  );
  cache?.set(key, entry);
  return entry;
}

export function buildDiffDocument(
  text: string,
  model: DiffModel,
  ws: DiffWorkspace,
  cache?: WorkspaceCache,
  viewMode: ViewMode = "source",
): { doc: Document; maps: DiffMaps; edit: DiffEdit } {
  const rawLines = text.split("\n");
  const diffLineStarts = computeLineStarts(text);
  const lines: MutableLine[] = rawLines.map((t) => ({ text: t, spans: [] }));
  const structure: StructureNode[] = [];
  const definitions = new Map<string, Definition[]>();
  const mappings = new Map<string, FileMapping>(); // by abs path
  const hunks: DiffHunkInfo[] = [];
  const oldFileLines: (readonly Line[] | null)[] = [];
  const oldBlobs = ws.readBlobs?.(
    model.files.flatMap((file) =>
      file.hunks.length > 0 && file.oldObject &&
        validGitObject(file.oldObject) &&
        readOnlyReasonFor(languageForFile(file.oldPath ?? file.newPath)) ===
          undefined
        ? [file.oldObject]
        : []
    ),
  );

  // Lines not claimed by any file/hunk below default to plain text.
  for (let i = 0; i < rawLines.length; i++) {
    const kind = model.lines[i]?.kind ?? "other";
    if (kind === "other" && rawLines[i].length > 0) {
      lines[i].spans = [{ col: 0, text: rawLines[i], cls: "plain" }];
    }
  }

  for (const [fileIndex, file] of model.files.entries()) {
    // The language is chosen once per file, from its path, and every operation
    // on the file — parsing the workspace copy, coloring fragments, projecting
    // structure — dispatches through it. A rename can change the extension, so
    // the old and new sides resolve separately.
    const newLanguage = languageForFile(file.newPath ?? file.oldPath);
    const oldLanguage = languageForFile(file.oldPath ?? file.newPath);
    const absPath = file.newPath ? ws.resolve(file.newPath) : null;
    const loaded = absPath && readOnlyReasonFor(newLanguage) === undefined
      ? loadFile(absPath, newLanguage, ws, cache)
      : null;
    const fileText = loaded?.fileText ?? null;
    const fileDoc = loaded?.fileDoc ?? null;
    const fileLineStarts = loaded?.fileLineStarts ?? [];
    const oldFile = loadOldFile(
      file,
      fileIndex,
      oldLanguage,
      loaded,
      oldBlobs,
      ws,
      rawLines,
      model.lines,
      cache,
    );
    oldFileLines.push(oldFile.highlightedLines ?? null);
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

    let mapping: FileMapping | undefined;
    if (absPath && fileText !== null) {
      mapping = mappings.get(absPath) ?? {
        absPath,
        fileText,
        fileLineStarts,
        newToDiff: new Map(),
      };
      mappings.set(absPath, mapping);
    }

    // file header lines
    for (let i = file.headerLine; i <= file.endLine; i++) {
      const kind = model.lines[i]?.kind;
      if (kind !== "meta") continue;
      const t = rawLines[i];
      if (t.length === 0) continue;
      lines[i].spans = [{
        col: 0,
        text: t,
        cls: t.startsWith("diff --git ") ? "sectionHeader" : "diffMeta",
      }];
    }

    const hunkNodes: StructureNode[] = [];
    for (const hunk of file.hunks) {
      hunkNodes.push(buildHunk(hunk, {
        rawLines,
        modelLines: model.lines,
        lines,
        diffLineStarts,
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

    // the file's section node
    const label = file.newPath ?? file.oldPath ?? "(unknown file)";
    const start = diffLineStarts[file.headerLine];
    const end = lineEndOffset(diffLineStarts, text, file.endLine);
    structure.push({
      kind: "section",
      label: `▸ ${label}`,
      name: file.newPath,
      startLine: file.headerLine,
      endLine: file.endLine,
      startCol: 0,
      endCol: cpLen(rawLines[file.endLine] ?? ""),
      startOffset: start,
      endOffset: end,
      depth: 0,
      children: hunkNodes,
    });
  }

  const flatStructure = flattenStructure(structure);

  const doc: Document = {
    text,
    lines: lines as Line[],
    structure,
    flatStructure,
    definitions,
  };
  return {
    doc,
    maps: buildMaps(diffLineStarts, rawLines, mappings),
    edit: buildEdit(text, rawLines, mappings, hunks, oldFileLines),
  };
}

/** Per-diff-line edit targets: each file's verified new-side lines, keyed by
 * diff line, plus that file's captured content for save-time splicing and the
 * verified hunks that save rewrites. */
function buildEdit(
  sourceText: string,
  rawLines: string[],
  mappings: Map<string, FileMapping>,
  hunks: DiffHunkInfo[],
  oldFileLines: readonly (readonly Line[] | null)[],
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
  return { sourceText, lines, fileText, oldFileLines, hunks };
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
  rawLines: string[];
  modelLines: DiffModel["lines"];
  lines: MutableLine[];
  diffLineStarts: number[];
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
      const shifted = oldSpans
        ? shiftCompleteLineSpans(lineText, oldSpans)
        : null;
      if (shifted) {
        lines[i].text = lineText;
        lines[i].spans = shifted;
      } else {
        fragment.render = true;
      }
      continue;
    }
    const n = entry.newLine!;
    if (verified && ctx.fileDoc) {
      newToDiff.set(n, i);
      const sourceLine = ctx.newSourceLines?.[n];
      if (sourceLine) sourceFallbacks.set(i, sourceLine);
      // The global map feeds semantics. Keep the FIRST verified occurrence:
      // `git log -p` repeats a file across commits (newest first), and the
      // newest occurrence is the one the user is reading.
      if (ctx.mapping && !ctx.mapping.newToDiff.has(n)) {
        ctx.mapping.newToDiff.set(n, i);
      }
      const shifted = shiftCompleteLineSpans(
        ctx.viewMode === "rendered" && canRenderDiffLines(ctx.newLanguage) &&
          ctx.newFileLines?.[n]
          ? `${t.slice(0, 1)}${ctx.newFileLines[n].text}`
          : t,
        ctx.newFileLines?.[n]?.spans ?? ctx.fileDoc.lines[n].spans,
      );
      if (shifted) {
        if (
          ctx.viewMode === "rendered" &&
          canRenderDiffLines(ctx.newLanguage) &&
          ctx.newFileLines?.[n]
        ) {
          lines[i].text = `${t.slice(0, 1)}${ctx.newFileLines[n].text}`;
          if (ctx.newFileLines[n].renderedSourceHidden) {
            lines[i].renderedSourceHidden = true;
          }
        }
        lines[i].spans = shifted;
      } else {
        newFragment.push({
          diffLine: i,
          code: newCode,
          omitsUtf8Bom: newCode !== body,
        });
      }
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
      lineStarts: number[];
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
    children.push(...ctx.newLanguage.hunkStructure({
      doc: source.doc,
      lineToDiff: source.lineToDiff,
      sourceOmitsUtf8Bom: source.omitsUtf8Bom,
      sourceLineStarts: source.lineStarts,
      hunkEnd: hunk.endLine,
      diffLineStarts,
      rawLines,
      definitions: ctx.definitions,
    }));
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
    ctx.lines[line].spans =
      (source ? shiftCompleteLineSpans(raw, source.spans) : null) ??
        shiftSpans(markerSpan(raw), [{
          col: 0,
          text: raw.slice(1),
          cls: "plain",
        }]);
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
 * Shift complete-file spans and retain a carriage return added by the diff's
 * CRLF transport. Null means the source spans do not describe this line.
 */
function shiftCompleteLineSpans(
  lineText: string,
  spans: readonly Span[],
): Span[] | null {
  const code = lineText.slice(1);
  const sourceText = spans.map((span) => span.text).join("");
  const restoresUtf8Bom = code.startsWith("\uFEFF") &&
    (code.slice(1) === sourceText || code.slice(1) === `${sourceText}\r`);
  const completeSourceText = restoresUtf8Bom
    ? `\uFEFF${sourceText}`
    : sourceText;
  if (code !== completeSourceText && code !== `${completeSourceText}\r`) {
    return null;
  }
  const shifted = shiftFragmentSpans(lineText, spans, restoresUtf8Bom);
  if (code.length > completeSourceText.length) {
    shifted.push({
      col: cpLen(completeSourceText) + 1,
      text: code.slice(completeSourceText.length),
      cls: "whitespace",
    });
  }
  return shifted;
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
  rawLines: string[],
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
  diffLineStarts: number[],
  rawLines: string[],
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
    rootFiles: [...mappings.keys()],
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
  lineStarts: number[],
  text: string,
  line: number,
): number {
  if (line + 1 < lineStarts.length) return lineStarts[line + 1] - 1;
  return text.length;
}

export const _internal = {
  parseGitBatchOutput,
  readGitBlobs,
  reconstructOldFile,
  restoreLossyChangeGroup,
  shiftCompleteLineSpans,
};
