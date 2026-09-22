/**
 * The contract every source language plugs into so the `cf view` pager can
 * color, navigate, edit and (optionally) reason about it, plus selecting the
 * right language and byte decoder for a file. A language is a stateless
 * strategy object: one instance describes each supported syntax. Selection
 * combines explicit language choices, filename, shared-extension, or shebang
 * metadata, and byte content detection. Once selected, the pager dispatches
 * every operation through that object's methods.
 *
 * Per-file mutable state (a warm incremental parse, a language service) is not
 * held on the language; the language is a factory for the small stateful
 * objects that hold it ({@link Highlighter}, {@link Semantics}).
 *
 * A neutral core file (renderer, pager, diff builder, editor) that needs only
 * the contract imports its types with `import type`, which is erased, so it
 * does not depend on any concrete language at run time; only the selection
 * functions below pull the concrete languages in.
 */

import type {
  Definition,
  Document,
  Line,
  StructureNode,
  ViewMode,
} from "../model.ts";
import type { DiffMaps } from "../diffdoc.ts";
import type { DecodedLanguageSource, LanguageDecoder } from "./decoder.ts";
import { utf8Decoder } from "./decoder.ts";
import { typeScriptLanguage } from "./typescript/language.ts";
import { markdownLanguage } from "./markdown/language.ts";
import { jsonLanguage, jsonLinesLanguage } from "./json/language.ts";
import { yamlLanguage } from "./yaml/language.ts";
import { pythonLanguage } from "./python/language.ts";
import { binaryLanguage } from "./binary/language.ts";
import { plainTextLanguage } from "./plain-text/language.ts";
import type { LineEndingProvenance } from "../editbuffer.ts";

/**
 * Live syntax highlighting that re-highlights only the region an edit touches,
 * so the cost tracks the size of each edit rather than the whole document.
 */
export interface Highlighter {
  /** The current highlighted lines. */
  readonly lines: readonly Line[];

  /** Apply the new full text and return the updated lines. */
  update(
    text: string,
    lineEndings?: readonly (LineEndingProvenance | undefined)[],
  ): readonly Line[];
}

/** A resolved definition site for a referenced symbol (jump-to-definition). */
export interface DefTarget {
  readonly name: string;

  /** Offset within the same document, when the definition is in-document. */
  readonly blobOffset?: number;

  /** Real file path, when the definition is in a file outside the document. */
  readonly filePath?: string;

  /** Character offset within `filePath`. */
  readonly fileOffset?: number;

  /** 0-based line of the definition (document line in-document, file otherwise). */
  readonly line: number;

  /** 0-based display column of the definition. */
  readonly col?: number;

  /** A trimmed one-line preview of the definition site. */
  readonly preview: string;
}

/**
 * The optional semantic layer a language may provide: "what type is this?" and
 * "where is this defined?", answered against the real workspace. Every query is
 * best-effort and degrades to `null`/empty rather than throwing.
 */
export interface Semantics {
  /** The inferred type at a source offset, or `null` when not knowable. */
  typeAt(offset: number): string | null;

  /**
   * Where the symbol at a source offset is defined. In-document definitions
   * carry a `blobOffset`; definitions in real files carry a `filePath`. Empty
   * when nothing resolves.
   */
  definitionOf(offset: number): DefTarget[];

  /** Read and color an external file (within the workspace) so the pager can
   * show a definition that lives outside the document. Null when unreadable. */
  fileLines(filePath: string): readonly Line[] | null;

  /** Build the backing program now (off the interactive path), so the first
   * real query does not pay the one-time cost. Safe to call repeatedly. */
  prewarm(): void;
}

/** Options a language needs to build its semantic layer. */
export interface SemanticsOptions {
  /** Working directory, for discovering the workspace / import map. */
  cwd: string;

  /** Name for the implicit single section when the text has no headers. */
  fileName?: string;
}

/** Byte extent retained for a rendered preview. */
export interface RenderInputExtent {
  /** Total byte count when {@link complete} is true, otherwise bytes retained. */
  readonly byteLength: number;

