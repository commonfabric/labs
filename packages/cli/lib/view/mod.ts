/**
 * Entry point for `cf view`. Reads input bytes, selects a language and decodes
 * through it, then parses once — as a unified diff when it reads as one,
 * otherwise with the selected language. It then launches the interactive
 * pager (when stdout is a TTY) or prints the selected source or rendered
 * representation and exits, mirroring how `less`/`bat` behave when their
 * output is redirected.
 * Filename-free compiler output keeps the transformed TypeScript default.
 * Other source uses filename and shebang metadata unless an explicit language
 * selects another language.
 */

import { renderLineColored } from "./highlight.ts";
import { runPager } from "./pager.ts";
import type { Document, Line } from "./model.ts";
import { ViewError } from "./errors.ts";
import { detectDiff, type DiffModel, parseDiff } from "./diff.ts";
import {
  buildDiffDocument,
  realWorkspace,
  type WorkspaceCache,
} from "./diffdoc.ts";
import {
  byteInputFor,
  canRenderDiffLines,
  decodeLanguageInput,
  diffSemanticsFor,
  distinctLanguages,
  type Language,
  languageForFile,
  languageForName,
  languageForTransformedOutput,
  languageNames,
  prepareLanguages,
  type Semantics,
} from "./languages/language.ts";
import type { DecodedLanguageSource } from "./languages/decoder.ts";
import {
  type EditableSource,
  fileSource,
  readonlySource,
} from "./editsource.ts";
import { diffSource } from "./diffedit.ts";
import { findCommitHeaders, realGit } from "./commitmsg.ts";
import { type BufferedViewInput, loadViewInput } from "./loadinput.ts";

export { ViewError };

export type ColorWhen = "always" | "auto" | "never";

export interface ViewOptions {
  color: ColorWhen;
  plain: boolean;
  lineNumbers: boolean;

  /** Start in the rendered representation when one is available. */
  rendered?: boolean;

  file?: string;

  /** Select piped source with this stable language identifier. */
  language?: string;

  /** Select piped source as though it had this filename. */
  filename?: string;

  /** Force (true) or suppress (false) diff mode; undefined auto-detects. */
  diff?: boolean;
}

export async function viewMain(options: ViewOptions): Promise<void> {
  const selection = pipedSelection(options);
  const stdoutTty = Deno.stdout.isTerminal();
  const interactive = !options.plain && stdoutTty;
  const color = options.color === "always"
    ? true
    : options.color === "never"
    ? false
    : stdoutTty;
  const input = await loadViewInput(
    options.file,
    selection.fileName ?? options.file,
    selection.language,
    interactive,
    options.diff !== true,
  );
  if (input.kind === "rendered-stream") {
    try {
      await printLines(
        byteInputFor(input.language)!.renderByteStream(input.chunks),
        input.lineCount,
        color,
        options.lineNumbers,
      );
    } finally {
      await input.dispose();
    }
    return;
  }
  const { doc, semantics, editSource } = await buildPreparedView(
    input,
    options.file,
    options.diff,
    selection,
  );
  if (!editSource.allowsEmptyInput && doc.text.trim().length === 0) {
    throw new ViewError(
      options.file
        ? `cf view: "${options.file}" is empty.`
        : "cf view: no input. Pipe transformed TypeScript in, e.g.\n" +
          "  cf check ./pattern.tsx --show-transformed --no-run | cf view\n" +
          "a diff: git diff origin/main | cf view\n" +
          "or pass a file: cf view transformed.ts",
    );
  }
  if (interactive) {
    await runPager(
      doc,
      {
        color: true,
        showLineNumbers: options.lineNumbers,
        viewMode: options.rendered ? "rendered" : undefined,
      },
      semantics(),
      editSource,
    );
    return;
  }

  const rendered = options.rendered ||
    editSource.defaultViewMode === "rendered";
  const shown = rendered ? editSource.render?.(doc) ?? doc : doc;
  if (shown === doc && !color && !options.lineNumbers) {
    writeAllSync(Deno.stdout, input.bytes);
    return;
  }
  if (shown === doc && hasUtf8Bom(input.bytes)) {
    writeAllSync(Deno.stdout, input.bytes.subarray(0, 3));
  }
  await printDocument(shown, color, options.lineNumbers);
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb &&
    bytes[2] === 0xbf;
}

