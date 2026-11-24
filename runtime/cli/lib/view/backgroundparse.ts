/**
 * Whole-file parses that a diff view finishes after it is first shown. A diff
 * colors its lines from complete files, both the new side and the old, and
 * parsing large ones can take seconds. {@link PendingParses} lets the first
 * build of a diff parse the files that fit a small budget and leave the rest
 * shown as plain text, and {@link workerParser} parses those in a Worker while
 * the pager takes keys. Results are plain data, so they cross to the pager's
 * thread as the worker built them, a large one in parts.
 */

import { describeFailure } from "@commonfabric/js-values/describe-failure";

import {
  finishGrammarLoads,
  type Language,
  languageForName,
} from "./languages/language.ts";
import { plainTextLanguage } from "./languages/plain-text/language.ts";
import type { Document, Line, StructureNode } from "./model.ts";

/** How many characters of source the first build of a diff parses before it
 * shows the files left over as plain text: a fraction of a second of parsing,
 * so that a small diff opens fully colored. */
export const IN_PLACE_PARSE_BUDGET = 128 * 1024;

/**
 * Returns how many characters of source the pager waits for to finish in the
 * background before it builds a diff of `diffLength` characters again. A
 * build makes again only the file sections whose parses finished, and spends
 * on each character of the diff about a fifteenth of what a section's build
 * spends on each character of its complete files. A batch of a sixteenth of
 * the diff keeps the sections' share of a build no larger than the rest, which
 * for a diff of 13 MB is some tens of milliseconds.
 */
export function recolorBatch(diffLength: number): number {
  return Math.max(IN_PLACE_PARSE_BUDGET, diffLength / 16);
}

/** A finished parse: the full document model of a new side, or the colored
 * lines of an old side. */
export type ParseResult =
  | { readonly kind: "document"; readonly document: Document }
  | { readonly kind: "lines"; readonly lines: readonly Line[] };

/** One whole-file parse that a diff build left to finish later. */
export interface ParseJob {
  /** Whether the build wants the full document model or only colored lines. */
  readonly kind: ParseResult["kind"];

  readonly language: Language;
  readonly text: string;

  /** The file's name, which the language may read as {@link
   * Language.parseDocument} says. */
  readonly fileName: string | undefined;

  /**
   * Keeps `result` for the builds that ask for this parse from now on.
   *
   * @throws {Error} When `result` is not of the job's kind.
   */
  finish(result: ParseResult): void;

  /** Keeps the source as plain text for the builds that ask for this parse
   * from now on, as for a parse that failed. */
  fail(): void;
}

/** How one job of a background parse ended, by its position among the jobs. */
export type ParseOutcome =
  | {
    readonly kind: "parsed";
    readonly index: number;
    readonly result: ParseResult;
  }
  | {
    readonly kind: "failed";
    readonly index: number;
    readonly failure: string;
  };

/** A parse request as it is sent to a parse worker: the job's language by its
 * identifier, which the worker looks up in its own registry. */
export interface ParseRequest {
  /** The job's position among the jobs, which its outcome gives back. */
  readonly index: number;

  readonly kind: ParseResult["kind"];
  readonly languageId: string;
  readonly text: string;
  readonly fileName: string | undefined;
}

/**
 * A message to a parse worker. The first, `parse`, gives every request it is
 * to parse, and lets it send one answer. Each `next` lets it send one more,
 * and is sent once the answer before it has been read. A worker parses one
 * request past the answers it may send and then waits, so at most one of its
 * answers waits to be read at a time.
 */
export type ParseWorkerMessage =
  | { readonly kind: "parse"; readonly requests: readonly ParseRequest[] }
  | { readonly kind: "next" };

/**
 * How many items one answer of a parse worker holding lines or structure nodes
 * holds at most, unless one line alone holds more: a structure node is one
 * item, and a colored line is as many as its spans, and at least one. Reading
 * an answer this size takes the pager some tens of milliseconds.
 */
export const ANSWER_BUDGET = 32 * 1024;

/**
 * One of the answers a parse worker sends for a request, each as soon as it
 * has it and may. The outcome of a request whose result holds more than
 * {@link ANSWER_BUDGET} items is sent in parts, so that the pager reads no
 * answer for long: runs of its colored lines, then runs of its structure
 * nodes, and then the rest of the result. Any other outcome is sent whole.
 */