  /** Whether {@link byteLength} is the complete input size. */
  readonly complete: boolean;
}

/** Incremental recognition for a language whose source model retains bytes. */
export interface ByteLanguageDetector {
  write(bytes: Uint8Array): boolean;
  finish(): boolean;
}

interface LanguageInputBase {
  /** How file bytes become the string retained by the view model. */
  readonly decoder: LanguageDecoder;

  /** When present, files using this input representation are read-only. */
  readonly readOnlyReason?: string;
}

/** Input behavior shared by ordinary source languages. */
export interface TextLanguageInput extends LanguageInputBase {
  readonly kind: "text";
}

/** Input behavior required for a byte-oriented language. */
export interface ByteLanguageInput extends LanguageInputBase {
  readonly kind: "bytes";
  readonly readOnlyReason: string;

  /** Build a fresh incremental content detector. */
  createDetector(): ByteLanguageDetector;

  /** Maximum raw bytes retained for an interactive rendered preview. */
  readonly previewByteLimit: number;

  /** Render retained bytes as a bounded whole-file view. */
  renderLines(raw: string, extent?: RenderInputExtent): Line[];

  /** Render complete redirected input without retaining it. */
  renderByteStream(chunks: AsyncIterable<Uint8Array>): AsyncIterable<Line>;

  /** Number of rows produced for a complete byte count. */
  renderedByteLineCount(byteLength: number): number;
}

export type LanguageInput = TextLanguageInput | ByteLanguageInput;

/**
 * Everything a language needs to project a file's own structure tree into the
 * coordinates of a single diff hunk. `doc` is the parsed source the nodes come
 * from — the current workspace file for a verified hunk, or the hunk's own
 * fragment parse otherwise — and `lineToDiff` maps each of that source's line
 * numbers to the diff line that shows it.
 */
export interface HunkStructureContext {
  readonly doc: Document;

  /** Source line (file or fragment) → diff line, for the lines the hunk shows. */
  readonly lineToDiff: Map<number, number>;

  /** Whether UTF-8 decoding removed a BOM before this document was parsed. */
  readonly sourceOmitsUtf8Bom: boolean;

  /** Line starts of the source text `doc` was parsed from. */
  readonly sourceLineStarts: number[];

  /** Last diff line of the hunk (its extent). */
  readonly hunkEnd: number;

  readonly diffLineStarts: number[];
  readonly rawLines: string[];

  /** Name → declaration index the remap contributes to (for `t` peeks). */
  readonly definitions: Map<string, Definition[]>;
}

/** One word of a shebang command: an exact spelling or a regular expression. */
export type InterpreterWordPattern = string | RegExp;

/**
 * A shebang command a language claims. A single pattern matches the executable
 * basename on its own. A list matches that basename and the words that follow
 * it, so a launcher such as `uv run` is told apart from the launcher's other
 * subcommands.
 */
export type InterpreterPattern =
  | InterpreterWordPattern
  | readonly InterpreterWordPattern[];

/**
 * An extension that several syntaxes use, such as `.cfg`. The language claims
 * a name ending in {@link extension} only when the source also matches
 * {@link content}, so selection that has no source text leaves the name to
 * another language or to plain text.
 */
export interface SharedExtension {
  /** The extension, including its leading dot, compared without case. */
  readonly extension: string;

  /** The evidence this language requires from the complete source. */
  readonly content: RegExp;
}

/**
 * Declarative names that select a language. Extensions include their leading
 * dot and compare without case. Exact filenames and regular-expression
 * patterns match a path's basename. Aliases name explicit language overrides.
 * Interpreters match the command words extracted from a shebang, whose first
 * word is the executable's basename. Shared
 * extensions name syntaxes that one extension cannot tell apart, and pair each
 * with the source evidence that settles it.
 */
export interface LanguageMetadata {
  readonly extensions: readonly string[];
  readonly filenames: readonly string[];
  readonly filenamePatterns: readonly RegExp[];
  readonly aliases: readonly string[];
  readonly interpreters: readonly InterpreterPattern[];
  readonly sharedExtensions: readonly SharedExtension[];
}

