/**
 * Whole-file parses that a diff view finishes after it is first shown. A diff
 * colors its lines from complete files, both the new side and the old, and
 * parsing large ones can take seconds. {@link PendingParses} lets the first
 * build of a diff parse the files that fit a small budget and leave the rest
 * shown as plain text, and {@link workerParser} parses those in a Worker while
 * the pager takes keys. Results are plain data, so they cross to the pager's
 * thread as the worker built them.
 */

import { describeFailure } from "@commonfabric/js-values/describe-failure";

import {
  finishGrammarLoads,
  type Language,
  languageForName,
} from "./languages/language.ts";
import { plainTextLanguage } from "./languages/plain-text/language.ts";
import type { Document, Line } from "./model.ts";

/** How many characters of source the first build of a diff parses before it
 * shows the files left over as plain text: a fraction of a second of parsing,
 * so that a small diff opens fully colored. The pager waits for at least as
 * much source to finish in the background before it builds the diff again. */
export const IN_PLACE_PARSE_BUDGET = 128 * 1024;

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

/** The outcome of one request, which a parse worker sends as soon as it has
 * it and may. */
export interface ParseWorkerAnswer {
  readonly outcome: ParseOutcome;
}

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
 * gives `send` the outcome of each once the messages received so far let it,
 * one answer for each message.
 *
 * @throws {Error} When the function is given a second `parse` message, or a
 * `next` message before the `parse` message.
 */
export function parseWorkerReceiver(
  send: (answer: ParseWorkerAnswer) => void,
  parseRequest: (request: ParseRequest) => Promise<ParseOutcome> = outcome,
): (message: ParseWorkerMessage) => void {
  let started = false;
  let allowed = 0;
  let allow: (() => void) | undefined;
  const parseAll = async (requests: readonly ParseRequest[]) => {
    for (const request of requests) {
      const answer: ParseWorkerAnswer = {
        outcome: await parseRequest(request),
      };
      if (allowed === 0) {
        await new Promise<void>((resolve) => allow = resolve);
      }
      allowed--;
      send(answer);
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
  worker.onmessage = (event: MessageEvent<ParseWorkerAnswer>) => {
    if (unanswered.size > 0) settle([event.data.outcome]);
    if (unanswered.size > 0) worker.postMessage(NEXT);
  };
  const fail = (failure: string) =>
    unanswered.size > 0 && settle(
      [...unanswered].map((index) => ({ kind: "failed", index, failure })),
    );
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
