import { expect } from "@std/expect";

import {
  _internal,
  answersFor,
  IN_PLACE_PARSE_BUDGET,
  parse,
  type ParseJob,
  type ParseOutcome,
  type ParseResult,
  type ParseWorkerAnswer,
  type ParseWorkerMessage,
  parseWorkerReceiver,
  PendingParses,
  recolorBatch,
  workerParser,
} from "../../../lib/view/backgroundparse.ts";
import { parseDiff } from "../../../lib/view/diff.ts";
import {
  buildDiffDocument,
  type DiffWorkspace,
  WorkspaceCache,
} from "../../../lib/view/diffdoc.ts";
import { diffSource } from "../../../lib/view/diffedit.ts";
import {
  type Language,
  languageForName,
} from "../../../lib/view/languages/language.ts";
import { plainTextLanguage } from "../../../lib/view/languages/plain-text/language.ts";
import {
  type Document,
  flattenStructure,
  type Line,
  type StructureNode,
  type ViewMode,
} from "../../../lib/view/model.ts";
import { gitBlobName } from "../../view-helpers.ts";
import { describe, it } from "@commonfabric/test-support/test";

const typescript = languageForName("typescript")!;
const SOURCE = "export const answer: number = 42; // the answer\n";
const EDITED = "export const answer: number = 43; // the answer\n";

/** How many spans of `lines` are colored as syntax: as something other than
 * plain text, whitespace, or a diff's own markers. */
function coloredSpans(lines: readonly Line[]): number {
  return lines.flatMap((line) => line.spans).filter((span) =>
    span.cls !== "plain" && span.cls !== "whitespace" &&
    !span.cls.startsWith("diff")
  ).length;
}

/** A job for `text` in `language` that ignores how it ends. */
function job(
  kind: ParseResult["kind"],
  language: Language,
  text: string,
): ParseJob {
  return {
    kind,
    language,
    text,
    fileName: "answer.ts",
    finish: () => {},
    fail: () => {},
  };
}

/** Every outcome a worker parse of `jobs` delivers, once each job has one,
 * calling `delivered` as each delivery begins. */
function parseAll(
  jobs: readonly ParseJob[],
  startWorker?: () => Worker,
  delivered: () => void = () => {},
): Promise<ParseOutcome[]> {
  const outcomes: ParseOutcome[] = [];
  const { promise, resolve } = Promise.withResolvers<ParseOutcome[]>();
  workerParser(jobs, (batch) => {
    delivered();
    for (const outcome of batch) outcomes.push(outcome);
    if (outcomes.length === jobs.length) resolve(outcomes);
  }, startWorker);
  return promise;
}

/** Starts the parse worker. */
function parseWorker(): Worker {
  return new RecordingWorker();
}

/** The parse worker, recording the kinds of the messages it is sent and when
 * it is ended. */
class RecordingWorker extends Worker {
  readonly sent: string[] = [];
  readonly ended = Promise.withResolvers<void>();
  terminations = 0;

  constructor() {
    super(new URL("../../../lib/view/parseworker.ts", import.meta.url), {
      type: "module",
    });
  }

  override postMessage(message: ParseWorkerMessage): void {
    this.sent.push(message.kind);
    super.postMessage(message);
  }

  override terminate(): void {
    this.terminations++;
    super.terminate();
    this.ended.resolve();
  }
}