/**
 * A source language the pager can render and navigate. Selection reads each
 * language's metadata once per source; all later work is method dispatch.
 */
export interface Language {
  /**
   * Stable identifier, such as `"typescript"`, `"markdown"`, `"json"`,
   * `"json-lines"`, `"yaml"`, `"python"`, `"binary"`, or `"plain-text"`.
   */
  readonly id: string;

  /** Decoding and, for byte languages, incremental rendering behavior. */
  readonly input: LanguageInput;

  /** Filename, shared-extension, explicit-name, and shebang selectors for
   * this language. */
  readonly metadata: LanguageMetadata;

  /**
   * Load whatever this language needs before any of the synchronous methods
   * below run, such as a parser that is fetched and compiled. A view prepares
   * the languages it has selected, and the interactive pager prepares every
   * language, because the file it opens next can be in any of them. Repeated
   * calls share one load. A language with nothing to load omits this.
   */
  prepare?(): Promise<void>;

  /** Parse `text` into the full document model: colored lines, a structure
   * tree, and a name → definition index. `fileName` is advisory. */
  parseDocument(text: string, fileName?: string): Document;

  /** Color `text` into rendered lines only — the per-keystroke-safe subset of
   * {@link parseDocument}, with no structure tree or definitions. Used by the
   * non-interactive fast path and the diff fragment renderer. `fileName` is
   * advisory (a language may parse `.ts` and `.tsx` differently). */
  highlightLines(text: string, fileName?: string): Line[];

  /**
   * Format `text` as the language's rendered representation. A source-topology
   * renderer keeps one display line for every source line, including blank
   * display lines for source-only delimiters. That shared line topology keeps
   * line numbers, structure ranges, diff markers, expansion, and source editing
   * aligned. A line that omits meaningful source content sets
   * `renderedSourceHidden` so a diff can retain its source form when that
   * content changes. A renderer with independent topology owns its whole-file
   * display layout and is not used inside diffs.
   */
  renderLines?(
    text: string,
    fileName?: string,
    extent?: RenderInputExtent,
  ): Line[];

  /** Whether rendered lines preserve the source's one-line-per-line layout.
   * The default is `"source"`. Independent layouts are whole-file views and
   * are not projected onto diff lines. */
  readonly renderLineTopology?: "source" | "independent";

  /** Representation used when the caller did not request one explicitly. */
  readonly defaultViewMode?: ViewMode;

  /** Whether an empty decoded input is a complete view. */
  readonly allowsEmptyInput?: boolean;

  /**
   * Rendering needs the complete file because syntax before a fragment can
   * determine how the fragment is interpreted. A contextless diff fragment
   * stays in source form when this is true.
   */
  readonly renderNeedsCompleteFile?: boolean;

  /** Whether live diff edits need complete-file highlighting because an earlier
   * line can determine how later lines are colored. */
  readonly highlightFullFileOnDiffEdit?: boolean;

  /** Highlight one source-line edit from its previous complete-file colors, or
   * return null when the edit can affect syntax outside one token. */
  highlightDiffLineEditLocally?(before: Line, after: string): Line | null;

  /** An incremental highlighter seeded with `text`, for live editing.
   * `fileName` is advisory, as for {@link highlightLines}. */
  createHighlighter(text: string, fileName?: string): Highlighter;

  /** Project `ctx.doc`'s structure tree into one diff hunk's coordinates. Also
   * populates `ctx.definitions` with the surviving nodes' declared names, so a
   * peek resolves against the diff. */
  hunkStructure(ctx: HunkStructureContext): StructureNode[];

  /** Build a semantic service over a single document/blob, or return undefined
   * when this language has no semantic layer. */
  createSemantics?(
    text: string,
    options: SemanticsOptions,
  ): Semantics | undefined;

