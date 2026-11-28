import { expect } from "@std/expect";
import { ConsoleRunView } from "../../../console/src/run-view.ts";
import { bindingOn, handlerOn, templateText } from "./lit-template.ts";
import { afterEach, describe, it } from "@commonfabric/test-support/test";

const realFetch = globalThis.fetch;

/**
 * A fetch whose answers the test releases by hand, in whatever order it likes.
 * Nothing here waits on a span of time: each read is resolved explicitly, and
 * the promise the view returned is what the test awaits.
 */
const heldFetch = (): readonly PromiseWithResolvers<Response>[] => {
  const held: PromiseWithResolvers<Response>[] = [];
  globalThis.fetch = () => {
    const pending = Promise.withResolvers<Response>();
    held.push(pending);
    return pending.promise;
  };
  return held;
};

/**
 * A fetch answering each path from `routes`, and a 404 for any other. It
 * returns the paths asked for, in order.
 */
const servedFetch = (
  routes: Record<string, () => Response>,
): readonly string[] => {
  const asked: string[] = [];
  globalThis.fetch = (input: string | URL | Request) => {
    const path = String(input);
    asked.push(path);
    return Promise.resolve(
      routes[path]?.() ?? new Response("not found", { status: 404 }),
    );
  };
  return asked;
};

const detailOf = (runId: string): Response =>
  Response.json({
    summary: { runId },
    steps: [],
    handles: [],
    artifactNames: [],
    toolOutputNames: [],
  });

/** A run as the server reports it, with nothing in its lens. */
const runDetail = (over: Record<string, unknown> = {}) => ({
  summary: { runId: "run-1" },
  steps: [],
  handles: [],
  artifactNames: [],
  toolOutputNames: [],
  lens: { patternAttempts: [], searches: [], feedback: [], pieces: [] },
  ...over,
});

/** Exposes what Lit calls on the component, without connecting it. */
class TestRunView extends ConsoleRunView {
  /** The read the component started last. */
  refreshed: Promise<void> = Promise.resolve();

  view(): unknown {
    return this.render();
  }

  /**
   * A connected view schedules updates, and committing one needs a DOM to
   * write into. These tests render by calling `view()` themselves.
   */
  protected override performUpdate(): void {}

  /** Runs the update Lit makes after `runId` changed from `previous`. */
  runChanged(previous: string | undefined): void {
    this.willUpdate(new Map([["runId", previous]]));
  }

  override refresh(): Promise<void> {
    this.refreshed = super.refresh();
    return this.refreshed;
  }
}

/** A view showing `detail`, read the way the page reads it. */
const openRun = async (
  detail: ReturnType<typeof runDetail>,
  files: Record<string, () => Response> = {},
): Promise<{ view: TestRunView; asked: readonly string[] }> => {
  const asked = servedFetch({
    [`/api/runs/${detail.summary.runId}`]: () => Response.json(detail),
    ...files,
  });
  const view = new TestRunView();
  view.runId = detail.summary.runId;
  await view.refresh();
  return { view, asked };
};

/** Clicks the tab or file button labelled `label`, and awaits what it does. */
const click = async (view: TestRunView, label: string): Promise<void> => {
  await handlerOn(view.view(), "@click", label)();
};