export type ParseWorkerAnswer =
  /** The next colored lines of the result of the request at `index`. */
  | {
    readonly kind: "lines";
    readonly index: number;
    readonly lines: readonly Line[];
  }
  /**
   * The next structure nodes of the document of the request at `index`, in
   * pre-order and each with no children, and the position in that order of
   * the parent of each, or -1 for a root.
   */
  | {
    readonly kind: "nodes";
    readonly index: number;
    readonly nodes: readonly StructureNode[];
    readonly parents: Int32Array;
  }
  /**
   * The rest of the result of the request at `index`, whose lines and nodes
   * were sent before it: for a document, what it holds besides its lines and
   * structure, and the position in pre-order of each node of its flat
   * structure.
   */
  | {
    readonly kind: "rest";
    readonly index: number;
    readonly document?: Omit<Document, "lines" | "structure" | "flatStructure">;
    readonly flat: Int32Array;
  }
  /** The outcome of a request, whole. */
  | { readonly kind: "outcome"; readonly outcome: ParseOutcome };

/** Parses `text` as `language` reads it, into the result `kind` names. */
export function parse(
  kind: ParseResult["kind"],
  language: Language,
  text: string,
  fileName: string | undefined,
): ParseResult {
  return kind === "document"
    ? { kind, document: language.parseDocument(text, fileName) }
    : { kind, lines: language.highlightLines(text, fileName) };
}

/**
 * Returns the function a parse worker gives each message it receives. It
 * gives the requests of the `parse` message to `parseRequest` in order, and
 * gives `send` the answers for the outcome of each, as {@link answersFor}
 * makes them of `budget`, once the messages received so far let it, one
 * answer for each message.
 *
 * @throws {Error} When the function is given a second `parse` message, or a
 * `next` message before the `parse` message.
 */
export function parseWorkerReceiver(
  send: (answer: ParseWorkerAnswer) => void,
  parseRequest: (request: ParseRequest) => Promise<ParseOutcome> = outcome,
  budget: number = ANSWER_BUDGET,
): (message: ParseWorkerMessage) => void {
  let started = false;
  let allowed = 0;
  let allow: (() => void) | undefined;
  const parseAll = async (requests: readonly ParseRequest[]) => {
    for (const request of requests) {
      const outcome = await parseRequest(request);
      let answers: ParseWorkerAnswer[];
      try {
        answers = answersFor(outcome, budget);
      } catch (error) {
        const failure = describeFailure(error);
        answers = [{
          kind: "outcome",
          outcome: { kind: "failed", index: request.index, failure },
        }];
      }
      for (const answer of answers) {
        if (allowed === 0) {
          await new Promise<void>((resolve) => allow = resolve);
        }
        allowed--;
        send(answer);
      }
    }
  };
  return (message) => {
    if (message.kind === "parse" ? started : !started) {
      throw new Error(
        "A parse worker takes one `parse` message, before any `next`.",
      );
    }
    if (message.kind === "parse") {
      started = true;
      parseAll(message.requests);
    }
    allowed++;
    allow?.();
  };
}

/**
 * Returns the answers a parse worker sends for `outcome`: the outcome whole,
 * or, when its result holds more than `budget` items, in parts, as {@link
 * ParseWorkerAnswer} says.
 *
 * @throws {Error} When a document's structure holds a node twice, or its flat
 * structure holds a node its structure does not.
 */