  /** Build a semantic service for a diff view — queries map through
   * {@link DiffMaps} to the current workspace files — or undefined when this
   * language has no semantic layer. */
  createDiffSemantics?(
    diffText: string,
    maps: DiffMaps,
    options: SemanticsOptions,
  ): Semantics | undefined;
}

/** Load the parsers these languages need, so their parsing can stay
 * synchronous. Repeats are free, and a language with nothing to load is
 * skipped. */
export function prepareLanguages(
  languages: Iterable<Language>,
): Promise<void> {
  return Promise.all(
    [...languages].map((language) => language.prepare?.()),
  ).then(() => {});
}

/**
 * Warm every language's parser, for a view that can open any file. A language
 * whose parser will not load leaves the rest of them working; opening a file in
 * that language then fails, saying why the parser did not load.
 */
export async function warmAllLanguages(): Promise<void> {
  await Promise.allSettled(
    allLanguages().map((language) => language.prepare?.()),
  );
}

/** Whether a renderer can be projected onto line-aligned diff content. */
export function canRenderDiffLines(language: Language): boolean {
  return languageRenderer(language) !== undefined &&
    language.renderLineTopology !== "independent";
}

/** Render through a language and validate its declared line topology. */
export function renderedLinesFor(
  language: Language,
  text: string,
  fileName?: string,
  extent?: RenderInputExtent,
): Line[] | undefined {
  const renderLines = languageRenderer(language);
  if (renderLines === undefined) return undefined;
  const lines = renderLines(text, fileName, extent);
  if (language.renderLineTopology !== "independent") {
    const sourceLineCount = text.split("\n").length;
    if (lines.length !== sourceLineCount) {
      throw new Error(
        `${language.id} rendered ${lines.length} lines for ${sourceLineCount} source lines`,
      );
    }
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.text.includes("\n")) {
      throw new Error(
        `${language.id} rendered a line break inside display line ${index + 1}`,
      );
    }
    if (line.spans.map((span) => span.text).join("") !== line.text) {
      throw new Error(
        `${language.id} rendered spans that do not reconstruct display line ${
          index + 1
        }`,
      );
    }
  }
  return lines;
}

function languageRenderer(
  language: Language,
):
  | ((
    text: string,
    fileName?: string,
    extent?: RenderInputExtent,
  ) => Line[])
  | undefined {
  const input = language.input;
  if (input.kind === "bytes") {
    return (text, _fileName, extent) => input.renderLines(text, extent);
  }
  return language.renderLines;
}

/** The decoder selected by a language's input representation. */
export function decoderFor(language: Language): LanguageDecoder {
  return language.input.decoder;
}

/** A language's byte-oriented input behavior, when it has one. */
export function byteInputFor(
  language: Language,
): ByteLanguageInput | undefined {
  return language.input.kind === "bytes" ? language.input : undefined;
}

/** Why a language cannot be edited, when it is read-only. */
export function readOnlyReasonFor(language: Language): string | undefined {
  return language.input.readOnlyReason;
}

//
// selection
//

/** Memo for {@link allLanguages}, filled on its first call. */
let languages: readonly Language[] | undefined;

/**
 * Every language the pager knows, most specific first, built on first use.
 * Plain text comes last and remains the fallback after metadata selection.
 *
 * The list is lazy so this module's top level never reads the concrete language
 * singletons: they and this module form an import cycle (a language's semantic
 * layer resolves external files back through {@link languageForFile}), and
 * building the array eagerly would read a singleton that a cycle-first load had
 * not yet initialized. By first use every module has finished evaluating.
 */
function allLanguages(): readonly Language[] {
  return languages ??= [
    typeScriptLanguage,
    markdownLanguage,
    jsonLanguage,
    jsonLinesLanguage,
    yamlLanguage,
    pythonLanguage,
    binaryLanguage,
    plainTextLanguage,
  ];
}