function pipedSelection(options: ViewOptions): SourceSelection {
  validateSourceSelection(
    options.file,
    options.diff,
    options.language !== undefined || options.filename !== undefined,
  );
  if (options.language === undefined) {
    return { fileName: options.filename };
  }
  const language = languageForName(options.language);
  if (!language) {
    throw new ViewError(
      `cf view: unknown language "${options.language}". Available languages: ${
        languageNames().join(", ")
      }`,
    );
  }
  return { language, fileName: options.filename };
}

/** Explicit syntax selection for source received through a pipe. */
export interface SourceSelection {
  readonly language?: Language;
  readonly fileName?: string;
}

/** Retained bytes with selection and extent established by the input stream. */
export type ViewByteInput = BufferedViewInput;

function validateSourceSelection(
  file: string | undefined,
  forceDiff: boolean | undefined,
  sourceSelected: boolean,
): void {
  if (!sourceSelected) return;
  if (file !== undefined) {
    throw new ViewError(
      "cf view: --language and --filename cannot be used with a file argument",
    );
  }
  if (forceDiff === true) {
    throw new ViewError(
      "cf view: --diff cannot be combined with --language or --filename",
    );
  }
}

/**
 * Parse the input into a Document and pick the matching semantic service:
 * diff input gets a program over the current workspace files it names; a
 * transformed blob gets the section-based program. Semantics are constructed
 * lazily — only the interactive path needs them.
 *
 * `forceDiff` pins the mode (`--diff` / `--no-diff`). Automatic detection
 * accepts raw unified diffs only when the first non-empty line starts a
 * structurally parseable diff container. Standard Git commit output has its own
 * complete-header check. Exported for tests.
 *
 * `selection` chooses syntax for piped source. Its virtual filename is
 * advisory and does not make the source editable.
 *
 * The languages this reaches must already have their parsers, which
 * {@link buildPreparedView} is the entry point that arranges.
 */
export function buildView(
  input: string | Uint8Array | ViewByteInput,
  file?: string,
  forceDiff?: boolean,
  selection: SourceSelection = {},
): {
  doc: Document;
  semantics: () => Semantics | undefined;
  editSource: EditableSource;
} {
  return builtView(selectView(input, file, forceDiff, selection));
}

/** Build a view after loading the parsers its languages need. */
export async function buildPreparedView(
  input: string | Uint8Array | ViewByteInput,
  file?: string,
  forceDiff?: boolean,
  selection: SourceSelection = {},
): Promise<{
  doc: Document;
  semantics: () => Semantics | undefined;
  editSource: EditableSource;
}> {
  const selected = selectView(input, file, forceDiff, selection);
  await prepareLanguages(selected.languages);
  return builtView(selected);
}

/**
 * What selection settles before anything is parsed: how the bytes decode,
 * whether they read as a diff, and the languages the view will parse through.
 */
interface SelectedInput {
  readonly loaded: ViewByteInput;
  readonly decoded: DecodedLanguageSource;
  readonly text: string;
  readonly file: string | undefined;
  readonly fileName: string | undefined;

  /** Every language this view can parse through, which is what has to have
   * its parser before anything is parsed. A diff's two sides are resolved
   * separately, so a rename across languages brings both. */
  readonly languages: readonly Language[];
}

type ViewSelection =
  & SelectedInput
  & ({ readonly model: DiffModel } | {
    readonly model: null;

    /** The language ordinary source parses through. */
    readonly language: Language;
  });

