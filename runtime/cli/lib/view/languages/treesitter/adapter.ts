/**
 * The language-neutral Tree-sitter adapter every parser-backed language in the
 * pager runs on. A language supplies a {@link TreeSitterGrammar}: where its
 * compiled parser is, a highlight query whose capture names are token classes,
 * and a rule turning one syntax node into a structure entry. Loading, gapless
 * coloring, bracket depth, incremental editing, and the structure tree are
 * here, so a language module holds only what is particular to its syntax.
 *
 * Loading a grammar is asynchronous and the pager's parsing surface is
 * synchronous, so a view loads the grammars it needs through
 * {@link prepareGrammar} before it parses anything. A synchronous entry point
 * reached before its grammar has loaded shows the source as plain text and
 * starts the load, and {@link onGrammarLoad} tells a view when to parse again,
 * or why the grammar could not load.
 *
 * Offsets throughout are JavaScript string offsets — UTF-16 code units — which
 * is what the Tree-sitter JavaScript binding reports for nodes and accepts for
 * edits. A contract test over non-ASCII source pins that convention.
 */

import { describeFailure } from "@commonfabric/js-values/describe-failure";
import type {
  Document,
  Line,
  StructureKind,
  StructureNode,
  TokenClass,
} from "../../model.ts";
import { flattenStructure } from "../../model.ts";
import { computeLineStarts, lineIndexOf } from "../../lines.ts";
import { isTokenClass } from "../../theme.ts";
import { linesFromClasses } from "../classes.ts";
import {
  structureNode,
  type StructureSource,
  structureSource,
} from "../structure.ts";
import {
  createPlainTextHighlighter,
  plainTextDocument,
  plainTextLines,
} from "../plain-text/plain-text.ts";
import type { Highlighter } from "../language.ts";
import type * as treeSitter from "web-tree-sitter";

type TreeSitterModule = typeof treeSitter;
type Parser = InstanceType<TreeSitterModule["Parser"]>;
type Query = InstanceType<TreeSitterModule["Query"]>;
type Tree = NonNullable<ReturnType<Parser["parse"]>>;

/** One node of a loaded grammar's parse tree. */
export type SyntaxNode = Tree["rootNode"];

/** What a grammar makes of a syntax node the structure tree should carry. */
export interface StructureEntry {
  readonly kind: StructureKind;

  /** Short human label, such as `def render`. */
  readonly label: string;

  /** Declared identifier, indexed for definition peeks. */
  readonly name?: string;

  /** Offset of that identifier, for a peek that resolves by position. */
  readonly nameOffset?: number;

  /** Node whose extent the entry covers, when a wrapper carries it. */
  readonly extent?: SyntaxNode;
}

/** Everything a language contributes to the shared parser. */
export interface TreeSitterGrammar {
  /** Stable identifier, also the key the loaded parser is cached under. */
  readonly id: string;

  /** Compiled grammar location, resolved through the language's import map. */
  wasmUrl(): string;

  /** Highlight query whose capture names are {@link TokenClass} values. The
   * narrowest capture over a character colors it, and the earliest pattern
   * wins between captures of the same extent. */
  readonly highlightQuery: string;

  /** The structure entry a node declares, or undefined when it declares none.
   * The walk descends into the node either way, unless
   * {@link structureParents} leaves out the node's type. */
  structureEntry(node: SyntaxNode): StructureEntry | undefined;

  /** Stretches of source whose line breaks the language ignores and the
   * grammar reads as the end of a statement. The parser reads each line break
   * inside a match as a space, which leaves every offset unchanged, so a match
   * must not hold the line break that ends a line comment. The expression must
   * be global. */
  readonly insignificantLineBreaks?: RegExp;

  /** The node types a structure entry can be found inside. When given, the
   * walk does not descend into nodes of any other type. */
  readonly structureParents?: ReadonlySet<string>;

  /** The rule for comments that end before the point the parser reads them
   * to. */
  readonly shortComments?: ShortComments;
}

/** A stretch of source, as offsets. */
export interface SourceRange {
  readonly start: number;
  readonly end: number;
}

/** A place in the source: an offset, and the row and column it falls on. */
export interface SourcePoint {
  readonly index: number;
  readonly row: number;
  readonly column: number;
}