/** Incrementally select any byte language from streamed content. */
export function createByteLanguageDetector(): {
  readonly previewByteLimit: number;
  write(bytes: Uint8Array): Language | undefined;
  finish(): Language | undefined;
} {
  const entries = allLanguages().flatMap((language) => {
    const input = byteInputFor(language);
    return input === undefined
      ? []
      : [{ language, input, detector: input.createDetector() }];
  });
  return {
    previewByteLimit: Math.max(
      0,
      ...entries.map(({ input }) => input.previewByteLimit),
    ),
    write(bytes) {
      return entries.find(({ detector }) => detector.write(bytes))?.language;
    },
    finish() {
      return entries.find(({ detector }) => detector.finish())?.language;
    },
  };
}

/** Whether metadata claims a filename. */
export function metadataMatchesFilename(
  metadata: LanguageMetadata,
  fileName: string | undefined,
): boolean {
  if (fileName === undefined) return false;
  const filename = basename(fileName);
  const lower = filename.toLowerCase();
  if (
    metadata.extensions.some((extension) =>
      lower.endsWith(extension.toLowerCase())
    )
  ) {
    return true;
  }
  if (metadata.filenames.includes(filename)) return true;
  return metadata.filenamePatterns.some((pattern) =>
    regularExpressionMatches(pattern, filename)
  );
}

/** Whether metadata claims a shared extension that this source confirms. */
export function metadataMatchesSharedExtension(
  metadata: LanguageMetadata,
  fileName: string | undefined,
  text: string,
): boolean {
  if (fileName === undefined) return false;
  const lower = basename(fileName).toLowerCase();
  return metadata.sharedExtensions.some((shared) =>
    lower.endsWith(shared.extension.toLowerCase()) &&
    regularExpressionMatches(shared.content, text)
  );
}

/** The language selected by filename metadata, with plain text as fallback. */
export function languageForFile(fileName: string | undefined): Language {
  return languageMatchingFilename(fileName) ?? plainTextLanguage;
}

export interface DecodeLanguageInputOptions {
  /** A streamed detector already consumed the complete input without selecting
   * a byte language. */
  readonly byteLanguageDetectionComplete?: boolean;
}

/** Select a language from bytes and decode them exactly once. */
export function decodeLanguageInput(
  fileName: string | undefined,
  bytes: Uint8Array,
  options: DecodeLanguageInputOptions = {},
): { language: Language; source: DecodedLanguageSource } {
  const byFilename = languageMatchingFilename(fileName);
  if (byFilename?.input.kind === "bytes") {
    return {
      language: byFilename,
      source: byFilename.input.decoder.decode(bytes),
    };
  }
  if (!options.byteLanguageDetectionComplete) {
    const detector = createByteLanguageDetector();
    const detected = detector.write(bytes) ?? detector.finish();
    if (detected !== undefined) {
      return {
        language: detected,
        source: detected.input.decoder.decode(bytes),
      };
    }
  }
  return decodeTextInput(
    fileName,
    byFilename,
    bytes,
    allLanguages().find((language) => language.input.kind === "bytes"),
  );
}

function decodeTextInput(
  fileName: string | undefined,
  selectedLanguage: Language | undefined,
  bytes: Uint8Array,
  byteFallback: Language | undefined,
): { language: Language; source: DecodedLanguageSource } {
  let source: DecodedLanguageSource;
  try {
    source = (selectedLanguage?.input.decoder ?? utf8Decoder).decode(bytes);
  } catch {
    if (byteFallback === undefined) {
      throw new TypeError("No byte language available.");
    }
    return {
      language: byteFallback,
      source: byteFallback.input.decoder.decode(bytes),
    };
  }
  return {
    language: selectedLanguage ??
      languageMatchingSource(fileName, source.text) ??
      plainTextLanguage,
    source,
  };
}

function languageMatchingFilename(
  fileName: string | undefined,
): Language | undefined {
  for (const language of allLanguages()) {
    if (metadataMatchesFilename(language.metadata, fileName)) return language;
  }
  return undefined;
}

/** The language a shared extension or a shebang selects from source content. */
function languageMatchingSource(
  fileName: string | undefined,
  text: string,
): Language | undefined {
  const shared = allLanguages().find((language) =>
    metadataMatchesSharedExtension(language.metadata, fileName, text)
  );
  return shared ?? languageForShebang(text);
}