export function answersFor(
  outcome: ParseOutcome,
  budget: number,
): ParseWorkerAnswer[] {
  const whole: ParseWorkerAnswer[] = [{ kind: "outcome", outcome }];
  if (outcome.kind === "failed") return whole;
  const { index, result } = outcome;
  const document = result.kind === "document" ? result.document : undefined;
  const lines = document?.lines ??
    (result.kind === "lines" ? result.lines : []);
  // A line counts at least one item, so that a run of lines is bounded
  // however few spans its lines hold.
  const items = (line: Line) => Math.max(1, line.spans.length);
  let size = 0;
  for (const line of lines) size += items(line);
  const tree = preorder(document?.structure ?? []);
  if (size + tree.nodes.length <= budget) return whole;
  const flat = Int32Array.from(document?.flatStructure ?? [], (node) => {
    const position = tree.positions.get(node);
    if (position === undefined) {
      throw new Error("A flat structure holds a node its structure does not.");
    }
    return position;
  });
  const answers: ParseWorkerAnswer[] = [];
  for (let start = 0, held = 0, at = 0; at <= lines.length; at++) {
    if (
      at === lines.length
        ? at > start
        : held > 0 && held + items(lines[at]) > budget
    ) {
      answers.push({ kind: "lines", index, lines: lines.slice(start, at) });
      start = at;
      held = 0;
    }
    if (at < lines.length) held += items(lines[at]);
  }
  for (let start = 0; start < tree.nodes.length; start += budget) {
    const end = Math.min(start + budget, tree.nodes.length);
    answers.push({
      kind: "nodes",
      index,
      nodes: tree.nodes.slice(start, end).map((node) => ({
        ...node,
        children: [],
      })),
      parents: tree.parents.slice(start, end),
    });
  }
  if (document === undefined) {
    answers.push({ kind: "rest", index, flat });
  } else {
    const { lines: _, structure: __, flatStructure: ___, ...rest } = document;
    answers.push({ kind: "rest", index, document: rest, flat });
  }
  return answers;
}

/**
 * Helper for {@link answersFor}, which returns the nodes of the trees `roots`
 * in pre-order, with the position in that order of each one's parent, or -1
 * for a root, and of each node.
 *
 * @throws {Error} When a node appears in the trees twice.
 */
function preorder(roots: readonly StructureNode[]): {
  readonly nodes: readonly StructureNode[];
  readonly parents: Int32Array;
  readonly positions: ReadonlyMap<StructureNode, number>;
} {
  const nodes: StructureNode[] = [];
  const parents: number[] = [];
  const positions = new Map<StructureNode, number>();
  const pending: [StructureNode, number][] = roots.toReversed().map((root) => [
    root,
    -1,
  ]);
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [node, parent] = next;
    if (positions.has(node)) {
      throw new Error("A structure holds a node twice.");
    }
    positions.set(node, nodes.length);
    for (let at = node.children.length - 1; at >= 0; at--) {
      pending.push([node.children[at], nodes.length]);
    }
    nodes.push(node);
    parents.push(parent);
  }
  return { nodes, parents: Int32Array.from(parents), positions };
}

/**
 * Returns a function that collects the answers a parse worker sends, and
 * returns each outcome once its last answer arrives, with its result as the
 * worker had it.
 *
 * The function throws when an answer names a node or a parent it was not
 * sent, or when an outcome sent whole follows parts of it.
 */
function outcomeCollector(): (
  answer: ParseWorkerAnswer,
) => ParseOutcome | undefined {
  const parts = new Map<number, {
    readonly lines: Line[];
    readonly nodes: StructureNode[];
    readonly roots: StructureNode[];
  }>();
  const partsOf = (index: number) => {
    const known = parts.get(index);
    if (known) return known;
    const started = { lines: [], nodes: [], roots: [] };
    parts.set(index, started);
    return started;
  };
  const sentNode = (nodes: readonly StructureNode[], position: number) => {
    const node = nodes[position];
    if (node === undefined) {
      throw new Error(
        `A parse worker named node ${position} before sending it.`,
      );
    }
    return node;
  };
  return (answer) => {
    if (answer.kind === "lines") {
      const { lines } = partsOf(answer.index);
      for (const line of answer.lines) lines.push(line);
      return undefined;
    }
    if (answer.kind === "nodes") {
      const { nodes, roots } = partsOf(answer.index);
      for (const [at, node] of answer.nodes.entries()) {
        const parent = answer.parents[at];
        (parent < 0 ? roots : sentNode(nodes, parent).children).push(node);
        nodes.push(node);
      }
      return undefined;
    }
    if (answer.kind === "rest") {
      const { index, document, flat } = answer;
      const { lines, nodes, roots } = partsOf(index);
      parts.delete(index);
      return {
        kind: "parsed",
        index,
        result: document === undefined ? { kind: "lines", lines } : {
          kind: "document",
          document: {
            ...document,
            lines,
            structure: roots,
            flatStructure: Array.from(
              flat,
              (position) => sentNode(nodes, position),
            ),
          },
        },
      };
    }
    if (parts.has(answer.outcome.index)) {
      throw new Error(
        "A parse worker sent an outcome whole after parts of it.",
      );
    }
    return answer.outcome;
  };
}