/**
 * Comments that end before the point the grammar's parser reads them to. The
 * adapter asks the rule for the first such comment, reads it as blank space,
 * parses again, and asks for the next one after it. So each comment is judged
 * from a parse that reads every comment before it as the language does, and
 * none is judged again. The comments read as blank space are colored as
 * comments.
 *
 * The work this takes is bounded by a multiple of the plain parse's and a
 * fixed amount more, after which the comments that remain run to where the
 * parser reads them. An edit to a source with such comments or with errors
 * parses it afresh, as a complete highlight does, so that the two agree.
 */
export interface ShortComments {
  /** The first comment starting at or after `from` that ends sooner than the
   * parser reads it, with the offset where it ends. Undefined when there is
   * none, or when the parse cannot show whether the next comment does. */
  next(
    root: SyntaxNode,
    source: string,
    from: SourcePoint,
  ): SourceRange | undefined;
}

interface LoadedGrammar {
  readonly parser: Parser;
  readonly query: Query;
}

const loaded = new Map<string, LoadedGrammar>();
const loading = new Map<string, Promise<void>>();

/** The runtime shared by every loaded grammar, present once one is loaded. */
let runtime: TreeSitterModule | undefined;

/** The runtime's one initialization, which every grammar load awaits. */
let initialized: Promise<TreeSitterModule> | undefined;

/** What to call each time a grammar's load ends. */
const loadListeners = new Set<(failure?: string) => void>();

/**
 * Calls `listener` each time a grammar's load ends, until the returned
 * function is called: with no argument when the grammar loaded, and with the
 * reason when it could not. A source shown as plain text because its grammar
 * was still loading is colored by parsing it again once the grammar loads, and
 * stays plain if it cannot.
 */
export function onGrammarLoad(
  listener: (failure?: string) => void,
): () => void {
  loadListeners.add(listener);
  return () => loadListeners.delete(listener);
}

/** Load a grammar's runtime and parser, once per grammar. */
export function prepareGrammar(grammar: TreeSitterGrammar): Promise<void> {
  if (loaded.has(grammar.id)) return Promise.resolve();
  const pending = loading.get(grammar.id) ?? loadGrammar(grammar);
  loading.set(grammar.id, pending);
  return pending;
}

async function loadGrammar(grammar: TreeSitterGrammar): Promise<void> {
  const failed = await loadGrammarNow(grammar, grammar.wasmUrl()).then(
    () => undefined,
    (error: unknown) => ({ error }),
  );
  const failure = failed === undefined
    ? undefined
    : describeFailure(failed.error);
  for (const listener of loadListeners) listener(failure);
  if (failed !== undefined) throw failed.error;
}

/**
 * Loads and initializes the runtime once. Initializing it again while an
 * earlier initialization is in flight creates a second WebAssembly module and
 * replaces the first, and a grammar loaded into the replaced module fails to
 * parse.
 */
function initializeRuntime(): Promise<TreeSitterModule> {
  return initialized ??= (async () => {
    // The runtime is loaded when a view selects a parser-backed language, and
    // not before.
    // deno-lint-ignore cf-imports/no-inline-module-import -- loaded on selection
    const module = await import("web-tree-sitter");
    await module.Parser.init();
    return runtime = module;
  })();
}

async function loadGrammarNow(
  grammar: TreeSitterGrammar,
  wasmUrl: string,
): Promise<void> {
  const module = await initializeRuntime();
  const wasm = await readGrammar(grammar.id, wasmUrl);
  const language = await module.Language.load(wasm);
  const parser = new module.Parser();
  parser.setLanguage(language);
  const query = new module.Query(language, grammar.highlightQuery);
  for (const name of query.captureNames) {
    if (!isTokenClass(name)) {
      throw new Error(
        `cf view: the ${grammar.id} highlight query captures "${name}", ` +
          `which is not a token class.`,
      );
    }
  }
  loaded.set(grammar.id, { parser, query });
}

/** Read a compiled grammar, saying which one when it cannot be read: it ships
 * beside the code rather than with the file being viewed. */
async function readGrammar(id: string, wasmUrl: string): Promise<Uint8Array> {
  try {
    return await Deno.readFile(new URL(wasmUrl));
  } catch (error) {
    throw new Error(
      `cf view: the ${id} grammar could not be read from ${wasmUrl}.`,
      { cause: error },
    );
  }
}

