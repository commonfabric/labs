import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { LogCounts, LoggerBreakdown } from "@commonfabric/logger";
import type {
  CDFPoint,
  LoggerMetadata,
  RuntimeTelemetryMarkerResult,
  SchedulerDiagnosisResult,
  TimingStats,
} from "@commonfabric/runtime-client";

import type { DebuggerController } from "../src/lib/debugger-controller.ts";
import type {
  LoggerCounts,
  LoggerTiming,
} from "../src/lib/debugger-view-model.ts";
import { XDebuggerView } from "../src/views/DebuggerView.ts";
import { installGlobals } from "./browser-globals.ts";
import { templateListenerOn, templateMarkup } from "./lit-template-markup.ts";

/**
 * Captures every call to `console[method]` until `restore()` puts the
 * original back.
 */
function captureConsole(
  method: "error" | "log",
): { calls: unknown[][]; restore(): void } {
  const calls: unknown[][] = [];
  const original = console[method];
  console[method] = (...args: unknown[]) => calls.push(args);
  return { calls, restore: () => (console[method] = original) };
}

/**
 * Constructs a view whose runtime reports the given `aborted` state and whose
 * logger operations all run `rejecting`.
 */
function debuggerView(
  aborted: boolean,
  rejecting: () => Promise<void>,
): XDebuggerView {
  const rt = {
    signal: { aborted },
    resetLoggerBaselines: rejecting,
    setLoggerEnabled: rejecting,
    setLoggerLevel: rejecting,
    getLoggerCounts: rejecting,
  };
  const view = new XDebuggerView();
  // The controller stand-in offers only the runtime lookup, which is all
  // the three handlers read from it. Naming `worker` in the metadata is
  // what sends the toggle and level handlers down the worker path.
  view.debuggerController = {
    getRuntime: () => ({ runtime: () => rt }),
  } as unknown as DebuggerController;
  view.accessForTestingOnly.workerLoggerMetadata = {
    worker: { enabled: false, level: "info" },
  };
  return view;
}

/** Rejects the way a runtime operation does once its runtime is disposed. */
const reject = () => Promise.reject(new DOMException("aborted", "AbortError"));

/**
 * The handlers that log a failed runtime operation, each paired with the call
 * that drives it through the view's `accessForTestingOnly`.
 */
const handlers: Array<[string, (view: XDebuggerView) => Promise<void>]> = [
  ["resetBaseline", (view) => view.accessForTestingOnly.resetBaseline()],
  [
    "toggleLogger",
    (view) => view.accessForTestingOnly.toggleLogger("worker"),
  ],
  [
    "setLoggerLevel",
    (view) => view.accessForTestingOnly.setLoggerLevel("worker", "info"),
  ],
];

/** What the worker reports from `getLoggerCounts()`. */
type WorkerLoggers = {
  counts: LoggerCounts;
  metadata: LoggerMetadata;
  timing?: LoggerTiming;
  flags?: Record<string, never>;
};

/**
 * A worker runtime that reports `worker` from `getLoggerCounts()` and records
 * every logger operation in `calls`.
 */
function workerRuntime(worker: WorkerLoggers) {
  const calls: unknown[][] = [];
  const rt = {
    signal: { aborted: false },
    getLoggerCounts: () => {
      calls.push(["getLoggerCounts"]);
      return Promise.resolve({ timing: {}, ...worker });
    },
    setLoggerEnabled: (enabled: boolean, name: string) => {
      calls.push(["setLoggerEnabled", enabled, name]);
      return Promise.resolve();
    },
    setLoggerLevel: (level: string, name: string) => {
      calls.push(["setLoggerLevel", level, name]);
      return Promise.resolve();
    },
    resetLoggerBaselines: () => {
      calls.push(["resetLoggerBaselines"]);
      return Promise.resolve();
    },
  };
  return { rt, calls };
}

/** The controller reads a view makes, with the values a test gives them. */
type ControllerState = {
  runtime?: ReturnType<typeof workerRuntime>["rt"];
  telemetryEnabled?: boolean;
  isDiagnosing?: boolean;
  diagnosisResult?: SchedulerDiagnosisResult | null;
};

/**
 * A view, visible, whose controller stand-in answers from `state` and records
 * each command it is given in `calls`, by method name.
 */