/**
 * Select a language for complete source. A recognized filename takes
 * precedence. A shared extension takes the source evidence its metadata names,
 * and a filename with no metadata match can defer to a shebang.
 */
export function languageForSource(
  fileName: string | undefined,
  text: string,
): Language {
  const byFilename = languageMatchingFilename(fileName);
  if (byFilename !== undefined) return byFilename;
  const source = text.replace(/^\uFEFF/, "");
  return languageMatchingSource(fileName, source) ?? plainTextLanguage;
}

let languagesByName: ReadonlyMap<string, Language> | undefined;
function namedLanguages(): ReadonlyMap<string, Language> {
  return languagesByName ??= indexLanguagesByName(allLanguages());
}

/** Build the explicit-name index and reject ambiguous identifiers or aliases. */
export function indexLanguagesByName(
  languages: readonly Language[],
): ReadonlyMap<string, Language> {
  const named = new Map<string, Language>();
  for (const language of languages) {
    for (const name of [language.id, ...language.metadata.aliases]) {
      const existing = named.get(name);
      if (existing !== undefined) {
        throw new Error(
          `Language name "${name}" belongs to both ${existing.id} and ${language.id}`,
        );
      }
      named.set(name, language);
    }
  }
  return named;
}

/** Look up a language by its stable identifier or alias. */
export function languageForName(name: string): Language | undefined {
  return namedLanguages().get(name);
}

/** Stable identifiers accepted by an explicit language override. */
export function languageIds(): string[] {
  return allLanguages().map((language) => language.id);
}

/** Stable identifiers and aliases accepted by an explicit language override. */
export function languageNames(): string[] {
  return [...namedLanguages().keys()];
}

/** The TypeScript default for filename-free `cf check --show-transformed`
 * output. The caller checks the compiler's module header before selecting it. */
export function languageForTransformedOutput(): Language {
  return typeScriptLanguage;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function languageForShebang(text: string): Language | undefined {
  const command = shebangCommand(text);
  if (command === undefined) return undefined;
  return allLanguages().find((language) =>
    language.metadata.interpreters.some((pattern) =>
      interpreterMatches(pattern, command)
    )
  );
}

/** Whether a claimed command is the start of the shebang's command words. */
function interpreterMatches(
  pattern: InterpreterPattern,
  command: readonly string[],
): boolean {
  const words: readonly InterpreterWordPattern[] =
    typeof pattern === "string" || pattern instanceof RegExp
      ? [pattern]
      : pattern;
  return words.length <= command.length &&
    words.every((word, index) =>
      typeof word === "string"
        ? word === command[index]
        : regularExpressionMatches(word, command[index])
    );
}

function regularExpressionMatches(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  const matches = pattern.test(value);
  pattern.lastIndex = 0;
  return matches;
}

/**
 * Extract the command words from a direct shebang or an `env` shebang, with
 * the executable reduced to its basename. `env -S` supplies the command after
 * the split-string flag.
 */
function shebangCommand(text: string): string[] | undefined {
  const end = text.indexOf("\n");
  const firstLine = (end < 0 ? text : text.slice(0, end)).replace(/\r$/, "");
  if (!firstLine.startsWith("#!")) return undefined;
  const command = firstLine.slice(2).trimStart();
  if (command.length === 0) return undefined;
  const separator = command.search(/\s/);
  const executable = separator < 0 ? command : command.slice(0, separator);
  const rest = separator < 0 ? "" : command.slice(separator);
  const direct = basename(executable);
  if (direct !== "env") {
    return [direct, ...[...rest.matchAll(/\S+/g)].map((match) => match[0])];
  }
  return envCommandFromShebang(rest);
}

function envCommandFromShebang(input: string): string[] | undefined {
  const matches = [...input.matchAll(/\S+/g)];
  let options = true;
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    const word = match[0];
    if (options) {
      const rest = input.slice(match.index! + word.length);
      if (word === "--") {
        options = false;
        continue;
      }
      if (word === "-S" || word === "--split-string") {
        return splitEnvCommand(rest);
      }
      if (word.startsWith("--split-string=")) {
        return splitEnvCommand(word.slice("--split-string=".length) + rest);
      }
      const combinedSplitOffset = envCombinedSplitOffset(word);
      if (combinedSplitOffset !== undefined) {
        return splitEnvCommand(word.slice(combinedSplitOffset) + rest);
      }
      if (envOptionTakesFollowingWord(word)) {
        index++;
        continue;
      }
      if (word.startsWith("-")) continue;
    }
    if (/^[^=]+=/.test(word)) {
      options = false;
      continue;
    }
    return [
      basename(word),
      ...matches.slice(index + 1).map((following) => following[0]),
    ];
  }
  return undefined;
}