/**
 * Returns a loaded grammar, or undefined when it has not loaded, starting its
 * load if none has started.
 */
function loadedGrammar(grammar: TreeSitterGrammar): LoadedGrammar | undefined {
  const ready = loaded.get(grammar.id);
  // A load that fails reports why to the load listeners.
  if (ready === undefined) prepareGrammar(grammar).catch(() => {});
  return ready;
}

/** The text a grammar's parser reads for `text`, offset for offset. */
function parserText(grammar: TreeSitterGrammar, text: string): string {
  const spans = grammar.insignificantLineBreaks;
  return spans === undefined
    ? text
    : text.replaceAll(spans, (span) => span.replace(/[\r\n]/g, " "));
}

function parseWith(
  ready: LoadedGrammar,
  text: string,
  from?: Tree,
  onProgress?: () => void,
): Tree {
  const tree = ready.parser.parse(text, from, { progressCallback: onProgress });
  // deno-coverage-ignore-start -- a parse returns no tree only when it is
  // cancelled or given a deadline, and this one is given neither
  if (tree === null) throw new Error("cf view: Tree-sitter returned no tree.");
  // deno-coverage-ignore-stop
  return tree;
}

/** A parse of `source` from `tree` with `edit` applied to a copy of it,
 * leaving `tree` unchanged. */
function reparse(
  ready: LoadedGrammar,
  tree: Tree,
  edit: InstanceType<TreeSitterModule["Edit"]>,
  source: string,
): Tree {
  const edited = tree.copy();
  edited.edit(edit);
  try {
    return parseWith(ready, source, edited);
  } finally {
    edited.delete();
  }
}

/** A parse of a grammar's parser text, and of that text with the comments
 * the grammar's {@link ShortComments} rule finds read as blank space. Blank
 * space keeps every line start where it was. */
interface Parse {
  /** The grammar's parser text. */
  readonly plain: string;

  /** Where each line of {@link plain} starts. */
  readonly lineStarts: number[];

  /** The parse of {@link plain}. */
  readonly plainTree: Tree;

  /** The comments read as blank space, in source order. */
  readonly comments: readonly SourceRange[];

  /** The parse of {@link plain} with {@link comments} read as blank space. */
  readonly tree: Tree;
}

/**
 * The work the adapter may spend finding short comments, counted in the
 * parser's progress reports: this many times the reports of the plain parse,
 * and {@link SHORT_COMMENT_FLOOR} more. Each round finds one comment and
 * parses the source again with it read as blank space. Its walk to the
 * comment costs a sixteenth of the plain parse's reports, and one more, and
 * its parse costs what it reports.
 */
const SHORT_COMMENT_WORK = 4;

/** See {@link SHORT_COMMENT_WORK}. */
const SHORT_COMMENT_FLOOR = 4096;

/**
 * Parse `text` through its grammar, reusing `previous` when given, and read as
 * blank space the comments that the grammar's {@link ShortComments} rule
 * finds. The caller deletes the returned parse; `previous` is left as it was.
 */