/** Parses `request` in a parse worker, giving the failure as its outcome
 * when it throws. */
async function outcome(request: ParseRequest): Promise<ParseOutcome> {
  const { index, kind, languageId, text, fileName } = request;
  try {
    const language = languageForName(languageId);
    if (language === undefined) {
      throw new Error(`No language is named "${languageId}".`);
    }
    await language.prepare?.();
    // A language embedded in another, such as the language an Org source
    // block names, starts loading its parser when a parse reaches it.
    let result = parse(kind, language, text, fileName);
    while (await finishGrammarLoads()) {
      result = parse(kind, language, text, fileName);
    }
    return { kind: "parsed", index, result };
  } catch (error) {
    return { kind: "failed", index, failure: describeFailure(error) };
  }
}

/**
 * The whole-file parses of one diff view, each named by a key. While its first
 * build runs, a parse that fits what is left of a budget runs at once, and any
 * other is left pending as a {@link ParseJob} that {@link take} hands over.
 * Once taken, a parse still pending leaves its file side plain each time a
 * build asks for it, and a finished one gives its result to the first build
 * that asks, and is then forgotten, so that the view does not keep every
 * complete-file parse. A parse asked for with text other than the text it was
 * left pending with, as after a save, runs at once, as does any parse that was
 * never left pending or whose result was given.
 */
export class PendingParses {
  #budget: number;
  #taken = false;
  #finished = 0;
  #parses = new Map<string, Parse>();

  /** Constructs an instance whose first build parses up to `budget`
   * characters of source at once. */
  constructor(budget: number = IN_PLACE_PARSE_BUDGET) {
    this.#budget = budget;
  }

  /** How many of the parses left pending have finished, which changes each
   * time one does. */
  get finished(): number {
    return this.#finished;
  }

  /** Returns the full document model of `text` read as `language`, or null
   * while its parse, named `key`, is pending. */
  document(
    key: string,
    language: Language,
    text: string,
    fileName: string | undefined,
  ): Document | null {
    const result = this.#parse(key, "document", language, text, fileName);
    return result?.kind === "document" ? result.document : null;
  }

  /** Like {@link document}, except for the colored lines alone. */
  lines(
    key: string,
    language: Language,
    text: string,
    fileName: string | undefined,
  ): readonly Line[] | null {
    const result = this.#parse(key, "lines", language, text, fileName);
    return result?.kind === "lines" ? result.lines : null;
  }

  /**
   * Returns whether the parse named `key` was left pending and has not
   * finished.
   */
  waiting(key: string): boolean {
    const known = this.#parses.get(key);
    return known !== undefined && known.result === undefined;
  }

  /** Hands over the parses the first build left pending, in the order it asked
   * for them, and ends that build. */
  take(): readonly ParseJob[] {
    this.#taken = true;
    return [...this.#parses.values()].map((pending) => ({
      kind: pending.kind,
      language: pending.language,
      text: pending.text,
      fileName: pending.fileName,
      finish: (result) => this.#settle(pending, result, false),
      fail: () =>
        this.#settle(
          pending,
          parse(
            pending.kind,
            plainTextLanguage,
            pending.text,
            pending.fileName,
          ),
          true,
        ),
    }));
  }

  /** Helper for {@link document} and {@link lines}, which returns the result
   * of a parse that has finished or runs at once, or null for one pending. */
  #parse(
    key: string,
    kind: ParseResult["kind"],
    language: Language,
    text: string,
    fileName: string | undefined,
  ): ParseResult | null {
    const known = this.#parses.get(key);
    if (known?.kind === kind && known.text === text) {
      const result = known.result;
      if (result === undefined) return null;
      if (!known.failed) this.#release(key, known);
      return result;
    }
    // A parse asked for with other text, as after a save, is of no further use.
    if (known) this.#release(key, known);
    if (this.#taken || known) return parse(kind, language, text, fileName);
    if (text.length <= this.#budget) {
      this.#budget -= text.length;
      return parse(kind, language, text, fileName);
    }
    this.#parses.set(key, {
      kind,
      language,
      text,
      fileName,
      result: undefined,
      failed: false,
      released: false,
    });
    return null;
  }

  /** Helper for {@link take}'s jobs, which keeps `result` for `pending`,
   * unless it was released, and whether it stands in for a parse that
   * `failed`. */
  #settle(pending: Parse, result: ParseResult, failed: boolean): void {
    if (result.kind !== pending.kind) {
      throw new Error(
        `A ${pending.kind} parse cannot finish with ${result.kind}.`,
      );
    }
    if (!pending.released) {
      pending.result = result;
      pending.failed = failed;
    }
    this.#finished++;
  }

  /** Helper for {@link #parse}, which forgets `pending`, named `key`. The jobs
   * {@link take} handed over still refer to it, so its result is dropped too. */
  #release(key: string, pending: Parse): void {
    this.#parses.delete(key);
    pending.released = true;
    pending.result = undefined;
  }
}