function visibleView(state: ControllerState = {}) {
  const calls: Record<string, unknown[][]> = {};
  const record = (name: string) => (...args: unknown[]) => {
    (calls[name] ??= []).push(args);
  };
  const view = new XDebuggerView();
  view.visible = true;
  // The stand-in offers the reads and commands the panel's tabs make.
  view.debuggerController = {
    getRuntime: () => state.runtime && { runtime: () => state.runtime },
    getPatternSourcesVersion: () => 3,
    isTelemetryEnabled: () => state.telemetryEnabled ?? false,
    getIsDiagnosing: () => state.isDiagnosing ?? false,
    getDiagnosisResult: () => state.diagnosisResult ?? null,
    requestGraphSnapshot: record("requestGraphSnapshot"),
    toggleTelemetry: record("toggleTelemetry"),
    runDiagnosis: record("runDiagnosis"),
    updateFlags: record("updateFlags"),
  } as unknown as DebuggerController;
  return { view, calls };
}

/** The markup the view renders now. */
function markup(view: XDebuggerView): string {
  return templateMarkup(view.render());
}

/**
 * An event of `type` carrying `fields`, which a listener reads off it the way
 * it reads `target` or `clientX` off the event the browser hands it.
 */
function eventWith(type: string, fields: Record<string, unknown> = {}): Event {
  const event = new Event(type);
  for (const [name, value] of Object.entries(fields)) {
    Object.defineProperty(event, name, { value });
  }
  return event;
}

/**
 * Fires `event` at the `element` of `template`, rendered by `view`, that holds
 * `text`, and returns what its listener returns.
 */
function fire(
  view: XDebuggerView,
  template: unknown,
  element: string,
  text: string,
  event: Event = new Event("click"),
): unknown {
  return templateListenerOn(template, event.type, view, element, text)(event);
}

/** Clicks the element of the rendered view that holds `text`. */
function click(view: XDebuggerView, element: string, text: string): unknown {
  return fire(view, view.render(), element, text);
}

/**
 * Makes the view show `tab`, as clicking its button does, and returns what
 * the click returns.
 */
function openTab(view: XDebuggerView, tab: string): unknown {
  return click(view, "button", tab);
}

/** Every marker type the topic filter keeps by default, oldest first. */
const MARKERS: RuntimeTelemetryMarkerResult[] = [
  {
    type: "storage.pull.start",
    id: "pull-1",
    operation: "sync",
    timeStamp: 1000,
  },
  { type: "scheduler.run", actionId: "action-1", timeStamp: 2000 },
];

/** Timing statistics of one operation over latencies 10 and 30. */
function timingStats(overrides: Partial<TimingStats> = {}): TimingStats {
  const cdf: CDFPoint[] = [{ x: 10, y: 0.5 }, { x: 30, y: 1 }];
  return {
    count: 2,
    min: 10,
    max: 30,
    totalTime: 40,
    average: 20,
    p50: 10,
    p95: 30,
    lastTime: 30,
    lastTimestamp: 0,
    slowest: [],
    cdf,
    cdfSinceBaseline: null,
    ...overrides,
  };
}

/** A logger's breakdown: `messages`, with the logger's `total` alongside. */
function breakdown(
  total: number,
  messages: Record<string, LogCounts>,
): LoggerBreakdown {
  return Object.assign(messages, { total });
}

/**
 * A logger breakdown holding one message with one `info` count, the logger
 * totalling `total`.
 */
const oneInfo = (message: string, total = 1) =>
  breakdown(total, {
    [message]: { debug: 0, info: 1, warn: 0, error: 0, total: 1 },
  });