function parseSource(
  grammar: TreeSitterGrammar,
  ready: LoadedGrammar,
  text: string,
  previous?: Parse,
): Parse {
  const plain = parserText(grammar, text);
  const lineStarts = computeLineStarts(plain);
  const at = (index: number): SourcePoint => ({
    index,
    ...point(lineStarts, index),
  });
  let plainWork = 0;
  const countWork = () => {
    plainWork++;
  };
  let plainTree = previous === undefined
    ? parseWith(ready, plain, undefined, countWork)
    : reparse(
      ready,
      previous.plainTree,
      treeEdit(
        textEdit(previous.plain, plain),
        previous.lineStarts,
        lineStarts,
      ),
      plain,
    );
  const rule = grammar.shortComments;
  // A parse reused across edits can differ from a fresh one where the source
  // has errors. Short comments are worked out from a fresh parse, as a
  // complete highlight's are, so that the two agree.
  if (
    rule !== undefined && previous !== undefined &&
    (previous.comments.length > 0 || plainTree.rootNode.hasError ||
      rule.next(plainTree.rootNode, plain, at(0)) !== undefined)
  ) {
    plainTree.delete();
    plainTree = parseWith(ready, plain, undefined, countWork);
  }
  const comments: SourceRange[] = [];
  let source = plain;
  let tree = plainTree.copy();
  const round = 1 + plainWork / 16;
  let work = SHORT_COMMENT_WORK * plainWork + SHORT_COMMENT_FLOOR;
  for (let from = 0; rule !== undefined && (work -= round) >= 0;) {
    const comment = rule.next(tree.rootNode, source, at(from));
    if (comment === undefined) break;
    if (comment.start < from || comment.end <= comment.start) {
      throw new Error(
        `cf view: the ${grammar.id} grammar gave a short comment from ` +
          `${comment.start} to ${comment.end}, which does not follow ${from}.`,
      );
    }
    const { start, end } = comment;
    const blanked = source.slice(0, start) +
      source.slice(start, end).replace(/[^\r\n]/g, " ") + source.slice(end);
    const edited = tree.copy();
    edited.edit(
      treeEdit({ start, oldEnd: end, newEnd: end }, lineStarts, lineStarts),
    );
    const nextTree = ready.parser.parse(blanked, edited, {
      progressCallback: () => --work < 0,
    });
    edited.delete();
    if (nextTree === null) {
      // A cancelled parse resumes on the parser's next call unless it is
      // reset.
      ready.parser.reset();
      break;
    }
    tree.delete();
    tree = nextTree;
    source = blanked;
    comments.push(comment);
    from = end;
  }
  return { plain, lineStarts, plainTree, comments, tree };
}

/** Release the parse trees `parse` holds. */
function deleteParse(parse: Parse): void {
  parse.tree.delete();
  parse.plainTree.delete();
}

/**
 * Color `text` through its grammar, one display line per source line, or as
 * plain text while the grammar loads.
 */
export function highlightLines(
  grammar: TreeSitterGrammar,
  text: string,
): Line[] {
  const classes = tokenClasses(grammar, text);
  return classes === undefined
    ? plainTextLines(text)
    : linesFromClasses(text, classes);
}

/**
 * The token class of every character of `text` through its grammar, left
 * undefined where the query claims nothing, or undefined while the grammar
 * loads. A language that colors part of its source with another language's
 * grammar reads that part's classes here.
 */
export function tokenClasses(
  grammar: TreeSitterGrammar,
  text: string,
): (TokenClass | undefined)[] | undefined {
  const ready = loadedGrammar(grammar);
  if (ready === undefined) return undefined;
  const parse = parseSource(grammar, ready, text);
  try {
    return classify(ready, parse, text.length);
  } finally {
    deleteParse(parse);
  }
}

/**
 * Color `text` and build its structure tree and definition index, or build a
 * plain document with neither while the grammar loads.
 */
export function parseDocument(
  grammar: TreeSitterGrammar,
  text: string,
): Document {
  const ready = loadedGrammar(grammar);
  if (ready === undefined) return plainTextDocument(text);
  const parse = parseSource(grammar, ready, text);
  try {
    const source = structureSource(text);
    const structure = structureNodes(grammar, parse.tree.rootNode, source, 0);
    return {
      text,
      lines: colorLines(ready, parse, text),
      structure,
      flatStructure: flattenStructure(structure),
      definitions: source.definitions,
    };
  } finally {
    deleteParse(parse);
  }
}

/**
 * An incremental highlighter, or a plain one while the grammar loads. Each
 * update edits the warm tree and re-parses from it, so the parse costs the
 * size of the edit, and then colors the whole document from that parse.
 *
 * The coloring is not narrowed to the lines the edit touched. An edit can move
 * a token's class anywhere in the document — closing a bracket completes an
 * expression above it, and a line break can turn a name into a call below it —
 * and the runtime's report of which ranges changed describes the tree's shape
 * rather than the queries that read it, so a node that kept its own type while
 * its parent changed is not in that report. Coloring the whole document is what
 * makes an update agree with a complete highlight, which a test asserts over a
 * series of edits.
 */
export function createHighlighter(
  grammar: TreeSitterGrammar,
  initial: string,
): Highlighter {
  const ready = loadedGrammar(grammar);
  if (ready === undefined) return createPlainTextHighlighter(initial);
  let text = initial;
  const held = { parse: parseSource(grammar, ready, text) };
  let lines = colorLines(ready, held.parse, text);
  const highlighter: Highlighter = {
    get lines() {
      return lines;
    },
    update(next: string): readonly Line[] {
      if (next === text) return lines;
      const previous = held.parse;
      held.parse = parseSource(grammar, ready, next, previous);
      deleteParse(previous);
      text = next;
      lines = colorLines(ready, held.parse, text);
      return lines;
    },
  };
  abandonedTrees.register(highlighter, held);
  return highlighter;
}