function envCombinedSplitOffset(word: string): number | undefined {
  if (!word.startsWith("-")) return undefined;
  let index = 1;
  while (word[index] === "i" || word[index] === "v" || word[index] === "0") {
    index++;
  }
  return word[index] === "S" ? index + 1 : undefined;
}

function envOptionTakesFollowingWord(word: string): boolean {
  if (
    word === "--unset" || word === "--chdir" || word === "--path" ||
    word === "--argv0"
  ) {
    return true;
  }
  const grouped = word.match(/^-[iv0]*[uCPa](.*)$/);
  return grouped !== null && grouped[1].length === 0;
}

function splitEnvCommand(input: string): string[] | undefined {
  const words = splitShebangWords(input);
  return words === undefined ? undefined : envCommand(words);
}

interface EnvWord {
  readonly text: string;
  readonly stable: boolean;
}

interface EnvWordFrame {
  readonly words: readonly EnvWord[];
  index: number;
}

function nextEnvWord(frames: EnvWordFrame[]): EnvWord | undefined {
  while (frames.length > 0) {
    const frame = frames[frames.length - 1];
    if (frame.index < frame.words.length) {
      return frame.words[frame.index++];
    }
    frames.pop();
  }
  return undefined;
}

function envWord(text: string, stable: boolean): EnvWord {
  return {
    text,
    stable: stable && text.length > 0,
  };
}

function envWordSuffix(word: EnvWord, start: number): EnvWord {
  const text = word.text.slice(start);
  return {
    text,
    stable: word.stable && text.length > 0 && !text.startsWith("#"),
  };
}

function splitEnvWord(word: EnvWord): EnvWord[] | undefined {
  return word.stable ? [word] : splitShebangWords(word.text);
}

function envCommand(initialWords: readonly EnvWord[]): string[] | undefined {
  const frames: EnvWordFrame[] = [{ words: initialWords, index: 0 }];
  let options = true;
  for (;;) {
    const word = nextEnvWord(frames);
    if (word === undefined) return undefined;
    const text = word.text;
    if (options) {
      if (text === "--") {
        options = false;
        continue;
      }
      let splitString: EnvWord | undefined;
      if (text === "-S" || text === "--split-string") {
        splitString = nextEnvWord(frames);
        if (splitString === undefined) return undefined;
      } else if (text.startsWith("--split-string=")) {
        splitString = envWordSuffix(word, "--split-string=".length);
      } else {
        const combinedSplitOffset = envCombinedSplitOffset(text);
        if (combinedSplitOffset !== undefined) {
          splitString = combinedSplitOffset < text.length
            ? envWordSuffix(word, combinedSplitOffset)
            : nextEnvWord(frames);
          if (splitString === undefined) return undefined;
        }
      }
      if (splitString !== undefined) {
        const splitWords = splitEnvWord(splitString);
        if (splitWords === undefined) return undefined;
        frames.push({ words: splitWords, index: 0 });
        continue;
      }
      if (envOptionTakesFollowingWord(text)) {
        if (nextEnvWord(frames) === undefined) return undefined;
        continue;
      }
      if (text.startsWith("-")) continue;
    }
    if (/^[^=]+=/.test(text)) {
      options = false;
      continue;
    }
    const command = [basename(text)];
    for (;;) {
      const following = nextEnvWord(frames);
      if (following === undefined) return command;
      command.push(following.text);
    }
  }
}

