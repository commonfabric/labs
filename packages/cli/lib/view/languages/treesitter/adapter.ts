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

import type {
  Definition,
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
import { structureNode, type StructureSource } from "../structure.ts";
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
   * The walk descends into every node either way. */
  structureEntry(node: SyntaxNode): StructureEntry | undefined;

  /** Stretches of source whose line breaks the language ignores and the
   * grammar reads as the end of a statement. The parser reads each line break
   * inside a match as a space, which leaves every offset unchanged, so a match
   * must not hold the line break that ends a line comment. The expression must
   * be global. */
  readonly insignificantLineBreaks?: RegExp;
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
    : failed.error instanceof Error
    ? failed.error.message
    : String(failed.error);
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

function parseWith(ready: LoadedGrammar, text: string, from?: Tree): Tree {
  const tree = ready.parser.parse(text, from);
  // deno-coverage-ignore-start -- a parse returns no tree only when it is
  // cancelled or given a deadline, and this one is given neither
  if (tree === null) throw new Error("cf view: Tree-sitter returned no tree.");
  // deno-coverage-ignore-stop
  return tree;
}

/**
 * Color `text` through its grammar, one display line per source line, or as
 * plain text while the grammar loads.
 */
export function highlightLines(
  grammar: TreeSitterGrammar,
  text: string,
): Line[] {
  const ready = loadedGrammar(grammar);
  if (ready === undefined) return plainTextLines(text);
  const tree = parseWith(ready, parserText(grammar, text));
  try {
    const lineStarts = computeLineStarts(text);
    return colorLines(ready, tree, text, lineStarts);
  } finally {
    tree.delete();
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
  const tree = parseWith(ready, parserText(grammar, text));
  try {
    const lineStarts = computeLineStarts(text);
    const definitions = new Map<string, Definition[]>();
    const structure = structureNodes(
      grammar,
      tree.rootNode,
      { text, lineStarts, definitions },
      0,
    );
    return {
      text,
      lines: colorLines(ready, tree, text, lineStarts),
      structure,
      flatStructure: flattenStructure(structure),
      definitions,
    };
  } finally {
    tree.delete();
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
  let source = parserText(grammar, text);
  let sourceStarts = computeLineStarts(source);
  const held = { tree: parseWith(ready, source) };
  let lines = colorLines(ready, held.tree, text, computeLineStarts(text));
  const highlighter: Highlighter = {
    get lines() {
      return lines;
    },
    update(next: string): readonly Line[] {
      if (next === text) return lines;
      const nextSource = parserText(grammar, next);
      const nextStarts = computeLineStarts(nextSource);
      const previous = held.tree;
      previous.edit(
        treeEdit(textEdit(source, nextSource), sourceStarts, nextStarts),
      );
      held.tree = parseWith(ready, nextSource, previous);
      previous.delete();
      text = next;
      source = nextSource;
      sourceStarts = nextStarts;
      const lineStarts = source === text ? nextStarts : computeLineStarts(text);
      lines = colorLines(ready, held.tree, text, lineStarts);
      return lines;
    },
  };
  abandonedTrees.register(highlighter, held);
  return highlighter;
}

/** A parse tree lives in the parser's own memory, which collecting the object
 * that wraps it does not release, so a highlighter's current tree is released
 * when the pager drops the highlighter. */
const abandonedTrees = new FinalizationRegistry((held: { tree: Tree }) => {
  held.tree.delete();
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
function colorLines(
  ready: LoadedGrammar,
  tree: Tree,
  text: string,
  lineStarts: number[],
): Line[] {
  return linesFromClasses(text, classify(ready, tree, text.length), lineStarts);
}

/**
 * The token class of every character in the source, left undefined where the
 * query claims nothing. A narrower capture colors over the one containing it,
 * and the earliest pattern wins between captures of identical extent.
 */
function classify(
  ready: LoadedGrammar,
  tree: Tree,
  length: number,
): (TokenClass | undefined)[] {
  const classes = new Array<TokenClass | undefined>(length);
  const captures = ready.query.captures(tree.rootNode);
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
  return classes;
}

function structureNodes(
  grammar: TreeSitterGrammar,
  node: SyntaxNode,
  source: StructureSource,
  depth: number,
): StructureNode[] {
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