function selectView(
  input: string | Uint8Array | ViewByteInput,
  file: string | undefined,
  forceDiff: boolean | undefined,
  selection: SourceSelection,
): ViewSelection {
  let loaded: ViewByteInput;
  if (typeof input === "string") {
    const bytes = new TextEncoder().encode(input);
    loaded = {
      kind: "bytes",
      bytes,
      extent: { byteLength: bytes.length, complete: true },
    };
  } else if (input instanceof Uint8Array) {
    loaded = {
      kind: "bytes",
      bytes: input,
      extent: { byteLength: input.length, complete: true },
    };
  } else {
    loaded = input;
  }
  const bytes = loaded.bytes;
  const sourceSelected = selection.language !== undefined ||
    selection.fileName !== undefined;
  validateSourceSelection(file, forceDiff, sourceSelected);
  const fileName = selection.fileName ?? file;
  const selectedDecoder = selection.language ?? loaded.language;
  const decoded = selectedDecoder === undefined
    ? decodeLanguageInput(fileName, bytes, {
      byteLanguageDetectionComplete:
        loaded.byteLanguageDetectionComplete === true,
    })
    : {
      language: selectedDecoder,
      source: decodeInput(selectedDecoder, bytes, fileName),
    };
  const selectedLanguage = decoded.language;
  const text = decoded.source.text;
  const detectContent = forceDiff !== false && !sourceSelected &&
    selectedLanguage.input.kind === "text";
  const commitOutput = detectContent && looksLikeCommitOutput(text);
  const parsedDiff = forceDiff === true || commitOutput
    ? parseDiff(text)
    : detectContent
    ? detectDiff(text)
    : null;
  const model: DiffModel | null = parsedDiff ??
    (forceDiff === true || commitOutput
      ? {
        files: [],
        lines: text.split("\n").map(() => ({ kind: "other" as const })),
      }
      : null);
  const common = { loaded, decoded: decoded.source, text, file, fileName };
  if (model) {
    return {
      ...common,
      model,
      languages: distinctLanguages(
        model.files.flatMap((diffFile) => [diffFile.newPath, diffFile.oldPath]),
      ),
    };
  }
  const transformedOutput = selectedLanguage.input.kind === "text" &&
    fileName === undefined &&
    looksLikeTransformedOutput(text);
  const language = selection.language ??
    (transformedOutput ? languageForTransformedOutput() : selectedLanguage);
  return { ...common, model, language, languages: [language] };
}

function builtView(selected: ViewSelection): {
  doc: Document;
  semantics: () => Semantics | undefined;
  editSource: EditableSource;
} {
  const { text, file, fileName, loaded } = selected;
  if (selected.model !== null) {
    const model = selected.model;
    const ws = realWorkspace(safeCwd());
    // One workspace cache shared by the initial build and every deferred
    // re-parse, so the named files are read and parsed once per session.
    const cache: WorkspaceCache = new Map();
    const { doc, maps, edit } = buildDiffDocument(text, model, ws, cache);
    const hasRenderedView = model.files.some((diffFile) =>
      [diffFile.oldPath, diffFile.newPath].some((path) =>
        path !== undefined && canRenderDiffLines(languageForFile(path))
      )
    );
    return {
      doc,
      // The diff's semantic layer comes from the languages of the files it
      // leaves behind, which is the side a query resolves against.
      semantics: () =>
        diffSemanticsFor(
          distinctLanguages(
            model.files.map((diffFile) => diffFile.newPath ?? diffFile.oldPath),
          ),
          text,
          maps,
          { cwd: safeCwd() },
        ),
      // A diff edits the new side of the files it touches, in place. Saving
      // edited `git show` output amends HEAD with those file and message edits.
      editSource: diffSource(
        ws,
        edit,
        cache,
        realGit(safeCwd()),
        hasRenderedView,
      ),
    };
  }
  const language = selected.language;
  const doc = language.parseDocument(text, fileName);
  return {
    doc,
    semantics: () =>
      language.createSemantics?.(text, { cwd: safeCwd(), fileName }),
    // A real file gets a file-backed source. Its language may keep it read-only.
    // A pipe (transformed output, etc.) has no file to edit.
    editSource: file
      ? fileSource(file, language, {
        encode: selected.decoded.encode,
        renderExtent: loaded.extent,
      })
      : readonlySource(
        "This view is of a pipe — there is no underlying file to edit.",
        language,
        fileName,
        loaded.extent,
      ),
  };
}