/** A parse tree lives in the parser's own memory, which collecting the object
 * that wraps it does not release, so a highlighter's current tree is released
 * when the pager drops the highlighter. */
const abandonedTrees = new FinalizationRegistry((held: { parse: Parse }) => {
  deleteParse(held.parse);
});

/** A single replaced range, from the text on either side of it. */
interface TextEdit {
  readonly start: number;
  readonly oldEnd: number;
  readonly newEnd: number;
}

function textEdit(before: string, after: string): TextEdit {
  const shortest = Math.min(before.length, after.length);
  let start = 0;
  while (start < shortest && before[start] === after[start]) start++;
  let tail = 0;
  while (
    tail < shortest - start &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++;
  }
  return {
    start,
    oldEnd: before.length - tail,
    newEnd: after.length - tail,
  };
}

function treeEdit(
  edit: TextEdit,
  beforeStarts: number[],
  afterStarts: number[],
): InstanceType<TreeSitterModule["Edit"]> {
  return new runtime!.Edit({
    startIndex: edit.start,
    oldEndIndex: edit.oldEnd,
    newEndIndex: edit.newEnd,
    startPosition: point(beforeStarts, edit.start),
    oldEndPosition: point(beforeStarts, edit.oldEnd),
    newEndPosition: point(afterStarts, edit.newEnd),
  });
}

function point(lineStarts: number[], offset: number) {
  const row = lineIndexOf(lineStarts, offset);
  return { row, column: offset - lineStarts[row] };
}

/** Color every line of `text` from a parse of it. */
function colorLines(ready: LoadedGrammar, parse: Parse, text: string): Line[] {
  const lineStarts = parse.plain === text
    ? parse.lineStarts
    : computeLineStarts(text);
  return linesFromClasses(
    text,
    classify(ready, parse, text.length),
    lineStarts,
  );
}

/**
 * The token class of every character in the source, left undefined where the
 * query claims nothing. A narrower capture colors over the one containing it,
 * and the earliest pattern wins between captures of identical extent. A
 * comment the parse read as blank space is a comment.
 */
function classify(
  ready: LoadedGrammar,
  parse: Parse,
  length: number,
): (TokenClass | undefined)[] {
  const classes = new Array<TokenClass | undefined>(length);
  const captures = ready.query.captures(parse.tree.rootNode);
  captures.sort((left, right) =>
    left.node.startIndex - right.node.startIndex ||
    right.node.endIndex - left.node.endIndex ||
    left.patternIndex - right.patternIndex
  );
  let claimedStart = -1;
  let claimedEnd = -1;
  for (const capture of captures) {
    const { startIndex, endIndex } = capture.node;
    if (startIndex === claimedStart && endIndex === claimedEnd) continue;
    claimedStart = startIndex;
    claimedEnd = endIndex;
    // Every capture name was checked against the token classes when the
    // grammar loaded.
    classes.fill(capture.name as TokenClass, startIndex, endIndex);
  }
  for (const { start, end } of parse.comments) {
    classes.fill("comment", start, end);
  }
  return classes;
}

function structureNodes(
  grammar: TreeSitterGrammar,
  node: SyntaxNode,
  source: StructureSource,
  depth: number,
): StructureNode[] {
  if (grammar.structureParents?.has(node.type) === false) return [];
  const out: StructureNode[] = [];
  for (const child of node.children) {
    const entry = grammar.structureEntry(child);
    if (entry === undefined) {
      for (const nested of structureNodes(grammar, child, source, depth)) {
        out.push(nested);
      }
      continue;
    }
    const extent = entry.extent ?? child;
    out.push(structureNode(
      source,
      {
        kind: entry.kind,
        label: entry.label,
        name: entry.name,
        nameOffset: entry.nameOffset,
        startOffset: extent.startIndex,
        endOffset: extent.endIndex,
        astKind: child.type,
      },
      depth,
      (inner) => structureNodes(grammar, child, source, inner),
    ));
  }
  return out;
}