describe("console/src/run-view", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  describe("refresh", () => {
    it("keeps the run that was asked for last when an earlier read answers after it", async () => {
      const held = heldFetch();
      const view = new ConsoleRunView();
      view.runId = "run-first";
      const first = view.refresh();
      view.runId = "run-second";
      const second = view.refresh();

      held[1].resolve(detailOf("run-second"));
      await second;
      held[0].resolve(detailOf("run-first"));
      await first;

      expect(view.detail?.summary.runId).toBe("run-second");
    });

    it("leaves the newest run showing when an earlier read fails after it", async () => {
      const held = heldFetch();
      const view = new ConsoleRunView();
      view.runId = "run-first";
      const first = view.refresh();
      view.runId = "run-second";
      const second = view.refresh();

      held[1].resolve(detailOf("run-second"));
      await second;
      held[0].resolve(new Response("not found", { status: 404 }));
      await first;

      expect(view.error).toBeUndefined();
      expect(view.detail?.summary.runId).toBe("run-second");
    });

    it("clears the detail rather than adopting a read of the run that was closed", async () => {
      const held = heldFetch();
      const view = new ConsoleRunView();
      view.runId = "run-first";
      const first = view.refresh();
      view.runId = undefined;
      await view.refresh();

      held[0].resolve(detailOf("run-first"));
      await first;

      expect(view.detail).toBeUndefined();
    });

    it("sets the failure of the newest read as the error", async () => {
      servedFetch({
        "/api/runs/run-1": () =>
          Response.json({ error: "no run run-1" }, { status: 404 }),
      });
      const view = new TestRunView();
      view.runId = "run-1";
      await view.refresh();

      expect(view.error).toBe("no run run-1");
      expect(templateText(view.view())).toContain(
        '<p class="empty bad">no run run-1</p>',
      );
    });

    it("clears an earlier error once a read succeeds", async () => {
      let status = 500;
      servedFetch({
        "/api/runs/run-1": () =>
          status === 500
            ? new Response("boom", { status })
            : Response.json(runDetail()),
      });
      const view = new TestRunView();
      view.runId = "run-1";
      await view.refresh();
      expect(view.error).toBe("boom");

      status = 200;
      await view.refresh();
      expect(view.error).toBeUndefined();
      expect(view.detail?.summary.runId).toBe("run-1");
    });
  });

  describe("willUpdate()", () => {
    it("returns to the timeline and re-reads when the open run changes", async () => {
      const { view, asked } = await openRun(
        runDetail({
          artifactNames: ["report.json"],
        }),
        {
          "/api/runs/run-1/artifacts/report.json": () => new Response("text"),
          "/api/runs/run-2": () =>
            Response.json(runDetail({ summary: { runId: "run-2" } })),
        },
      );
      await click(view, "Artifacts (1)");
      await click(view, "report.json");
      expect(view.rawName).toBe("report.json");

      view.runId = "run-2";
      view.runChanged("run-1");
      await view.refreshed;

      expect(view.pane).toBe("timeline");
      expect(view.rawName).toBeUndefined();
      expect(view.rawText).toBeUndefined();
      expect(asked.at(-1)).toBe("/api/runs/run-2");
      expect(view.detail?.summary.runId).toBe("run-2");
    });

    it("reads nothing when the run id is set to the run already open", async () => {
      const { view, asked } = await openRun(runDetail());
      await click(view, "Patterns");
      const reads = asked.length;

      view.runChanged("run-1");

      expect(asked).toHaveLength(reads);
      expect(view.pane).toBe("patterns");
    });
  });

  describe("render()", () => {
    it("renders into the element itself, where the page's stylesheet reaches", () => {
      const view = new TestRunView();

      view.connectedCallback();
      view.disconnectedCallback();

      expect(view.renderRoot).toBe(view);
    });

    it("renders a prompt to choose a run when none is open", () => {
      expect(templateText(new TestRunView().view())).toContain(
        "Choose a run to read what it did, step by step.",
      );
    });

    it("renders a reading notice while the open run's first read is in flight", () => {
      const view = new TestRunView();
      view.runId = "run-1";

      expect(templateText(view.view())).toContain(
        '<p class="empty">Reading…</p>',
      );
    });

    it("renders the run's title, model, ending, and failure in its head", async () => {
      const { view } = await openRun(runDetail({
        summary: {
          runId: "run-1",
          title: "Reads donut orders",
          model: "gpt-donut",
          terminalReason: "max-turns",
          failure: { kind: "model", detail: "quota spent" },
        },
      }));

      const text = templateText(view.view()).replace(/\s+/g, " ");
      expect(text).toContain(
        '<div class="run-title"> Reads donut orders </div>',
      );
      expect(text).toContain("run-1 · gpt-donut · max-turns");
      expect(text).toContain("model: quota spent");
    });

    it("renders the run id as the title of a run with no title, model, ending, or failure", async () => {
      const { view } = await openRun(runDetail());

      const text = templateText(view.view()).replace(/\s+/g, " ");
      expect(text).toContain('<div class="run-title"> run-1 </div>');
      expect(text).not.toContain("·");
      expect(text).not.toContain("bad-body");
    });

    it("renders the timeline by default, scrubbed to the step the map focused", async () => {
      const steps = [{ index: 0 }, { index: 1 }];
      const { view } = await openRun(runDetail({ steps }));

      expect(bindingOn(view.view(), ".selected", "")).toBe(0);
      view.focusStep = 1;
      expect(bindingOn(view.view(), ".selected", "")).toBe(1);
      expect(bindingOn(view.view(), ".steps", "")).toEqual(steps);
      expect(templateText(view.view())).toContain("Timeline (2)");
    });

    it("renders the pane a tab names, marked as the one showing", async () => {
      const { view } = await openRun(runDetail());

      await click(view, "Patterns");

      const text = templateText(view.view());
      expect(view.pane).toBe("patterns");
      expect(text).toMatch(/class="tab on"[^<]*Patterns/);
      expect(text).not.toMatch(/class="tab on"[^<]*Timeline/);
      expect(text).not.toContain("<console-steps");
    });
  });

  describe("patterns pane", () => {
    it("renders a note for a run that did no pattern work", async () => {
      const { view } = await openRun(runDetail());
      await click(view, "Patterns");

      expect(templateText(view.view())).toContain(
        "This run did no pattern work.",
      );
    });

    it("renders each search with its hits, and a search that matched nothing", async () => {
      const { view } = await openRun(runDetail({
        lens: {
          patternAttempts: [],
          feedback: [],
          pieces: [],
          searches: [{
            toolCallId: "c1",
            query: "donut",
            hits: [
              { patternId: "pat-1", description: "Orders donuts", score: 0.5 },
              { patternId: "pat-2" },
              {},
            ],
          }, { toolCallId: "c2", hits: [] }],
        },
      }));
      await click(view, "Patterns");

      const text = templateText(view.view()).replace(/\s+/g, " ");
      expect(text).toContain('searched <span class="tool">donut</span>');
      expect(text).toContain("Orders donuts");
      expect(text).toContain('<span class="score"> 0.50 </span>');
      expect(text).toContain("<li> pat-2 </li>");
      expect(text).toContain("<li> unnamed </li>");
      expect(text).toContain('searched <span class="tool"></span>');
      expect(text).toContain("no matches");
    });

    it("renders each attempt with its outcome, pattern, inputs, diagnostic, and source", async () => {
      const { view } = await openRun(runDetail({
        lens: {
          searches: [],
          feedback: [],
          pieces: [],
          patternAttempts: [{
            toolCallId: "c1",
            source: "export default pattern()",
            inputNames: [],
            status: "compile-error",
            message: "Expected ';'",
          }, {
            toolCallId: "c2",
            patternId: "pat-1",
            inputNames: ["orders", "budget"],
            status: "ok",
          }],
        },
      }));
      await click(view, "Patterns");

      const text = templateText(view.view()).replace(/\s+/g, " ");
      expect(text).toContain(
        "attempt 1 <span class=bad> compile-error </span>",
      );
      expect(text).toContain("Expected ';'");
      expect(text).toContain(
        '<pre class="raw">export default pattern()</pre>',
      );
      expect(text).toContain(
        'attempt 2 <span class=ok> ok </span> <span class="tool">pat-1</span>',
      );
      expect(text).toContain("inputs: orders, budget");
      expect(text.match(/inputs:/g)).toHaveLength(1);
    });

    it("renders each named piece with its address, and each feedback with its note", async () => {
      const { view } = await openRun(runDetail({
        lens: {
          searches: [],
          patternAttempts: [],
          pieces: [
            { toolCallId: "c1", slug: "orders", url: "http://fabric/orders" },
            { toolCallId: "c2" },
          ],
          feedback: [
            {
              toolCallId: "c3",
              patternId: "pat-1",
              verdict: "up",
              note: "worked first time",
            },
            { toolCallId: "c4" },
          ],
        },
      }));
      await click(view, "Patterns");

      const text = templateText(view.view()).replace(/\s+/g, " ");
      expect(text).toContain('named <span class="tool">orders</span>');
      expect(text.match(/<a href=/g)).toHaveLength(1);
      expect(text).toContain("http://fabric/orders");
      expect(text).toContain('feedback <span class="tool">up</span> pat-1');
      expect(text).toContain('<div class="body">worked first time</div>');
      expect(text.match(/<div class="body">/g)).toHaveLength(1);
    });
  });

  describe("file panes", () => {
    const withFiles = (files: Record<string, () => Response> = {}) =>
      openRun(
        runDetail({
          toolOutputNames: ["out-1", "out-2"],
          artifactNames: ["report.json"],
        }),
        files,
      );

    it("renders a note for a run that wrote no file of the kind", async () => {
      const { view } = await openRun(runDetail());
      await click(view, "Artifacts (0)");

      expect(templateText(view.view())).toContain("This run wrote none.");
    });

    it("reads a file into the raw pane, formatted when it is JSON", async () => {
      const { view, asked } = await withFiles({
        "/api/runs/run-1/tool-outputs/out-1": () => new Response('{"a":1}'),
      });
      await click(view, "Tool outputs (2)");
      await click(view, "out-1");

      const text = templateText(view.view());
      expect(asked.at(-1)).toBe("/api/runs/run-1/tool-outputs/out-1");
      expect(text).toContain('<pre class="raw">{\n  "a": 1\n}</pre>');
      expect(text).toMatch(/class="file open"[^<]*out-1/);
      expect(text).not.toMatch(/class="file open"[^<]*out-2/);
    });

    it("shows a file that is not JSON as it stands", async () => {
      const { view } = await withFiles({
        "/api/runs/run-1/artifacts/report.json": () => new Response("{not"),
      });
      await click(view, "Artifacts (1)");
      await click(view, "report.json");

      expect(view.rawText).toBe("{not");
    });

    it("shows why a file could not be read", async () => {
      const { view } = await withFiles();
      await click(view, "Tool outputs (2)");
      await click(view, "out-2");

      expect(templateText(view.view())).toContain(
        '<pre class="raw">out-2 is not readable</pre>',
      );
    });

    it("renders a reading notice while the file is in flight", async () => {
      const { view } = await withFiles();
      await click(view, "Tool outputs (2)");
      const held = heldFetch();
      const reading = handlerOn(view.view(), "@click", "out-1")();

      expect(templateText(view.view())).toContain(
        '<pre class="raw">reading…</pre>',
      );
      held[0].resolve(new Response("done"));
      await reading;
      expect(view.rawText).toBe("done");
    });

    it("drops a file that arrives after the reader switched panes", async () => {
      const { view } = await withFiles();
      await click(view, "Tool outputs (2)");
      const held = heldFetch();
      const reading = handlerOn(view.view(), "@click", "out-1")();
      await click(view, "Artifacts (1)");

      held[0].resolve(new Response("late"));
      await reading;

      expect(view.rawName).toBeUndefined();
      expect(view.rawText).toBeUndefined();
    });

    it("drops a failure that arrives after the reader opened another file", async () => {
      const { view } = await withFiles();
      await click(view, "Tool outputs (2)");
      const held = heldFetch();
      const first = handlerOn(view.view(), "@click", "out-1")();
      const second = handlerOn(view.view(), "@click", "out-2")();

      held[1].resolve(new Response("second"));
      await second;
      held[0].resolve(new Response("gone", { status: 404 }));
      await first;

      expect(view.rawName).toBe("out-2");
      expect(view.rawText).toBe("second");
    });
  });
});