/** A parse left pending, and once it ends, its result. */
interface Parse {
  readonly kind: ParseResult["kind"];
  readonly language: Language;
  readonly text: string;
  readonly fileName: string | undefined;
  result: ParseResult | undefined;

  /** Whether `result` is the plain text a failed parse leaves, which every
   * build that asks is given, so that the parse is not tried again. */
  failed: boolean;

  /** Whether the parse was forgotten, after a build took its result or asked
   * for it with other text, so that no result is kept for it. */
  released: boolean;
}

/** The message that lets a parse worker send its next answer. */
const NEXT: ParseWorkerMessage = { kind: "next" };

/**
 * Starts parsing `jobs` in a Worker of this process that `startWorker`
 * starts, giving each outcome to `deliver` as the worker sends it. The worker
 * sends each answer only once `deliver` has returned from the one before, so
 * at most one answer waits to be read at a time, and other events, such as
 * keys, run between answers.
 * A worker that fails, or sends an answer that cannot be read, gives the
 * failure as the outcome of each job it leaves without one. The worker ends
 * once every job has an outcome, or when the returned function is called,
 * after which nothing more is delivered.
 */
export function workerParser(
  jobs: readonly ParseJob[],
  deliver: (outcomes: readonly ParseOutcome[]) => void,
  startWorker: () => Worker = () =>
    new Worker(new URL("./parseworker.ts", import.meta.url), {
      type: "module",
    }),
): () => void {
  if (jobs.length === 0) return () => {};
  const unanswered = new Set(jobs.keys());
  const worker = startWorker();
  const settle = (outcomes: readonly ParseOutcome[]) => {
    for (const { index } of outcomes) unanswered.delete(index);
    if (unanswered.size === 0) worker.terminate();
    deliver(outcomes);
  };
  const fail = (failure: string) =>
    unanswered.size > 0 && settle(
      [...unanswered].map((index) => ({ kind: "failed", index, failure })),
    );
  const collect = outcomeCollector();
  const take = (answer: ParseWorkerAnswer) => {
    let outcome: ParseOutcome | undefined;
    try {
      outcome = collect(answer);
    } catch (error) {
      fail(describeFailure(error));
      return;
    }
    if (outcome) settle([outcome]);
    if (unanswered.size > 0) worker.postMessage(NEXT);
  };
  worker.onmessage = (event: MessageEvent<ParseWorkerAnswer>) => {
    if (unanswered.size > 0) take(event.data);
  };
  worker.onerror = (event) => {
    event.preventDefault();
    fail(event.message);
  };
  worker.onmessageerror = () =>
    fail("The parse worker sent an answer that could not be read.");
  const message: ParseWorkerMessage = {
    kind: "parse",
    requests: jobs.map(({ kind, language, text, fileName }, index) => ({
      index,
      kind,
      languageId: language.id,
      text,
      fileName,
    })),
  };
  worker.postMessage(message);
  return () => {
    worker.terminate();
    unanswered.clear();
  };
}

/** The internals of this module that its tests reach. */
export const _internal = { outcomeCollector };
