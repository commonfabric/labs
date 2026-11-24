import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  IN_PLACE_PARSE_BUDGET,
  parse,
  type ParseJob,
  type ParseOutcome,
  type ParseResult,
  type ParseWorkerAnswer,
  type ParseWorkerMessage,
  parseWorkerReceiver,
  PendingParses,
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
import type { Line } from "../../../lib/view/model.ts";
import { gitBlobName } from "../../view-helpers.ts";

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

        it("gives a finished result once, and then parses at once", () => {
          const pending = new PendingParses(0);
          pending.document("a", typescript, SOURCE, "a.ts");
          const [taken] = pending.take();
          const result = parse("document", typescript, SOURCE, "a.ts");
          taken.finish(result);

          const first = pending.document("a", typescript, SOURCE, "a.ts");
          const second = pending.document("a", typescript, SOURCE, "a.ts");

          expect(first).toBe(result.kind === "document" && result.document);
          expect(second).not.toBe(first);
          expect(second).toEqual(first);
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

  describe("workerParser()", () => {
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

        expect((await answer.promise).outcome).toEqual({
          kind: "failed",
          index: 7,
          failure: 'No language is named "no-such-language".',
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
        ({ outcome }) => {
          sent.push(outcome.index);
          sends[outcome.index].resolve();
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

  describe("a diff built with pending parses", () => {
    // A workspace holding one TypeScript file, whose old version is a Git
    // blob the diff's `index` line names, so both sides parse in full.

    const OLD = "export const answer = 41; // the answer\n";
    const NEW = "export const answer = 42; // the answer\n";
    const DIFF = `diff --git a/answer.ts b/answer.ts
index ${gitBlobName(OLD)}..${gitBlobName(NEW)} 100644
--- a/answer.ts
+++ b/answer.ts
@@ -1 +1 @@
-${OLD}+${NEW}`;
    const model = parseDiff(DIFF)!;

    /** A workspace over `files`, which can change, holding the old blob. */
    function workspace(files: Map<string, string>): DiffWorkspace {
      return {
        resolve: (path) => `/workspace/${path}`,
        read: (path) => files.get(path) ?? null,
        readBlobs: (objects) =>
          new Map(
            objects.filter((object) => object === gitBlobName(OLD)).map((
              object,
            ) => [object, OLD]),
          ),
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