describe("XDebuggerView", () => {
  describe("instance members", () => {
    describe("renderDiagnosis()", () => {
      it("renders every run of a non-idempotent report and every cell it wrote, a `bigint` included", () => {
        // A run's reads and writes are `FabricValue`s, which a `bigint` is.
        // The method reads the controller's result and the duration off
        // `this`; the controller stand-in offers the two reads it makes, and
        // the duration is the view's default.
        // The run count and the write count both exceed the debugger's usual
        // array and property limits, so the panel showing the last of each
        // is what the assertions pin.

        const writes = Object.fromEntries(
          Array.from({ length: 25 }, (_, i) => [`out${i}`, BigInt(i)]),
        );
        const runs = Array.from({ length: 8 }, (_, i) => ({
          timestamp: i,
          reads: { in: 1 },
          writes,
        }));
        const result = {
          duration: 5000,
          busyTime: 100,
          cycles: [],
          nonIdempotent: [{
            actionId: "action-1",
            runs,
            differingWriteKeys: ["out0"],
          }],
        };
        const view = new XDebuggerView();
        view.debuggerController = {
          getIsDiagnosing: () => false,
          getDiagnosisResult: () => result,
        } as unknown as DebuggerController;

        const markup = templateMarkup(
          view.accessForTestingOnly.renderDiagnosis(),
        );
        expect(markup).toContain("timestamp: 7");
        expect(markup).toContain("out24: 24n");
        expect(markup).not.toContain("... length:");
        expect(markup).not.toContain("... count:");
      });

      it("renders the summary, a report's pattern and differing writes, and each cycle back to its start", () => {
        const { view } = visibleView({
          diagnosisResult: {
            duration: 3000,
            busyTime: 10,
            nonIdempotent: [{
              actionId: "action-1",
              actionInfo: { patternName: "Counter" },
              runs: [],
              differingWriteKeys: ["a", "b"],
            }],
            cycles: [{
              cycle: [
                { actionId: "x", writesCell: "c1" },
                { actionId: "y", writesCell: "c2" },
              ],
              timestamp: 0,
            }],
          },
        });

        const rendered = templateMarkup(
          view.accessForTestingOnly.renderDiagnosis(),
        );
        expect(rendered).toContain(
          "Duration: 3.0s | Non-idempotent: 1 | Cycles: 1",
        );
        expect(rendered).toContain("Pattern: Counter");
        expect(rendered).toContain("Differing writes: a, b");
        expect(rendered).toContain("x --[c1]--> y --[c2]--> x");
        expect(rendered).not.toContain("No causal cycles detected.");
      });

      it("renders that nothing was found for a result with no reports or cycles", () => {
        const { view } = visibleView({
          diagnosisResult: {
            duration: 5000,
            busyTime: 0,
            nonIdempotent: [],
            cycles: [],
          },
        });

        const rendered = templateMarkup(
          view.accessForTestingOnly.renderDiagnosis(),
        );
        expect(rendered).toContain("No non-idempotent actions detected.");
        expect(rendered).toContain("No causal cycles detected.");
      });

      it("renders the instructions before any diagnosis has run", () => {
        const { view } = visibleView();
        const rendered = templateMarkup(
          view.accessForTestingOnly.renderDiagnosis(),
        );
        expect(rendered).toContain("Run a diagnosis to detect");
        expect(rendered).not.toContain("Duration: ");
      });

      it("runs a diagnosis for the chosen duration, falling back to five seconds for a value that is not one", () => {
        const { view, calls } = visibleView();
        const choose = (value: string) =>
          fire(
            view,
            view.accessForTestingOnly.renderDiagnosis(),
            "select",
            '<option value="3000">',
            eventWith("change", { target: { value } }),
          );
        const run = () =>
          fire(
            view,
            view.accessForTestingOnly.renderDiagnosis(),
            "button",
            "Run Diagnosis",
          );

        choose("10000");
        run();
        choose("soon");
        run();
        expect(calls.runDiagnosis).toEqual([[10000], [5000]]);
      });

      it("starts no second diagnosis while one is running", () => {
        const { view, calls } = visibleView({ isDiagnosing: true });
        const rendered = view.accessForTestingOnly.renderDiagnosis();
        expect(templateMarkup(rendered)).toContain("Capturing data...");

        fire(view, rendered, "button", "Diagnosing...");
        expect(calls.runDiagnosis).toBeUndefined();
      });
    });

    for (const [name, call] of handlers) {
      describe(`${name}()`, () => {
        // The handler runs fire-and-forget from `@click`, and logs a runtime
        // operation that fails. When the failure is a disposal race (logout, a
        // runtime swap) the operation was canceled rather than broken, so the
        // log is suppressed when the runtime's `signal.aborted` is set; such
        // a rejection must neither log nor escape as an unhandled rejection.

        it("logs a failure while the runtime is alive", async () => {
          const spy = captureConsole("error");
          try {
            await call(debuggerView(false, reject));
          } finally {
            spy.restore();
          }
          expect(spy.calls.length).toBe(1);
        });

        it("stays silent when the runtime is disposed", async () => {
          const spy = captureConsole("error");
          try {
            await call(debuggerView(true, reject));
          } finally {
            spy.restore();
          }
          expect(spy.calls.length).toBe(0);
        });
      });
    }

    describe("render()", () => {
      it("renders nothing while the panel is hidden", () => {
        const { view } = visibleView();
        view.visible = false;
        expect(markup(view).trim()).toBe("");
      });

      it("renders no event and says the filter left none before any subtopic is chosen", () => {
        // A view that was never connected has chosen no subtopic, so it keeps
        // no event.

        const { view } = visibleView();
        view.telemetryMarkers = MARKERS;
        const rendered = markup(view);
        expect(rendered).toContain("No events matching filters");
        expect(rendered).toContain("0 / 2");
      });

      it("renders that no event has arrived when there is none", () => {
        const { view } = visibleView();
        click(view, "button", "Toggle all topics");
        expect(markup(view)).toContain("No telemetry events yet");
      });

      describe("the events tab", () => {
        /** A visible view keeping every subtopic, holding `MARKERS`. */
        function eventsView(state: ControllerState = {}) {
          const made = visibleView(state);
          made.view.telemetryMarkers = MARKERS;
          click(made.view, "button", "Toggle all topics");
          return made;
        }

        it("renders every event the filter keeps, the newest first, with the count against the total", () => {
          const { view } = eventsView();
          const rendered = markup(view);
          expect(rendered.indexOf("action-1")).toBeLessThan(
            rendered.indexOf("pull-1"),
          );
          expect(rendered).not.toContain("PAUSED");
          expect(rendered).toContain("2 / 2");
          expect(rendered).toContain("Filters:");
          expect(rendered).toMatch(/action:<\/span>\s*<span[^>]*>action-1/);
          expect(rendered).toContain("☐");
        });

        it("renders only the events a search keeps, and every event again once it is cleared", () => {
          const { view } = eventsView();
          fire(
            view,
            view.render(),
            "input",
            "Search events",
            eventWith("input", { target: { value: "PULL-1" } }),
          );
          expect(markup(view)).toContain("1 / 2");
          expect(markup(view)).not.toContain("action-1");

          click(view, "button", "clear-search");
          expect(markup(view)).toContain("2 / 2");
          expect(markup(view)).not.toContain("clear-search");
        });

        it("renders a topic turned off as inactive, and drops its events", () => {
          const { view } = eventsView();
          click(view, "button", 'title="Scheduler"');
          const rendered = markup(view);
          expect(rendered).toContain('class="topic-toggle inactive"');
          expect(rendered).toContain("1 / 2");

          click(view, "button", 'title="Scheduler"');
          expect(markup(view)).not.toContain("topic-toggle inactive");
        });

        it("renders a topic with one subtopic unchecked as partial, with the count it keeps", () => {
          const { view } = eventsView();
          click(view, "button", "Filter subtopics");
          expect(markup(view)).toContain("subtopic-dropdown");
          expect(markup(view)).toContain("▲");

          fire(
            view,
            view.render(),
            "input",
            "subtopic-checkbox",
            new Event("change"),
          );
          const rendered = markup(view);
          expect(rendered).toContain('class="topic-toggle partial"');
          expect(rendered).toMatch(/1\/2\s*<\/span>/);
          expect(rendered).toContain("1 / 2");
        });

        it("closes an open subtopic menu when it is clicked again", () => {
          const { view } = eventsView();
          click(view, "button", "Filter subtopics");
          click(view, "button", "Filter subtopics");
          expect(markup(view)).not.toContain("subtopic-dropdown");
        });

        it("turns every subtopic off with the toggle-all button, and every one on again", () => {
          const { view } = eventsView();
          click(view, "button", "Toggle all topics");
          expect(markup(view)).toContain("0 / 2");
          expect(markup(view)).toContain("☑");

          click(view, "button", "Toggle all topics");
          expect(markup(view)).toContain("2 / 2");
        });

        it("holds the events it showed while paused, and shows the latest once resumed", () => {
          const { view } = eventsView();
          view.updated(new Map([["telemetryMarkers", []]]));
          click(view, "button", "(Space)");
          expect(markup(view)).toContain("PAUSED");

          view.telemetryMarkers = [MARKERS[0]];
          view.updated(new Map([["telemetryMarkers", MARKERS]]));
          expect(markup(view)).toContain("2 / 2");

          click(view, "button", "(Space)");
          expect(markup(view)).toContain("1 / 1");
          expect(markup(view)).not.toContain("PAUSED");
        });

        it("asks for the telemetry to be cleared, and forgets the events it held", () => {
          const { view } = eventsView();
          view.updated(new Map([["telemetryMarkers", []]]));
          click(view, "button", "(Space)");
          const cleared: Event[] = [];
          view.addEventListener("clear-telemetry", (e) => cleared.push(e));

          click(view, "button", "Clear events");
          expect(cleared.length).toBe(1);
          expect(cleared[0].bubbles).toBe(true);
          expect(cleared[0].composed).toBe(true);
          expect(markup(view)).toContain("0 / 0");
        });

        it("expands an event to its whole marker, at full height on request, and collapses it to neither", () => {
          const { view } = eventsView();
          click(view, "div", "event-item");
          expect(markup(view)).toContain('class="event-item expanded"');
          expect(markup(view)).toContain('actionId: "action-1"');

          click(view, "button", "Expand");
          expect(markup(view)).toContain("event-expanded full-height");
          expect(markup(view)).toContain("Collapse");

          click(view, "div", "event-item");
          expect(markup(view)).not.toContain("event-expanded");
          click(view, "div", "event-item");
          expect(markup(view)).not.toContain("full-height");
        });

        it("copies an expanded event's whole marker to the clipboard as JSON", () => {
          const { view } = eventsView();
          click(view, "div", "event-item");
          const written: string[] = [];
          const restore = installGlobals({
            navigator: {
              clipboard: { writeText: (text: string) => written.push(text) },
            },
          });
          try {
            click(view, "button", "Copy Full");
          } finally {
            restore();
          }
          expect(written).toEqual([JSON.stringify(MARKERS[1], null, 2)]);
        });

        it("logs a copy the clipboard refuses", () => {
          const { view } = eventsView();
          click(view, "div", "event-item");
          const spy = captureConsole("error");
          const restore = installGlobals({
            navigator: {
              clipboard: {
                writeText: () => {
                  throw new Error("denied");
                },
              },
            },
          });
          try {
            click(view, "button", "Copy Full");
          } finally {
            restore();
            spy.restore();
          }
          expect(spy.calls.map(([message]) => message)).toEqual([
            "Failed to copy JSON:",
          ]);
        });

        it("renders the telemetry switch as the controller reports it, and flips it on a click", () => {
          const on = eventsView({ telemetryEnabled: true });
          expect(markup(on.view)).toContain("Telemetry ON - click to disable");
          const off = eventsView({ telemetryEnabled: false });
          expect(markup(off.view)).toContain("Telemetry OFF - click to enable");

          click(off.view, "button", "Telemetry OFF");
          expect(off.calls.toggleTelemetry).toEqual([[]]);
        });
      });

      describe("the tabs", () => {
        it("renders the scheduler graph, and asks for a fresh snapshot, once its tab is chosen", () => {
          const { view, calls } = visibleView();
          openTab(view, "Scheduler");
          const rendered = markup(view);
          expect(rendered).toContain("<x-scheduler-graph");
          expect(rendered).toContain('class="tab-button active"');
          expect(rendered).not.toContain("Search events");
          expect(calls.requestGraphSnapshot).toEqual([[]]);
        });

        it("renders the diagnosis panel once its tab is chosen, and the events again after", () => {
          const { view } = visibleView();
          openTab(view, "Diagnosis");
          expect(markup(view)).toContain("Run a diagnosis to detect");

          // The first tab's name also labels the event count, which the
          // header renders before the tabs; its class names it uniquely.
          click(view, "button", "tab-button");
          expect(markup(view)).toContain("Search events");
        });
      });

      describe("the loggers tab", () => {
        let logSpy: ReturnType<typeof captureConsole>;
        let restoreGlobals = () => {};

        // Sampling logs what it sampled, which a test has no use for.
        beforeEach(() => {
          logSpy = captureConsole("log");
        });

        afterEach(() => {
          restoreGlobals();
          restoreGlobals = () => {};
          logSpy.restore();
        });

        /**
         * Installs the main thread's logger registry and counts, recording
         * each baseline reset in `resets`.
         */
        function mainLoggers(
          registry: Record<string, { disabled: boolean; level: string }>,
          counts: LoggerCounts,
          timing: LoggerTiming = {},
        ) {
          const resets: string[] = [];
          restoreGlobals = installGlobals({
            commonfabric: {
              logger: registry,
              getLoggerCountsBreakdown: () => counts,
              getTimingStatsBreakdown: () => timing,
              resetAllCountBaselines: () => resets.push("counts"),
              resetAllTimingBaselines: () => resets.push("timing"),
            },
          });
          return { resets };
        }

        it("renders that no logger is registered when there is none", async () => {
          const { view } = visibleView();
          await openTab(view, "Loggers");
          expect(markup(view)).toContain("No loggers registered yet.");
        });

        it("renders each logger's total, enabled state and level, from the main thread or else the worker", async () => {
          mainLoggers(
            { local: { disabled: true, level: "warn" } },
            { total: 1, local: oneInfo("m") },
          );
          const { rt } = workerRuntime({
            counts: { total: 2, remote: oneInfo("r", 2) },
            metadata: { remote: { enabled: true, level: "debug" } },
          });
          const { view } = visibleView({ runtime: rt });
          await openTab(view, "Loggers");
          await click(view, "button", "Sample");

          const rendered = markup(view);
          expect(rendered).toMatch(/Total: 3\s/);
          expect(rendered).toContain('class="logger-item disabled"');
          expect(rendered).toContain('class="logger-toggle off"');
          expect(rendered).toContain('class="logger-toggle on"');
          expect(rendered).toContain('<option value="warn" ?selected="true"');
          expect(rendered).toContain('<option value="debug" ?selected="true"');
          expect(view.accessForTestingOnly.workerLoggerMetadata).toEqual({
            remote: { enabled: true, level: "debug" },
          });
        });

        it("asks the worker for its counts when the tab is chosen, and hands the flags it reports to the controller", async () => {
          const { rt, calls: workerCalls } = workerRuntime({
            counts: { total: 0 },
            metadata: {},
            flags: {},
          });
          const { view, calls } = visibleView({ runtime: rt });
          await openTab(view, "Loggers");
          expect(workerCalls).toEqual([["getLoggerCounts"]]);
          expect(calls.updateFlags).toEqual([[{}]]);
        });

        it("renders the main thread's counts alone when the worker cannot report", async () => {
          mainLoggers({}, { total: 4, local: oneInfo("m", 4) });
          const { rt } = workerRuntime({ counts: { total: 0 }, metadata: {} });
          rt.getLoggerCounts = () => Promise.reject(new Error("gone"));
          const { view } = visibleView({ runtime: rt });
          await openTab(view, "Loggers");
          await click(view, "button", "Sample");
          expect(markup(view)).toMatch(/Total: 4\s/);
        });

        it("expands a logger to its messages, the busiest first, and its timing charts", async () => {
          mainLoggers(
            {},
            {
              total: 6,
              local: breakdown(6, {
                quiet: { debug: 1, info: 0, warn: 0, error: 0, total: 1 },
                busy: { debug: 0, info: 2, warn: 2, error: 1, total: 5 },
              }),
            },
            {
              local: {
                "op/a": timingStats(),
                idle: timingStats({ count: 0, cdf: [] }),
              },
            },
          );
          const { view } = visibleView();
          await openTab(view, "Loggers");
          await click(view, "button", "Sample");
          expect(markup(view)).not.toContain("logger-keys");

          click(view, "div", "logger-header");
          const rendered = markup(view);
          expect(rendered).toContain("▼");
          expect(rendered.indexOf("busy")).toBeLessThan(
            rendered.indexOf("quiet"),
          );
          expect(rendered).toContain('id="cdf-op-a"');
          expect(rendered).toContain("p50=10.0ms");
          expect(rendered).toContain("All time (0.04s in 2 samples)");
          expect(rendered).not.toContain("idle");

          click(view, "div", "logger-header");
          expect(markup(view)).not.toContain("logger-keys");
        });

        it("renders a chart's baseline curve and legend when samples arrived since the baseline", async () => {
          mainLoggers({}, { total: 1, local: oneInfo("m") }, {
            local: {
              since: timingStats({
                cdfSinceBaseline: [{ x: 5, y: 1 }],
              }),
            },
          });
          const { view } = visibleView();
          await openTab(view, "Loggers");
          await click(view, "button", "Sample");
          click(view, "div", "logger-header");
          const rendered = markup(view);
          expect(rendered).toContain("Since baseline (0.01s in 1 samples)");
          expect(rendered).toContain('d="M 550 25"');
        });

        it("renders no chart for a logger whose timing holds no operation", async () => {
          mainLoggers({}, { total: 1, local: oneInfo("m") }, { local: {} });
          const { view } = visibleView();
          await openTab(view, "Loggers");
          await click(view, "button", "Sample");
          click(view, "div", "logger-header");
          expect(markup(view)).toContain("logger-keys");
          expect(markup(view)).not.toContain("timing-histogram");
        });

        it("renders a tooltip for the chart point under the pointer, and none once the pointer leaves", async () => {
          mainLoggers({}, { total: 1, local: oneInfo("m") }, {
            local: { op: timingStats() },
          });
          const { view } = visibleView();
          await openTab(view, "Loggers");
          await click(view, "button", "Sample");
          click(view, "div", "logger-header");
          const svg = {
            getBoundingClientRect: () => ({
              left: 100,
              top: 50,
              width: 600,
              height: 200,
            }),
          };

          fire(
            view,
            view.render(),
            "svg",
            "cdf-op",
            eventWith("mousemove", {
              clientX: 650,
              clientY: 75,
              currentTarget: svg,
            }),
          );
          const rendered = markup(view);
          expect(rendered).toContain("left: 660px; top: 65px;");
          expect(rendered).toContain("All time: 30.0ms");

          fire(view, view.render(), "svg", "cdf-op", new Event("mouseleave"));
          expect(markup(view)).not.toContain("timing-tooltip");

          fire(
            view,
            view.render(),
            "svg",
            "cdf-op",
            eventWith("mousemove", {
              clientX: 120,
              clientY: 75,
              currentTarget: svg,
            }),
          );
          expect(markup(view)).not.toContain("timing-tooltip");
        });

        it("turns a main-thread logger off and back on, and sets its level, without the worker", async () => {
          const registry = { local: { disabled: false, level: "info" } };
          mainLoggers(registry, { total: 1, local: oneInfo("m") });
          const { rt, calls } = workerRuntime({
            counts: { total: 0 },
            metadata: {},
          });
          const { view } = visibleView({ runtime: rt });
          await openTab(view, "Loggers");
          await click(view, "button", "Sample");

          click(view, "button", "Logger enabled - click to disable");
          expect(registry.local.disabled).toBe(true);
          click(view, "button", "Logger disabled - click to enable");
          expect(registry.local.disabled).toBe(false);

          fire(
            view,
            view.render(),
            "select",
            "Minimum log level",
            eventWith("change", { target: { value: "error" } }),
          );
          expect(registry.local.level).toBe("error");
          expect(calls).toEqual([["getLoggerCounts"], ["getLoggerCounts"]]);
        });

        it("asks the worker to flip a worker logger and to set its level, then samples again", async () => {
          const { rt, calls } = workerRuntime({
            counts: { total: 1, remote: oneInfo("r") },
            metadata: { remote: { enabled: true, level: "info" } },
          });
          const { view } = visibleView({ runtime: rt });
          await openTab(view, "Loggers");
          await click(view, "button", "Sample");
          calls.length = 0;

          await click(view, "button", "Logger enabled - click to disable");
          await view.accessForTestingOnly.setLoggerLevel("remote", "warn");
          expect(calls).toEqual([
            ["setLoggerEnabled", false, "remote"],
            ["getLoggerCounts"],
            ["setLoggerLevel", "warn", "remote"],
            ["getLoggerCounts"],
          ]);
        });

        it("ignores a logger neither the main thread nor the worker knows", async () => {
          const { rt, calls } = workerRuntime({
            counts: { total: 0 },
            metadata: {},
          });
          const { view } = visibleView({ runtime: rt });
          await view.accessForTestingOnly.toggleLogger("ghost");
          await view.accessForTestingOnly.setLoggerLevel("ghost", "warn");
          expect(calls).toEqual([]);
        });

        it("resets the main thread's and the worker's baselines, then samples again", async () => {
          const { resets } = mainLoggers({}, {
            total: 1,
            local: oneInfo("m"),
          });
          const { rt, calls } = workerRuntime({
            counts: { total: 0 },
            metadata: {},
          });
          const { view } = visibleView({ runtime: rt });
          await openTab(view, "Loggers");
          calls.length = 0;

          await click(view, "button", "Reset Baseline");
          expect(resets).toEqual(["counts", "timing"]);
          expect(calls).toEqual([["resetLoggerBaselines"], [
            "getLoggerCounts",
          ]]);
        });

        it("stops a click on a logger's controls from reaching its header", async () => {
          mainLoggers({}, { total: 1, local: oneInfo("m") });
          const { view } = visibleView();
          await openTab(view, "Loggers");
          const event = new Event("click");
          fire(view, view.render(), "span", "logger-controls", event);
          expect(event.cancelBubble).toBe(true);
        });
      });
    });

    describe("connectedCallback() and disconnectedCallback()", () => {
      let restore = () => {};
      const document = new EventTarget();

      beforeEach(() => {
        restore = installGlobals({ document });
      });

      afterEach(() => restore());

      /**
       * Connects `view` the way a page does, except that updates do nothing,
       * since there is no DOM to render into.
       */
      function connect(view: XDebuggerView) {
        Object.defineProperty(view, "performUpdate", { value: () => {} });
        Object.defineProperty(view, "renderRoot", { value: {} });
        view.connectedCallback();
      }

      /** A click whose target is outside every topic's buttons. */
      const outsideClick = () =>
        eventWith("click", { target: { closest: () => null } });

      it("keeps every subtopic once connected", () => {
        const { view } = visibleView();
        view.telemetryMarkers = MARKERS;
        expect(markup(view)).toContain("topic-toggle inactive");

        connect(view);
        const rendered = markup(view);
        expect(rendered).toContain('class="topic-toggle active"');
        expect(rendered).not.toContain("topic-toggle inactive");
        expect(rendered).not.toContain("topic-toggle partial");
        expect(rendered).toContain("2 / 2");
        view.disconnectedCallback();
      });

      it("hears the page's key presses and clicks while connected, and not once disconnected", () => {
        const { view } = visibleView();
        connect(view);
        const search = () =>
          fire(
            view,
            view.render(),
            "input",
            "Search events",
            eventWith("input", { target: { value: "pull" } }),
          );
        const escape = () => eventWith("keydown", { key: "Escape" });

        search();
        document.dispatchEvent(escape());
        expect(markup(view)).not.toContain("clear-search");
        click(view, "button", "Filter subtopics");
        document.dispatchEvent(outsideClick());
        expect(markup(view)).not.toContain("subtopic-dropdown");

        view.disconnectedCallback();
        search();
        document.dispatchEvent(escape());
        expect(markup(view)).toContain("clear-search");
        click(view, "button", "Filter subtopics");
        document.dispatchEvent(outsideClick());
        expect(markup(view)).toContain("subtopic-dropdown");
      });
    });

    describe("updated()", () => {
      /** A visible view keeping every subtopic, given `MARKERS`. */
      function viewWithMarkers() {
        const { view } = visibleView();
        view.telemetryMarkers = MARKERS;
        click(view, "button", "Toggle all topics");
        return view;
      }

      it("takes new markers as the list a pause holds", () => {
        const view = viewWithMarkers();
        view.updated(new Map([["telemetryMarkers", []]]));
        click(view, "button", "(Space)");
        expect(markup(view)).toContain("2 / 2");
      });

      it("leaves the list a pause holds alone when the markers did not change", () => {
        const view = viewWithMarkers();
        view.updated(new Map([["visible", false]]));
        click(view, "button", "(Space)");
        expect(markup(view)).toContain("0 / 0");
      });
    });

    describe("handleKeyDown()", () => {
      let restore = () => {};
      const body = new EventTarget();

      beforeEach(() => {
        restore = installGlobals({ document: { body } });
      });

      afterEach(() => restore());

      /** A key press of `key` on `target`, counting `preventDefault()`. */
      function keyPress(key: string, target: EventTarget) {
        const press = { key, target, prevented: 0, preventDefault() {} };
        press.preventDefault = () => press.prevented++;
        return press;
      }

      it("clears the search on Escape", () => {
        const { view } = visibleView();
        fire(
          view,
          view.render(),
          "input",
          "Search events",
          eventWith("input", { target: { value: "pull" } }),
        );
        const press = keyPress("Escape", body);
        view.accessForTestingOnly.handleKeyDown(press);
        expect(press.prevented).toBe(1);
        expect(markup(view)).not.toContain("clear-search");
      });

      it("leaves Escape alone with no search to clear", () => {
        const { view } = visibleView();
        const press = keyPress("Escape", body);
        view.accessForTestingOnly.handleKeyDown(press);
        expect(press.prevented).toBe(0);
      });

      it("pauses on Space pressed on the page body while the panel is visible", () => {
        const { view } = visibleView();
        const press = keyPress(" ", body);
        view.accessForTestingOnly.handleKeyDown(press);
        expect(press.prevented).toBe(1);
        expect(markup(view)).toContain("PAUSED");
      });

      it("leaves Space alone when it is pressed elsewhere, or the panel is hidden", () => {
        const { view } = visibleView();
        view.accessForTestingOnly.handleKeyDown(
          keyPress(" ", new EventTarget()),
        );
        view.visible = false;
        view.accessForTestingOnly.handleKeyDown(keyPress(" ", body));
        view.visible = true;
        expect(markup(view)).not.toContain("PAUSED");
      });
    });

    describe("handleDocumentClick()", () => {
      /** A click target that is, or is not, inside a topic's buttons. */
      const target = (insideTopic: boolean) =>
        Object.assign(new EventTarget(), {
          closest: (selector: string) =>
            insideTopic && selector === ".topic-button-group" ? {} : null,
        });

      it("closes an open subtopic menu on a click outside every topic", () => {
        const { view } = visibleView();
        click(view, "button", "Filter subtopics");
        view.accessForTestingOnly.handleDocumentClick({ target: target(true) });
        expect(markup(view)).toContain("subtopic-dropdown");

        view.accessForTestingOnly.handleDocumentClick({
          target: target(false),
        });
        expect(markup(view)).not.toContain("subtopic-dropdown");
      });
    });
  });
});