const ENV_SPLIT_ESCAPES: Readonly<Record<string, string | undefined>> = {
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  " ": " ",
  "\t": "\t",
  "#": "#",
  "$": "$",
  '"': '"',
  "'": "'",
  "\\": "\\",
};

function splitShebangWords(input: string): EnvWord[] | undefined {
  const words: EnvWord[] = [];
  let word = "";
  let stable = true;
  let started = false;
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (escaped) {
      escaped = false;
      if (quote === "'" && char !== "'" && char !== "\\") {
        word += `\\${char}`;
        stable = false;
        started = true;
        continue;
      }
      if (char === "c") {
        if (quote === '"') return undefined;
        break;
      }
      if (char === "_") {
        if (quote === '"') {
          word += " ";
          stable = false;
          started = true;
        } else if (started) {
          words.push(envWord(word, stable));
          word = "";
          stable = true;
          started = false;
        }
        continue;
      }
      const replacement = ENV_SPLIT_ESCAPES[char];
      if (replacement === undefined) return undefined;
      stable &&= envTextIsStable(replacement, word.length === 0);
      word += replacement;
      started = true;
      continue;
    }
    if (char === "$" && quote !== "'") {
      const variable = input.slice(index).match(
        /^\$\{[A-Za-z_][A-Za-z0-9_]*\}/,
      )?.[0];
      if (variable === undefined) return undefined;
      word += variable;
      started = true;
      index += variable.length - 1;
      continue;
    }
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
        started = true;
      } else if (char === "\\") {
        escaped = true;
      } else {
        stable &&= envTextIsStable(char, word.length === 0);
        word += char;
        started = true;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === " " || char === "\t") {
      if (started) {
        words.push(envWord(word, stable));
        word = "";
        stable = true;
        started = false;
      }
    } else if (char === "#" && !started) {
      break;
    } else {
      stable &&= envTextIsStable(char, word.length === 0);
      word += char;
      started = true;
    }
  }
  if (escaped || quote !== undefined) return undefined;
  if (started) words.push(envWord(word, stable));
  return words;
}

function envTextIsStable(text: string, atStart: boolean): boolean {
  return !/[ \t\\'"$]/.test(text) && !(atStart && text.startsWith("#"));
}

/** The distinct languages a set of files resolves to, in first-seen order. */
export function distinctLanguages(
  fileNames: readonly (string | undefined)[],
): Language[] {
  const seen = new Set<string>();
  const out: Language[] = [];
  for (const name of fileNames) {
    const language = languageForFile(name);
    if (!seen.has(language.id)) {
      seen.add(language.id);
      out.push(language);
    }
  }
  return out;
}

/**
 * The semantic service for a diff view, from the languages the diff touches. A
 * diff spans potentially many files of different languages; the service is the
 * first language present that offers one, scoped to just its own files (so a
 * TypeScript program is not seeded with the diff's non-TypeScript files). Only
 * TypeScript offers one today, so this resolves to it whenever the diff includes
 * a TypeScript file and to nothing otherwise. When a second semantic language
 * appears this becomes a per-file composite; the per-language slot the pager
 * dispatches through is already here.
 */
export function diffSemanticsFor(
  languages: readonly Language[],
  diffText: string,
  maps: DiffMaps,
  options: SemanticsOptions,
): Semantics | undefined {
  for (const language of languages) {
    if (!language.createDiffSemantics) continue;
    const rootFiles = maps.rootFiles.filter((path) =>
      languageForFile(path) === language
    );
    if (rootFiles.length === 0) continue;
    const semantics = language.createDiffSemantics(
      diffText,
      { ...maps, rootFiles },
      options,
    );
    if (semantics) return semantics;
  }
  return undefined;
}

export const _internal = { decodeTextInput };