function decodeInput(
  language: Language,
  bytes: Uint8Array,
  fileName: string | undefined,
): DecodedLanguageSource {
  try {
    return language.input.decoder.decode(bytes);
  } catch {
    const source = fileName === undefined ? "piped input" : `"${fileName}"`;
    throw new ViewError(
      `cf view: ${source} cannot be decoded as ${language.input.decoder.id} ` +
        `for language "${language.id}".`,
    );
  }
}

/** `cf check --show-transformed` starts each output module with this header. */
function looksLikeTransformedOutput(text: string): boolean {
  const lineEnd = text.indexOf("\n");
  const firstLine = (lineEnd < 0 ? text : text.slice(0, lineEnd)).replace(
    /\r$/,
    "",
  );
  const prefix = "// transformed: ";
  return firstLine.startsWith(prefix) &&
    firstLine.slice(prefix.length).trim().length > 0;
}

/** A standard `git show` or `git log` header. Unlike a diff heuristic, this also
 * recognizes commits with no message or textual file hunks. */
function looksLikeCommitOutput(text: string): boolean {
  const lines = text.split("\n").map((line) =>
    line.endsWith("\r") ? line.slice(0, -1) : line
  );
  const first = lines.findIndex((line) => line.trim().length > 0);
  if (first < 0) return false;
  const commits = findCommitHeaders(lines);
  const commit = commits.find((candidate) => candidate.line === first);
  if (!commit) return false;
  if (lines[first].startsWith(`From ${commit.sha} `)) {
    const separator = lines.indexOf("", first + 1);
    if (separator < 0) return false;
    const headers = lines.slice(first + 1, separator);
    return headers.some((line) => /^From: .+<[^<>]*>$/.test(line)) &&
      headers.some((line) => /^Date: .+/.test(line)) &&
      headers.some((line) => /^Subject: .+/.test(line));
  }
  if (!lines[first].startsWith(`commit ${commit.sha}`)) {
    return lines.slice(first + 1).some((line) =>
      line.startsWith("diff --git ")
    );
  }
  const separator = lines.indexOf("", first + 1);
  if (separator < 0) return false;
  const headers = lines.slice(first + 1, separator);
  return headers.some((line) =>
    /^Author:\s+.*<[^<>]*>$/.test(line) ||
    /^author .*<[^<>]*> -?\d+ [+-]\d{4}$/.test(line)
  );
}

function safeCwd(): string {
  try {
    return Deno.cwd();
  } catch {
    return ".";
  }
}

async function printDocument(
  doc: Document,
  color: boolean,
  lineNumbers: boolean,
): Promise<void> {
  await printLines(doc.lines, doc.lines.length, color, lineNumbers);
}

async function printLines(
  lines: Iterable<Line> | AsyncIterable<Line>,
  lineCount: number | undefined,
  color: boolean,
  lineNumbers: boolean,
): Promise<void> {
  const encoder = new TextEncoder();
  const gutterWidth = lineNumbers
    ? lineCount === undefined
      ? String(Number.MAX_SAFE_INTEGER).length + 1
      : Math.max(4, String(lineCount).length + 1)
    : 0;
  let chunk = "";
  let index = 0;
  for await (const line of lines) {
    if (index > 0) chunk += "\n";
    if (gutterWidth > 0) {
      chunk += String(index + 1).padStart(gutterWidth - 1) + " ";
    }
    chunk += renderLineColored(line, color);
    index++;
    if (chunk.length >= 64 * 1024) {
      writeAllSync(Deno.stdout, encoder.encode(chunk));
      chunk = "";
    }
  }
  if (chunk.length > 0) writeAllSync(Deno.stdout, encoder.encode(chunk));
}

interface SyncWriter {
  writeSync(data: Uint8Array): number;
}

function writeAllSync(writer: SyncWriter, data: Uint8Array): void {
  let offset = 0;
  while (offset < data.length) {
    const written = writer.writeSync(data.subarray(offset));
    if (written <= 0) {
      throw new Error("cf view: stdout accepted no bytes.");
    }
    offset += written;
  }
}

export const _internal = { printLines, writeAllSync };