describe("backgroundparse", () => {
  describe("parse()", () => {
    it("returns the full document model for a document parse", () => {
      expect(parse("document", typescript, SOURCE, "answer.ts")).toEqual({
        kind: "document",
        document: typescript.parseDocument(SOURCE, "answer.ts"),
      });
    });

    it("returns the colored lines alone for a lines parse", () => {
      expect(parse("lines", typescript, SOURCE, "answer.ts")).toEqual({
        kind: "lines",
        lines: typescript.highlightLines(SOURCE, "answer.ts"),
      });
    });
  });

  describe("PendingParses", () => {
    describe("instance members", () => {
      describe("document()", () => {
        it("parses at once a text that fits the budget", () => {
          const pending = new PendingParses(SOURCE.length);

          const document = pending.document("a", typescript, SOURCE, "a.ts");

          expect(document).toEqual(typescript.parseDocument(SOURCE));
          expect(pending.take()).toEqual([]);
        });

        it("returns null for a text past the budget, and leaves it pending", () => {
          const pending = new PendingParses(SOURCE.length - 1);

          const document = pending.document("a", typescript, SOURCE, "a.ts");

          expect(document).toBeNull();
          const [taken, ...rest] = pending.take();
          expect(rest).toEqual([]);
          expect([taken.kind, taken.language, taken.text, taken.fileName])
            .toEqual(["document", typescript, SOURCE, "a.ts"]);
        });

        it("spends the budget on each parse it runs at once", () => {
          const pending = new PendingParses(SOURCE.length + 1);

          pending.document("a", typescript, SOURCE, "a.ts");
          const second = pending.document("b", typescript, SOURCE, "a.ts");

          expect(second).toBeNull();
          expect(pending.take().length).toBe(1);
        });

        it("returns null for a pending parse until it finishes, and then its result", () => {
          const pending = new PendingParses(0);
          pending.document("a", typescript, SOURCE, "a.ts");
          const [taken] = pending.take();
          const result = parse("document", typescript, SOURCE, "a.ts");

          const before = pending.document("a", typescript, SOURCE, "a.ts");
          taken.finish(result);
          const after = pending.document("a", typescript, SOURCE, "a.ts");

          expect(before).toBeNull();
          expect(after).toBe(result.kind === "document" && result.document);
        });

        it("gives a finished result to every build that asks", () => {
          const pending = new PendingParses(0);
          pending.document("a", typescript, SOURCE, "a.ts");
          const [taken] = pending.take();
          const result = parse("document", typescript, SOURCE, "a.ts");
          taken.finish(result);

          const first = pending.document("a", typescript, SOURCE, "a.ts");
          const second = pending.document("a", typescript, SOURCE, "a.ts");

          expect(first).toBe(result.kind === "document" && result.document);
          expect(second).toBe(first);
        });

        it("forgets a pending parse once its key is asked for with other text", () => {
          const pending = new PendingParses(0);
          pending.document("a", typescript, SOURCE, "a.ts");
          const [taken] = pending.take();
          pending.document("a", typescript, EDITED, "a.ts");
          const result = parse("document", typescript, SOURCE, "a.ts");
          taken.finish(result);

          const document = pending.document("a", typescript, SOURCE, "a.ts");

          expect(document).not.toBe(
            result.kind === "document" && result.document,
          );
          expect(document).toEqual(typescript.parseDocument(SOURCE));
          expect(pending.finished).toBe(1);
        });

        it("parses at once a pending parse's key asked for with other text", () => {
          const pending = new PendingParses(0);
          pending.document("a", typescript, SOURCE, "a.ts");
          pending.take();

          const document = pending.document("a", typescript, EDITED, "a.ts");

          expect(document).toEqual(typescript.parseDocument(EDITED));
        });

        it("gives a finished result only for the text it parsed", () => {
          const pending = new PendingParses(0);
          pending.document("a", typescript, SOURCE, "a.ts");
          const [taken] = pending.take();
          taken.finish(parse("document", typescript, SOURCE, "a.ts"));

          const document = pending.document("a", typescript, EDITED, "a.ts");

          expect(document).toEqual(typescript.parseDocument(EDITED));
        });

        it("parses at once any other text once the parses are taken", () => {
          const pending = new PendingParses(0);
          pending.take();

          const document = pending.document("b", typescript, SOURCE, "a.ts");

          expect(document).toEqual(typescript.parseDocument(SOURCE));
        });
      });

      describe("lines()", () => {
        it("parses at once a text that fits the budget", () => {
          const pending = new PendingParses();

          const lines = pending.lines("a", typescript, SOURCE, "a.ts");

          expect(lines).toEqual(typescript.highlightLines(SOURCE));
        });

        it("returns plain lines once a pending parse fails", () => {
          const pending = new PendingParses(0);
          pending.lines("a", typescript, SOURCE, "a.ts");
          const [taken] = pending.take();

          const before = pending.lines("a", typescript, SOURCE, "a.ts");
          taken.fail();
          const after = pending.lines("a", typescript, SOURCE, "a.ts");

          expect(before).toBeNull();
          expect(after).toEqual(plainTextLanguage.highlightLines(SOURCE));
          expect(coloredSpans(after ?? [])).toBe(0);
          const again = pending.lines("a", typescript, SOURCE, "a.ts");
          expect(coloredSpans(again ?? [])).toBe(0);
        });
      });

      describe("waiting()", () => {
        it("returns `true` for a parse left pending until it finishes", () => {
          const pending = new PendingParses(0);
          pending.document("a", typescript, SOURCE, "a.ts");
          const [taken] = pending.take();

          const before = pending.waiting("a");
          taken.finish(parse("document", typescript, SOURCE, "a.ts"));

          expect(before).toBe(true);
          expect(pending.waiting("a")).toBe(false);
        });

        it("returns `false` once a pending parse fails", () => {
          const pending = new PendingParses(0);
          pending.lines("a", typescript, SOURCE, "a.ts");
          const [taken] = pending.take();

          taken.fail();

          expect(pending.waiting("a")).toBe(false);
        });

        it("returns `false` for a parse run at once, and for one asked for with other text", () => {
          const pending = new PendingParses(SOURCE.length);
          pending.document("a", typescript, SOURCE, "a.ts");
          pending.document("b", typescript, SOURCE, "a.ts");
          pending.take();
          pending.document("b", typescript, EDITED, "a.ts");

          expect(pending.waiting("a")).toBe(false);
          expect(pending.waiting("b")).toBe(false);
        });
      });

      describe("keepOnly()", () => {
        it("forgets a finished result the keys do not name, so that the parse runs at once", () => {
          const pending = new PendingParses(0);
          pending.document("a", typescript, SOURCE, "a.ts");
          pending.document("b", typescript, SOURCE, "a.ts");
          const jobs = pending.take();
          const results = jobs.map((taken) =>
            parse(taken.kind, taken.language, taken.text, taken.fileName)
          );
          for (const [at, taken] of jobs.entries()) taken.finish(results[at]);

          pending.keepOnly(new Set(["b"]));

          const forgotten = pending.document("a", typescript, SOURCE, "a.ts");
          expect(forgotten).not.toBe(
            results[0].kind === "document" && results[0].document,
          );
          expect(forgotten).toEqual(typescript.parseDocument(SOURCE));
          expect(pending.document("b", typescript, SOURCE, "a.ts")).toBe(
            results[1].kind === "document" && results[1].document,
          );
        });

        it("keeps a parse that has not finished, and its result once it does", () => {
          const pending = new PendingParses(0);
          pending.document("a", typescript, SOURCE, "a.ts");
          const [taken] = pending.take();
          const result = parse("document", typescript, SOURCE, "a.ts");

          pending.keepOnly(new Set());
          taken.finish(result);

          expect(pending.document("a", typescript, SOURCE, "a.ts")).toBe(
            result.kind === "document" && result.document,
          );
        });

        it("keeps the plain lines of a failed parse", () => {
          const pending = new PendingParses(0);
          pending.lines("a", typescript, SOURCE, "a.ts");
          const [taken] = pending.take();
          taken.fail();

          pending.keepOnly(new Set());

          const lines = pending.lines("a", typescript, SOURCE, "a.ts");
          expect(lines).toEqual(plainTextLanguage.highlightLines(SOURCE));
          expect(coloredSpans(lines ?? [])).toBe(0);
        });
      });

      describe("take()", () => {
        it("returns jobs that throw when finished with a result of the other kind", () => {
          const pending = new PendingParses(0);
          pending.lines("a", typescript, SOURCE, "a.ts");
          const [taken] = pending.take();

          expect(() =>
            taken.finish(parse("document", typescript, SOURCE, "a.ts"))
          ).toThrow("A lines parse cannot finish with document.");
        });
      });

      describe("finished", () => {
        it("counts the pending parses that have finished or failed", () => {
          const pending = new PendingParses(0);
          pending.lines("a", typescript, SOURCE, "a.ts");
          pending.lines("b", typescript, EDITED, "a.ts");
          const [first, second] = pending.take();

          const counts = [pending.finished];
          first.finish(parse("lines", typescript, SOURCE, "a.ts"));
          counts.push(pending.finished);
          second.fail();
          counts.push(pending.finished);

          expect(counts).toEqual([0, 1, 2]);
        });
      });
    });

    describe("constructor()", () => {
      it("parses up to `IN_PLACE_PARSE_BUDGET` characters at once given no budget", () => {
        const pending = new PendingParses();
        const fits = "x".repeat(IN_PLACE_PARSE_BUDGET);

        const first = pending.lines("a", plainTextLanguage, fits, "a.txt");
        const second = pending.lines("b", plainTextLanguage, "x", "b.txt");

        expect(first).not.toBeNull();
        expect(second).toBeNull();
      });
    });
  });

  describe("answersFor()", () => {
    const parsed: ParseOutcome = {
      kind: "parsed",
      index: 3,
      result: parse("document", typescript, SOURCE, "answer.ts"),
    };
    const document = parsed.kind === "parsed" &&
        parsed.result.kind === "document"
      ? parsed.result.document
      : typescript.parseDocument(SOURCE);
    const items = (line: Line) => Math.max(1, line.spans.length);
    const size = document.lines.reduce((sum, line) => sum + items(line), 0) +
      document.flatStructure.length;

    it("returns the outcome whole when its result fits the budget", () => {
      expect(answersFor(parsed, size)).toEqual([
        { kind: "outcome", outcome: parsed },
      ]);
    });

    it("returns runs of lines, runs of nodes, and then the rest of the result for a larger result", () => {
      const answers = answersFor(parsed, size - 1);
      const small = answersFor(parsed, 4);

      expect(answers.map((answer) => answer.kind).at(-1)).toBe("rest");
      const kinds = small.map((answer) => answer.kind);
      const lines = small.flatMap((answer) =>
        answer.kind === "lines" ? answer.lines : []
      );
      const nodes = small.flatMap((answer) =>
        answer.kind === "nodes" ? answer.nodes : []
      );
      expect(kinds.indexOf("nodes")).toBeGreaterThan(
        kinds.lastIndexOf("lines"),
      );
      expect(kinds.filter((kind) => kind === "outcome")).toEqual([]);
      expect(lines).toEqual(document.lines);
      expect(nodes.length).toBe(document.flatStructure.length);
      expect(nodes.every((node) => node.children.length === 0)).toBe(true);
      for (const answer of small) {
        if (answer.kind === "nodes") {
          expect(answer.nodes.length).toBeLessThanOrEqual(4);
        }
        if (answer.kind === "lines" && answer.lines.length > 1) {
          const held = answer.lines.reduce((sum, l) => sum + items(l), 0);
          expect(held).toBeLessThanOrEqual(4);
        }
      }
      expect(small.at(-1)).toEqual({
        kind: "rest",
        index: 3,
        document: { text: document.text, definitions: document.definitions },
        flat: Int32Array.from(document.flatStructure.keys()),
      });
    });

    it("counts a line without spans as one item", () => {
      const empty: ParseOutcome = {
        kind: "parsed",
        index: 0,
        result: {
          kind: "lines",
          lines: Array.from({ length: 10 }, () => ({ text: "", spans: [] })),
        },
      };

      const runs = answersFor(empty, 4).map((answer) =>
        answer.kind === "lines" ? answer.lines.length : answer.kind
      );

      expect(runs).toEqual([4, 4, 2, "rest"]);
    });

    it("throws for a budget that holds nothing", () => {
      expect(() => answersFor(parsed, 0)).toThrow(
        "An answer budget of 0 holds nothing.",
      );
      expect(() => answersFor(parsed, 1.5)).toThrow(
        "An answer budget of 1.5 holds nothing.",
      );
    });

    it("returns a failure whole", () => {
      const failed: ParseOutcome = { kind: "failed", index: 0, failure: "No." };

      expect(answersFor(failed, 1)).toEqual([
        { kind: "outcome", outcome: failed },
      ]);
    });

    it("throws for a document whose flat structure holds a node its structure does not", () => {
      const stray: StructureNode = {
        ...document.flatStructure[0],
        children: [],
      };
      const odd: ParseOutcome = {
        kind: "parsed",
        index: 0,
        result: {
          kind: "document",
          document: { ...document, flatStructure: [stray] },
        },
      };

      expect(() => answersFor(odd, 4)).toThrow(
        "A flat structure holds a node its structure does not.",
      );
    });

    it("throws for a document whose structure holds a node twice", () => {
      const root = document.structure[0];
      const twice: ParseOutcome = {
        kind: "parsed",
        index: 0,
        result: {
          kind: "document",
          document: {
            ...document,
            structure: [root, root],
            flatStructure: [],
          },
        },
      };

      expect(() => answersFor(twice, 4)).toThrow(
        "A structure holds a node twice.",
      );
    });
  });

  describe("workerParser()", () => {
    it("delivers a result the worker sends in parts as the worker had it", async () => {
      const sent: string[] = [];
      const outcomes = await parseAll(
        [job("document", typescript, SOURCE), job("lines", typescript, EDITED)],
        () => {
          const worker = new Worker(
            new URL("./small-answers-parseworker.ts", import.meta.url),
            { type: "module" },
          );
          worker.addEventListener(
            "message",
            (event: MessageEvent<ParseWorkerAnswer>) =>
              sent.push(event.data.kind),
          );
          return worker;
        },
      );

      expect(new Set(sent)).toEqual(new Set(["lines", "nodes", "rest"]));
      const [first, second] = outcomes.toSorted((a, b) => a.index - b.index);
      expect(first).toEqual({
        kind: "parsed",
        index: 0,
        result: parse("document", typescript, SOURCE, "answer.ts"),
      });
      expect(second).toEqual({
        kind: "parsed",
        index: 1,
        result: parse("lines", typescript, EDITED, "answer.ts"),
      });
      const delivered = first.kind === "parsed" &&
          first.result.kind === "document"
        ? first.result.document
        : typescript.parseDocument("");
      const flattened = flattenStructure(delivered.structure);
      expect(delivered.flatStructure.length).toBe(flattened.length);
      expect(
        delivered.flatStructure.every((node, at) => node === flattened[at]),
      ).toBe(true);
    });

    it("delivers a failure for each job when the worker sends an answer it cannot put together", async () => {
      const malformed = JSON.stringify({
        kind: "nodes",
        index: 0,
        nodes: [],
        parents: [],
      }).replace('"nodes":[]', '"nodes":[{"children":[]}]').replace(
        '"parents":[]',
        '"parents":new Int32Array([5])',
      );

      const outcomes = await parseAll(
        [job("lines", typescript, SOURCE), job("lines", typescript, EDITED)],
        () =>
          new Worker(
            `data:application/javascript,self.onmessage=()=>self.postMessage(${
              encodeURIComponent(malformed)
            })`,
            { type: "module" },
          ),
      );

      expect(outcomes).toEqual([0, 1].map((index) => ({
        kind: "failed",
        index,
        failure: "A parse worker named node 5 before sending it.",
      })));
    });

    it("delivers the result each job would get from a parse here", async () => {
      const outcomes = await parseAll([
        job("document", typescript, SOURCE),
        job("lines", typescript, EDITED),
      ]);

      expect(outcomes.toSorted((a, b) => a.index - b.index)).toEqual([
        {
          kind: "parsed",
          index: 0,
          result: parse("document", typescript, SOURCE, "answer.ts"),
        },
        {
          kind: "parsed",
          index: 1,
          result: parse("lines", typescript, EDITED, "answer.ts"),
        },
      ]);
    });

    it("colors a block in a language whose parser loads during the parse", async () => {
      const org = languageForName("org")!;
      const text = "#+begin_src python\ndef f():\n    return 1\n#+end_src\n";

      const [outcome] = await parseAll([job("lines", org, text)]);

      const lines = outcome.kind === "parsed" && outcome.result.kind === "lines"
        ? outcome.result.lines
        : [];
      expect(
        lines.flatMap((line) => line.spans).find((span) => span.text === "def")
          ?.cls,
      ).toBe("storageKeyword");
    });

    it("delivers a failed worker's failure as the outcome of each job it left", async () => {
      const outcomes = await parseAll(
        [job("lines", typescript, SOURCE), job("lines", typescript, EDITED)],
        () =>
          new Worker(
            "data:application/javascript,throw new Error('The worker broke.')",
            { type: "module" },
          ),
      );

      expect(outcomes.map(({ index }) => index)).toEqual([0, 1]);
      for (const outcome of outcomes) {
        expect(outcome.kind === "failed" && outcome.failure).toContain(
          "The worker broke.",
        );
      }
    });

    it("ends the worker once every job has an outcome", async () => {
      const worker = new RecordingWorker();

      await parseAll([job("lines", typescript, SOURCE)], () => worker);

      await worker.ended.promise;
    });

    it("lets the worker send each answer after the one before has been delivered", async () => {
      const worker = new RecordingWorker();
      const seen: string[][] = [];

      await parseAll(
        [SOURCE, EDITED, SOURCE].map((text) => job("lines", typescript, text)),
        () => worker,
        () => seen.push([...worker.sent]),
      );

      expect(seen).toEqual([
        ["parse"],
        ["parse", "next"],
        ["parse", "next", "next"],
      ]);
      expect(worker.sent).toEqual(["parse", "next", "next"]);
    });

    it("delivers nothing once stopped", () => {
      const delivered: ParseOutcome[] = [];
      const worker = new RecordingWorker();

      const stop = workerParser(
        [job("document", typescript, SOURCE)],
        (outcomes) => {
          for (const outcome of outcomes) delivered.push(outcome);
        },
        () => worker,
      );
      stop();

      expect(worker.terminations).toBe(1);
      expect(delivered).toEqual([]);
    });

    it("delivers nothing when the worker fails after it was stopped", () => {
      const delivered: (readonly ParseOutcome[])[] = [];
      let worker: Worker | undefined;

      const stop = workerParser(
        [job("lines", typescript, SOURCE)],
        (outcomes) => delivered.push(outcomes),
        () => worker = parseWorker(),
      );
      stop();
      worker?.dispatchEvent(new ErrorEvent("error", { message: "Too late." }));

      expect(delivered).toEqual([]);
    });

    it("starts no worker for no jobs", () => {
      let started = 0;

      workerParser([], () => {}, () => {
        started++;
        throw new Error("no worker is started for no jobs");
      });

      expect(started).toBe(0);
    });
  });

  describe("the parse worker", () => {
    it("delivers a request for an unknown language its failure as the outcome", async () => {
      const worker = parseWorker();
      try {
        const answer = Promise.withResolvers<ParseWorkerAnswer>();
        worker.onmessage = (event: MessageEvent<ParseWorkerAnswer>) =>
          answer.resolve(event.data);
        const message: ParseWorkerMessage = {
          kind: "parse",
          requests: [{
            index: 7,
            kind: "lines",
            languageId: "no-such-language",
            text: SOURCE,
            fileName: undefined,
          }],
        };
        worker.postMessage(message);

        expect(await answer.promise).toEqual({
          kind: "outcome",
          outcome: {
            kind: "failed",
            index: 7,
            failure: 'No language is named "no-such-language".',
          },
        });
      } finally {
        worker.terminate();
      }
    });
  });

  describe("parseWorkerReceiver()", () => {
    it("sends one answer for each message received, holding the next until a message lets it", async () => {
      const outcomes = [0, 1, 2].map(() =>
        Promise.withResolvers<ParseOutcome>()
      );
      const sends = [0, 1, 2].map(() => Promise.withResolvers<void>());
      const sent: number[] = [];
      const receive = parseWorkerReceiver(
        (answer) => {
          if (answer.kind !== "outcome") {
            throw new Error("Each of these outcomes is sent whole.");
          }
          sent.push(answer.outcome.index);
          sends[answer.outcome.index].resolve();
        },
        ({ index }) => outcomes[index].promise,
      );
      const finish = (index: number) => {
        outcomes[index].resolve({ kind: "failed", index, failure: "" });
        // The receiver awaited this outcome before the caller does, so it has
        // sent the outcome by the time the caller resumes, unless it is held.
        return outcomes[index].promise;
      };

      receive({
        kind: "parse",
        requests: [0, 1, 2].map((index) => ({
          index,
          kind: "lines",
          languageId: "plain-text",
          text: SOURCE,
          fileName: undefined,
        })),
      });
      await finish(0);
      await sends[0].promise;
      await finish(1);
      const held = [...sent];
      receive({ kind: "next" });
      await sends[1].promise;
      receive({ kind: "next" });
      await finish(2);
      const sentAtOnce = [...sent];

      expect(held).toEqual([0]);
      expect(sentAtOnce).toEqual([0, 1, 2]);
    });

    it("sends a failure for a request whose result it cannot send in parts, and the next request's outcome", async () => {
      const document = typescript.parseDocument(SOURCE);
      const root = document.structure[0];
      const broken: ParseResult = {
        kind: "document",
        document: { ...document, structure: [root, root], flatStructure: [] },
      };
      const sent: ParseWorkerAnswer[] = [];
      const second = Promise.withResolvers<void>();
      const receive = parseWorkerReceiver(
        (answer) => {
          sent.push(answer);
          if (answer.kind === "outcome" && answer.outcome.index === 1) {
            second.resolve();
          }
        },
        ({ index }) =>
          Promise.resolve(
            index === 0
              ? { kind: "parsed", index, result: broken }
              : { kind: "failed", index, failure: "Second." },
          ),
        4,
      );

      receive({
        kind: "parse",
        requests: [0, 1].map((index) => ({
          index,
          kind: "document",
          languageId: "typescript",
          text: SOURCE,
          fileName: undefined,
        })),
      });
      receive({ kind: "next" });
      await second.promise;

      expect(sent).toEqual([
        {
          kind: "outcome",
          outcome: {
            kind: "failed",
            index: 0,
            failure: "A structure holds a node twice.",
          },
        },
        {
          kind: "outcome",
          outcome: { kind: "failed", index: 1, failure: "Second." },
        },
      ]);
    });

    it("throws when given a second `parse` message", () => {
      const receive = parseWorkerReceiver(() => {});
      receive({ kind: "parse", requests: [] });

      expect(() => receive({ kind: "parse", requests: [] })).toThrow(
        "A parse worker takes one `parse` message, before any `next`.",
      );
      expect(() => receive({ kind: "next" })).not.toThrow();
    });

    it("throws when given a `next` message before the `parse` message", () => {
      const receive = parseWorkerReceiver(() => {});

      expect(() => receive({ kind: "next" })).toThrow(
        "A parse worker takes one `parse` message, before any `next`.",
      );
    });
  });

  describe("recolorBatch()", () => {
    it("returns a sixteenth of a long diff's length", () => {
      expect(recolorBatch(16 * 1024 * 1024)).toBe(1024 * 1024);
    });

    it("returns the in-place budget for a short diff", () => {
      expect(recolorBatch(1000)).toBe(IN_PLACE_PARSE_BUDGET);
    });
  });

  describe("outcomeCollector()", () => {
    const node: StructureNode = {
      kind: "node",
      label: "x",
      startLine: 0,
      endLine: 0,
      startCol: 0,
      endCol: 1,
      startOffset: 0,
      endOffset: 1,
      depth: 0,
      children: [],
    };

    it("throws for a node whose parent was not sent", () => {
      const collect = _internal.outcomeCollector();

      expect(() =>
        collect({
          kind: "nodes",
          index: 0,
          nodes: [node],
          parents: Int32Array.of(1),
        })
      ).toThrow("A parse worker named node 1 before sending it.");
    });

    it("throws for a flat structure naming a node that was not sent", () => {
      const collect = _internal.outcomeCollector();

      expect(() =>
        collect({
          kind: "rest",
          index: 0,
          document: typescript.parseDocument(""),
          flat: Int32Array.of(0),
        })
      ).toThrow("A parse worker named node 0 before sending it.");
    });

    it("throws for an outcome sent whole after parts of it", () => {
      const collect = _internal.outcomeCollector();
      const started = collect({ kind: "lines", index: 0, lines: [] });

      expect(started).toBeUndefined();
      expect(() =>
        collect({
          kind: "outcome",
          outcome: { kind: "failed", index: 0, failure: "No." },
        })
      ).toThrow("A parse worker sent an outcome whole after parts of it.");
    });
  });

  describe("a diff built with pending parses", () => {
    // A workspace holding one TypeScript file, whose old version is a Git
    // blob the diff's `index` line names, so both sides parse in full.

    const OLDER = "export const answer = 40; // the answer\n";
    const OLD = "export const answer = 41; // the answer\n";
    const NEW = "export const answer = 42; // the answer\n";
    const DIFF = `diff --git a/answer.ts b/answer.ts
index ${gitBlobName(OLD)}..${gitBlobName(NEW)} 100644
--- a/answer.ts
+++ b/answer.ts
@@ -1 +1 @@
-${OLD}+${NEW}`;
    const model = parseDiff(DIFF)!;

    /**
     * A workspace over `files`, which can change, holding the blobs of `OLD`
     * and `OLDER`.
     */
    function workspace(files: Map<string, string>): DiffWorkspace {
      const blobs = new Map(
        [OLD, OLDER].map((text) => [gitBlobName(text), text]),
      );
      return {
        resolve: (path) => `/workspace/${path}`,
        read: (path) => files.get(path) ?? null,
        readBlobs: (objects) =>
          new Map(
            objects.flatMap((object) => {
              const text = blobs.get(object);
              return text === undefined ? [] : [[object, text]];
            }),
          ),
      };
    }

    /**
     * `language`, counting in `count` each parse it runs of a complete file,
     * `OLDER`, `OLD`, or `NEW`, and not of the fragments of a hunk that the
     * workspace file does not match.
     */
    function counted(
      language: Language,
      count: { documents: number; lines: number },
    ): Language {
      const complete = new Set([OLDER, OLD, NEW]);
      return {
        ...language,
        parseDocument: (text, fileName) => {
          if (complete.has(text)) count.documents++;
          return language.parseDocument(text, fileName);
        },
        highlightLines: (text, fileName) => {
          if (complete.has(text)) count.lines++;
          return language.highlightLines(text, fileName);
        },
      };
    }

    /**
     * Builds, in either view mode, a diff of two Markdown files whose
     * complete-file parses are pending, sharing one cache. Once `finish` has
     * finished every parse, `count` counts the parses each build runs at once.
     */
    function markdownBuilds(): {
      build(viewMode: ViewMode): Document;
      finish(): void;
      readonly count: { documents: number; lines: number };
      readonly cache: WorkspaceCache;
    } {
      const text = ["answer.md", "other.md"].map((name) =>
        DIFF.replaceAll("answer.ts", name)
      ).join("\n");
      const model = parseDiff(text)!;
      const count = { documents: 0, lines: 0 };
      const markdown = counted(languageForName("markdown")!, count);
      const languages = model.files.map(() => ({
        oldLanguage: markdown,
        newLanguage: markdown,
      }));
      const ws = workspace(
        new Map([
          ["/workspace/answer.md", NEW],
          ["/workspace/other.md", NEW],
        ]),
      );
      const cache = new WorkspaceCache();
      const pending = new PendingParses(0);
      const build = (viewMode: ViewMode) =>
        buildDiffDocument(text, model, ws, cache, viewMode, languages, pending)
          .doc;
      build("source");
      const jobs = pending.take();
      return {
        build,
        finish: () => {
          finishAll(jobs);
          count.documents = 0;
          count.lines = 0;
        },
        count,
        cache,
      };
    }

    /** Finishes each of `jobs` with what a parse here gives. */
    function finishAll(jobs: readonly ParseJob[]): void {
      for (const taken of jobs) {
        taken.finish(
          parse(taken.kind, taken.language, taken.text, taken.fileName),
        );
      }
    }

    it("shows the files whose parses are pending as plain text", () => {
      const pending = new PendingParses(0);
      const ws = workspace(new Map([["/workspace/answer.ts", NEW]]));

      const { doc } = buildDiffDocument(
        DIFF,
        model,
        ws,
        new WorkspaceCache(),
        "source",
        undefined,
        pending,
      );

      expect(coloredSpans(doc.lines.slice(5))).toBe(0);
      expect(pending.take().map(({ kind, text }) => [kind, text])).toEqual([
        ["document", NEW],
        ["lines", OLD],
      ]);
    });

    it("builds what a build without pending parses does once the parses finish", () => {
      const ws = workspace(new Map([["/workspace/answer.ts", NEW]]));
      const cache = new WorkspaceCache();
      const pending = new PendingParses(0);
      const first = buildDiffDocument(
        DIFF,
        model,
        ws,
        cache,
        "source",
        undefined,
        pending,
      );
      const pendingOld = first.edit.oldFileLines(0);
      finishAll(pending.take());

      const { doc } = buildDiffDocument(
        DIFF,
        model,
        ws,
        cache,
        "source",
        undefined,
        pending,
      );
      const whole = buildDiffDocument(DIFF, model, ws);

      expect(pendingOld).toBe(null);
      expect(coloredSpans(doc.lines.slice(5))).toBeGreaterThan(0);
      expect(doc).toEqual(whole.doc);
      expect(first.edit.oldFileLines(0)).toEqual(whole.edit.oldFileLines(0));
    });

    it("keeps a section plain until every parse it reads has finished", () => {
      const ws = workspace(new Map([["/workspace/answer.ts", NEW]]));
      const cache = new WorkspaceCache();
      const pending = new PendingParses(0);
      const build = () =>
        buildDiffDocument(DIFF, model, ws, cache, "source", undefined, pending)
          .doc;
      const first = build();
      const [newSide, oldSide] = pending.take();

      newSide.finish(
        parse(newSide.kind, newSide.language, newSide.text, newSide.fileName),
      );
      const halfway = build();
      finishAll([oldSide]);
      const finished = build();

      expect(halfway.lines).toEqual(first.lines);
      expect(coloredSpans(halfway.lines.slice(5))).toBe(0);
      expect(finished).toEqual(buildDiffDocument(DIFF, model, ws).doc);
      expect(coloredSpans(finished.lines.slice(5))).toBeGreaterThan(0);
    });

    it("builds again only the sections whose parses finished", () => {
      const other = DIFF.replaceAll("answer.ts", "other.ts");
      const both = `${DIFF}\n${other}`;
      const bothModel = parseDiff(both)!;
      const ws = workspace(
        new Map([
          ["/workspace/answer.ts", NEW],
          ["/workspace/other.ts", NEW],
        ]),
      );
      const cache = new WorkspaceCache();
      const pending = new PendingParses(0);
      const build = () =>
        buildDiffDocument(
          both,
          bothModel,
          ws,
          cache,
          "source",
          undefined,
          pending,
        ).doc;
      const first = build();
      const jobs = pending.take();
      const answerLine = 5;
      const otherLine = bothModel.files[1].endLine;

      finishAll(jobs.slice(0, 2));
      const second = build();

      expect(second.lines[otherLine]).toBe(first.lines[otherLine]);
      expect(second.lines[answerLine]).not.toBe(first.lines[answerLine]);
      expect(coloredSpans([second.lines[answerLine]])).toBeGreaterThan(0);
      expect(coloredSpans([second.lines[otherLine]])).toBe(0);
    });

    it("reuses a section the other view mode built once its parses finished", () => {
      const count = { documents: 0, lines: 0 };
      const ts = counted(typescript, count);
      // Two files, so that the first file's parse is not among those the
      // cache keeps of the section built last.
      const both = `${DIFF}\n${DIFF.replaceAll("answer.ts", "other.ts")}`;
      const bothModel = parseDiff(both)!;
      const languages = bothModel.files.map(() => ({
        oldLanguage: ts,
        newLanguage: ts,
      }));
      const ws = workspace(
        new Map([
          ["/workspace/answer.ts", NEW],
          ["/workspace/other.ts", NEW],
        ]),
      );
      const cache = new WorkspaceCache();
      const pending = new PendingParses(0);
      const build = (viewMode: "source" | "rendered") =>
        buildDiffDocument(
          both,
          bothModel,
          ws,
          cache,
          viewMode,
          languages,
          pending,
        ).doc;
      build("source");
      finishAll(pending.take());
      build("rendered");

      count.documents = 0;
      const source = build("source");

      expect(count.documents).toBe(0);
      expect(coloredSpans(source.lines.slice(5))).toBeGreaterThan(0);
    });

    it("keeps a parse two sections wait for until both have built from it, and then forgets it", () => {
      // Two sections show the one workspace file, as in `git log -p` output,
      // each with its own old blob. A third section is built after the first,
      // so that the parses the cache keeps of the section built last do not
      // hold the workspace file's parse.
      const older = `diff --git a/answer.ts b/answer.ts
index ${gitBlobName(OLDER)}..${gitBlobName(OLD)} 100644
--- a/answer.ts
+++ b/answer.ts
@@ -1 +1 @@
-${OLDER}+${OLD}`;
      const log = [DIFF, older, DIFF.replaceAll("answer.ts", "other.ts")]
        .join("\n");
      const logModel = parseDiff(log)!;
      const count = { documents: 0, lines: 0 };
      const ts = counted(typescript, count);
      const languages = logModel.files.map(() => ({
        oldLanguage: ts,
        newLanguage: ts,
      }));
      const ws = workspace(
        new Map([
          ["/workspace/answer.ts", NEW],
          ["/workspace/other.ts", NEW],
        ]),
      );
      const cache = new WorkspaceCache();
      const pending = new PendingParses(0);
      const build = () =>
        buildDiffDocument(
          log,
          logModel,
          ws,
          cache,
          "source",
          languages,
          pending,
        )
          .doc;
      build();
      const jobs = pending.take();
      finishAll(jobs.filter((taken) => taken.text !== OLDER));
      build();
      finishAll(jobs.filter((taken) => taken.text === OLDER));

      count.documents = 0;
      const finished = build();
      const finishedParses = count.documents;
      cache.forget("/workspace/answer.ts");
      build();

      expect(finishedParses).toBe(0);
      expect(finished).toEqual(buildDiffDocument(log, logModel, ws).doc);
      expect(coloredSpans(finished.lines.slice(logModel.files[1].headerLine)))
        .toBeGreaterThan(0);
      expect(count.documents).toBe(1);
    });

    it("gives a Markdown file's parse to the builds in both view modes", () => {
      const { build, finish, count } = markdownBuilds();
      build("rendered");
      finish();

      build("source");
      const rendered = build("rendered");

      expect(count).toEqual({ documents: 0, lines: 0 });
      expect(coloredSpans(rendered.lines.slice(5))).toBeGreaterThan(0);
    });

    it("gives a Markdown file's parse to the rendered build after builds in source mode alone", () => {
      // Switching the view back to source builds nothing.

      const { build, finish, count } = markdownBuilds();
      build("rendered");
      finish();

      build("source");
      build("source");
      build("rendered");

      expect(count.documents).toBe(0);
    });

    it("gives a Markdown file's parse to the source build after builds in rendered mode alone", () => {
      // Switching the view to rendered builds in rendered mode alone.

      const { build, finish, count } = markdownBuilds();
      finish();

      build("rendered");
      build("rendered");
      build("source");

      expect(count.documents).toBe(0);
    });

    it("gives a finished parse to a build after the old file's lines were read", () => {
      const both = `${DIFF}\n${DIFF.replaceAll("answer.ts", "other.ts")}`;
      const bothModel = parseDiff(both)!;
      const count = { documents: 0, lines: 0 };
      const ts = counted(typescript, count);
      const languages = bothModel.files.map(() => ({
        oldLanguage: ts,
        newLanguage: ts,
      }));
      const ws = workspace(
        new Map([
          ["/workspace/answer.ts", NEW],
          ["/workspace/other.ts", NEW],
        ]),
      );
      const cache = new WorkspaceCache();
      const pending = new PendingParses(0);
      const build = () =>
        buildDiffDocument(
          both,
          bothModel,
          ws,
          cache,
          "source",
          languages,
          pending,
        );
      const { edit } = build();
      finishAll(pending.take());
      count.lines = 0;

      const read = edit.oldFileLines(0);
      build();

      expect(coloredSpans(read ?? [])).toBeGreaterThan(0);
      expect(count.lines).toBe(0);
    });

    it("forgets a parse once every section has built from it", () => {
      const { build, finish, count, cache } = markdownBuilds();
      build("rendered");
      finish();

      build("source");
      build("rendered");
      cache.forget("/workspace/answer.md");
      build("source");

      expect(count.documents).toBe(1);
    });

    it("records in the cache an editing cache came from the sections it built of other files", () => {
      const both = `${DIFF}\n${DIFF.replaceAll("answer.ts", "other.ts")}`;
      const bothModel = parseDiff(both)!;
      const ws = workspace(
        new Map([
          ["/workspace/answer.ts", NEW],
          ["/workspace/other.ts", NEW],
        ]),
      );
      const cache = new WorkspaceCache();
      const pending = new PendingParses(0);
      const build = (into: WorkspaceCache) =>
        buildDiffDocument(
          both,
          bothModel,
          ws,
          into,
          "source",
          undefined,
          pending,
        )
          .doc;
      build(cache);
      finishAll(pending.take());
      const answerLine = bothModel.files[0].endLine;
      const otherLine = bothModel.files[1].endLine;

      const fromCopy = build(cache.editing(["/workspace/answer.ts"]));
      const fromCache = build(cache);

      expect(fromCache.lines[otherLine]).toBe(fromCopy.lines[otherLine]);
      expect(fromCache.lines[answerLine]).not.toBe(fromCopy.lines[answerLine]);
      expect(fromCache).toEqual(buildDiffDocument(both, bothModel, ws).doc);
    });

    it("builds from a file saved while its parse was pending", () => {
      const files = new Map([["/workspace/answer.ts", NEW]]);
      const ws = workspace(files);
      const cache = new WorkspaceCache();
      const pending = new PendingParses(0);
      buildDiffDocument(DIFF, model, ws, cache, "source", undefined, pending);
      const jobs = pending.take();
      const saved = NEW.replace("42", "4_2");
      files.set("/workspace/answer.ts", saved);
      cache.forget("/workspace/answer.ts");

      finishAll(jobs);
      buildDiffDocument(DIFF, model, ws, cache, "source", undefined, pending);

      expect(cache.file("/workspace/answer.ts")?.fileText).toBe(saved);
    });

    it("re-parses through its editable source with the finished parses", () => {
      const ws = workspace(new Map([["/workspace/answer.ts", NEW]]));
      const cache = new WorkspaceCache();
      const pending = new PendingParses(0);
      const { doc, edit } = buildDiffDocument(
        DIFF,
        model,
        ws,
        cache,
        "source",
        undefined,
        pending,
      );
      const source = diffSource(ws, edit, cache, undefined, pending);
      const jobs = pending.take();

      const before = source.parse(doc.text);
      const counts = source.diffCountContexts?.(doc.text);
      const oldBefore = counts?.[0].oldLines?.();
      finishAll(jobs);
      const after = source.parse(doc.text);

      expect(coloredSpans(before.lines.slice(5))).toBe(0);
      expect(after).toEqual(buildDiffDocument(DIFF, model, ws).doc);
      expect(oldBefore).toBeUndefined();
      expect(coloredSpans(counts?.[0].oldLines?.() ?? [])).toBeGreaterThan(0);
    });
  });
});
