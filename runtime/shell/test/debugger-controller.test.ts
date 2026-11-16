import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type Stub, stub } from "@std/testing/mock";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type {
  LoggerFlagsData,
  PatternSourceInfo,
  RuntimeTelemetryMarkerResult,
  SchedulerDiagnosisResult,
  SchedulerGraphSnapshot,
} from "@commonfabric/runtime-client";

import { DebuggerController } from "../src/lib/debugger-controller.ts";
import type { RuntimeInternals } from "../src/lib/runtime.ts";

/** A host that records the controllers it is given and the updates asked of it. */
class StandInHost extends EventTarget implements ReactiveControllerHost {
  readonly controllers: ReactiveController[] = [];
  readonly updateComplete = Promise.resolve(true);
  updates = 0;

  addController(controller: ReactiveController): void {
    this.controllers.push(controller);
  }

  removeController(controller: ReactiveController): void {
    this.controllers.splice(this.controllers.indexOf(controller), 1);
  }

  requestUpdate(): void {
    this.updates++;
  }
}

/** The calls the controller makes of the runtime's worker client. */
interface WorkerStandIn {
  setTelemetryEnabled(enabled: boolean): Promise<void>;
  getGraphSnapshot(): Promise<SchedulerGraphSnapshot>;
  getLoggerCounts(): Promise<{ flags: LoggerFlagsData }>;
  getPatternSources(): Promise<{ patterns: readonly PatternSourceInfo[] }>;
  setBreakpoints(actionIds: string[]): Promise<void>;
  detectNonIdempotent(durationMs?: number): Promise<SchedulerDiagnosisResult>;
}

/**
 * Builds a runtime exposing only what the controller uses: its telemetry
 * markers, its `telemetryupdate` events, and a worker client whose calls are
 * recorded in `calls` unless `overrides` replaces them.
 */
function standInRuntime(overrides: Partial<WorkerStandIn> = {}) {
  const calls: unknown[][] = [];
  const events = new EventTarget();
  const telemetry = {
    markers: [] as RuntimeTelemetryMarkerResult[],
    reads: 0,
    onRead: () => {},
  };
  const worker: WorkerStandIn = {
    setTelemetryEnabled: (enabled) => {
      calls.push(["setTelemetryEnabled", enabled]);
      return Promise.resolve();
    },
    getGraphSnapshot: () => Promise.resolve(snapshot([])),
    getLoggerCounts: () => Promise.resolve({ flags: {} }),
    getPatternSources: () => Promise.resolve({ patterns: [] }),
    setBreakpoints: (actionIds) => {
      calls.push(["setBreakpoints", actionIds]);
      return Promise.resolve();
    },
    detectNonIdempotent: () => Promise.resolve(diagnosis),
    ...overrides,
  };
  const standIn = {
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    runtime: () => worker,
    telemetry: () => {
      telemetry.reads++;
      telemetry.onRead();
      return telemetry.markers;
    },
  };
  return {
    runtime: standIn as RuntimeInternals,
    calls,
    telemetry,
    update: () => events.dispatchEvent(new Event("telemetryupdate")),
  };
}

/** A connected controller over stand-in storage, window and host. */
function connectedController(saved: Record<string, string> = {}) {
  const host = new StandInHost();
  const stored = new Map(Object.entries(saved));
  const window = new EventTarget();
  const controller = new DebuggerController(host, {
    storage: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => {
        stored.set(key, value);
      },
    },
    window,
  });
  controller.hostConnected();
  const storageEvent = (key: string | null, newValue: string | null) =>
    window.dispatchEvent(
      Object.assign(new Event("storage"), { key, newValue }),
    );
  return { host, stored, controller, storageEvent };
}

function snapshot(
  edges: [string, string][],
  timestamp = 1,
): SchedulerGraphSnapshot {
  return {
    nodes: [{ id: "a", type: "computation", isDirty: false, isPending: false }],
    edges: edges.map(([from, to]) => ({ from, to, cells: [`${from}-cell`] })),
    timestamp,
  };
}

function runMarker(actionId: string): RuntimeTelemetryMarkerResult {
  return { type: "scheduler.run", actionId, timeStamp: 1 };
}

const diagnosis: SchedulerDiagnosisResult = {
  nonIdempotent: [],
  cycles: [],
  duration: 250,
  busyTime: 10,
};

describe("DebuggerController", () => {
  let consoleError: Stub<Console>;
  let errors: unknown[][];

  beforeEach(() => {
    errors = [];
    consoleError = stub(console, "error", (...args: unknown[]) => {
      errors.push(args);
    });
  });

  afterEach(() => {
    consoleError.restore();
  });

  describe("constructor()", () => {
    it("registers the controller with its host", () => {
      const { host, controller } = connectedController();
      expect(host.controllers).toEqual([controller]);
    });
  });

  describe("instance members", () => {
    describe("hostConnected()", () => {
      it("restores the saved visibility and telemetry preference", () => {
        const { controller } = connectedController({
          showDebuggerView: "true",
          telemetryEnabled: "true",
        });
        expect(controller.isVisible()).toBe(true);
        expect(controller.isTelemetryEnabled()).toBe(true);
      });

      it("leaves the debugger hidden and telemetry off when nothing is saved", () => {
        const { controller } = connectedController();
        expect(controller.isVisible()).toBe(false);
        expect(controller.isTelemetryEnabled()).toBe(false);
      });

      it("leaves the debugger hidden and telemetry off when `false` is saved", () => {
        const { controller } = connectedController({
          showDebuggerView: "false",
          telemetryEnabled: "false",
        });
        expect(controller.isVisible()).toBe(false);
        expect(controller.isTelemetryEnabled()).toBe(false);
      });

      it("follows the visibility another tab saves", () => {
        const { host, controller, storageEvent } = connectedController();

        storageEvent("showDebuggerView", "true");
        expect(controller.isVisible()).toBe(true);
        expect(host.updates).toBe(1);

        storageEvent("showDebuggerView", "true");
        expect(host.updates).toBe(1);

        storageEvent("showDebuggerView", "false");
        expect(controller.isVisible()).toBe(false);
        expect(host.updates).toBe(2);
      });

      it("ignores another tab's write to another key, and a cleared key", () => {
        const { host, controller, storageEvent } = connectedController();

        storageEvent("telemetryEnabled", "true");
        storageEvent("showDebuggerView", null);
        storageEvent(null, null);
        expect(controller.isVisible()).toBe(false);
        expect(controller.isTelemetryEnabled()).toBe(false);
        expect(host.updates).toBe(0);
      });

      it("clears the telemetry markers when the host raises `clear-telemetry`", () => {
        const { host, controller } = connectedController();
        const rt = standInRuntime();
        rt.telemetry.markers = [runMarker("a")];
        controller.setRuntime(rt.runtime);
        const updates = host.updates;

        host.dispatchEvent(new Event("clear-telemetry"));
        expect(controller.getTelemetryMarkers()).toEqual([]);
        expect(host.updates).toBe(updates + 1);
      });
    });

    describe("hostDisconnected()", () => {
      it("stops following other tabs and `clear-telemetry`", () => {
        const { host, controller, storageEvent } = connectedController();
        const rt = standInRuntime();
        rt.telemetry.markers = [runMarker("a")];
        controller.setRuntime(rt.runtime);
        const updates = host.updates;

        controller.hostDisconnected();
        storageEvent("showDebuggerView", "true");
        host.dispatchEvent(new Event("clear-telemetry"));
        expect(controller.isVisible()).toBe(false);
        expect(controller.getTelemetryMarkers()).toEqual([runMarker("a")]);
        expect(host.updates).toBe(updates);
      });
    });

    describe("setRuntime()", () => {
      it("loads the runtime's most recent thousand markers", () => {
        const { host, controller } = connectedController();
        const rt = standInRuntime();
        rt.telemetry.markers = Array.from(
          { length: 1001 },
          (_, i) => runMarker(`action-${i}`),
        );

        controller.setRuntime(rt.runtime);
        const markers = controller.getTelemetryMarkers();
        expect(markers).toHaveLength(1000);
        expect(markers[0]).toEqual(runMarker("action-1"));
        expect(markers[999]).toEqual(runMarker("action-1000"));
        expect(controller.getRuntime()).toBe(rt.runtime);
        expect(host.updates).toBe(1);
      });

      it("sends the worker the saved telemetry preference and the breakpoints", async () => {
        const { controller } = connectedController({
          telemetryEnabled: "true",
        });
        await controller.setBreakpointsForActions(["a", "b"], true);

        const rt = standInRuntime();
        controller.setRuntime(rt.runtime);
        expect(rt.calls).toEqual([
          ["setTelemetryEnabled", true],
          ["setBreakpoints", ["a", "b"]],
        ]);
      });

      it("drops the previous runtime's pattern sources", async () => {
        const { controller } = connectedController();
        const sources = [{ identity: "cf:module/one", files: [] }];
        controller.setRuntime(
          standInRuntime({
            getPatternSources: () => Promise.resolve({ patterns: sources }),
          }).runtime,
        );
        await controller.requestPatternSources();
        expect(controller.getPatternSources()).toEqual(sources);
        const version = controller.getPatternSourcesVersion();

        controller.setRuntime(standInRuntime().runtime);
        expect(controller.getPatternSources()).toEqual([]);
        expect(controller.getPatternSourcesVersion()).toBe(version + 1);
      });

      it("stops following the runtime it replaces", () => {
        const { controller } = connectedController();
        const first = standInRuntime();
        const second = standInRuntime();
        controller.setRuntime(first.runtime);
        controller.setRuntime(second.runtime);

        first.telemetry.markers = [runMarker("stale")];
        first.update();
        expect(controller.getTelemetryMarkers()).toEqual([]);

        second.telemetry.markers = [runMarker("fresh")];
        second.update();
        expect(controller.getTelemetryMarkers()).toEqual([runMarker("fresh")]);
      });

      it("logs the worker's refusal of the telemetry preference", async () => {
        const { controller } = connectedController();
        const refusal = Promise.reject(new Error("worker gone"));
        controller.setRuntime(
          standInRuntime({ setTelemetryEnabled: () => refusal }).runtime,
        );

        // The controller's handler was attached to `refusal` first, so it has
        // run by the time this one has.
        await refusal.catch(() => {});
        expect(errors).toEqual([[
          "[DebuggerController] Failed to set telemetry enabled:",
          new Error("worker gone"),
        ]]);
      });
    });

    describe("`telemetryupdate`", () => {
      it("replaces the markers with the runtime's most recent thousand", () => {
        const { host, controller } = connectedController();
        const rt = standInRuntime();
        controller.setRuntime(rt.runtime);
        const updates = host.updates;

        rt.telemetry.markers = Array.from(
          { length: 1002 },
          (_, i) => runMarker(`action-${i}`),
        );
        rt.update();
        expect(controller.getTelemetryMarkers()).toHaveLength(1000);
        expect(controller.getTelemetryMarkers()[0]).toEqual(
          runMarker("action-2"),
        );
        expect(host.updates).toBe(updates);
      });

      it("takes up a graph snapshot that is the latest marker", () => {
        const { controller } = connectedController();
        const rt = standInRuntime();
        controller.setRuntime(rt.runtime);
        const graph = snapshot([["a", "b"]], 7);

        rt.telemetry.markers = [
          { type: "scheduler.graph.snapshot", graph, timeStamp: 1 },
        ];
        rt.update();
        expect(controller.getGraphUpdateVersion()).toBe(1);
        expect(controller.getGraphWithHistory()).toEqual({
          nodes: graph.nodes,
          edges: [{
            from: "a",
            to: "b",
            cells: ["a-cell"],
            isHistorical: false,
          }],
          timestamp: 7,
        });
      });

      it("leaves the graph alone when the latest marker is not a snapshot", () => {
        const { controller } = connectedController();
        const rt = standInRuntime();
        controller.setRuntime(rt.runtime);

        rt.telemetry.markers = [
          {
            type: "scheduler.graph.snapshot",
            graph: snapshot([]),
            timeStamp: 1,
          },
          runMarker("a"),
        ];
        rt.update();
        expect(controller.getGraphUpdateVersion()).toBe(0);
        expect(controller.getGraphWithHistory()).toBeUndefined();
      });

      it("ignores an update raised while one is being handled", () => {
        const { controller } = connectedController();
        const rt = standInRuntime();
        controller.setRuntime(rt.runtime);
        const reads = rt.telemetry.reads;

        rt.telemetry.onRead = () => {
          rt.telemetry.onRead = () => {};
          rt.update();
        };
        rt.update();
        expect(rt.telemetry.reads).toBe(reads + 1);

        rt.update();
        expect(rt.telemetry.reads).toBe(reads + 2);
      });
    });

    describe("setVisibility()", () => {
      it("saves a change and asks the host to update", () => {
        const { host, stored, controller } = connectedController();
        controller.setVisibility(true);
        expect(controller.isVisible()).toBe(true);
        expect(stored.get("showDebuggerView")).toBe("true");
        expect(host.updates).toBe(1);

        controller.setVisibility(false);
        expect(stored.get("showDebuggerView")).toBe("false");
        expect(host.updates).toBe(2);
      });

      it("does nothing when the visibility is unchanged", () => {
        const { host, stored, controller } = connectedController();
        controller.setVisibility(false);
        expect(stored.has("showDebuggerView")).toBe(false);
        expect(host.updates).toBe(0);
      });
    });

    describe("toggleTelemetry()", () => {
      it("saves the flipped preference, sends it to the worker, and asks the host to update", () => {
        const { host, stored, controller } = connectedController();
        const rt = standInRuntime();
        controller.setRuntime(rt.runtime);
        rt.calls.length = 0;
        const updates = host.updates;

        controller.toggleTelemetry();
        expect(controller.isTelemetryEnabled()).toBe(true);
        expect(stored.get("telemetryEnabled")).toBe("true");
        expect(rt.calls).toEqual([["setTelemetryEnabled", true]]);
        expect(host.updates).toBe(updates + 1);

        controller.toggleTelemetry();
        expect(controller.isTelemetryEnabled()).toBe(false);
        expect(stored.get("telemetryEnabled")).toBe("false");
        expect(rt.calls).toEqual([
          ["setTelemetryEnabled", true],
          ["setTelemetryEnabled", false],
        ]);
      });

      it("saves the preference with no runtime to send it to", () => {
        const { host, stored, controller } = connectedController();
        controller.toggleTelemetry();
        expect(stored.get("telemetryEnabled")).toBe("true");
        expect(host.updates).toBe(1);
      });
    });

    describe("setTelemetryEnabled()", () => {
      it("does nothing when the preference is unchanged", () => {
        const { host, stored, controller } = connectedController();
        const rt = standInRuntime();
        controller.setRuntime(rt.runtime);
        rt.calls.length = 0;
        const updates = host.updates;

        controller.setTelemetryEnabled(false);
        expect(stored.has("telemetryEnabled")).toBe(false);
        expect(rt.calls).toEqual([]);
        expect(host.updates).toBe(updates);
      });
    });

    describe("getGraphWithHistory()", () => {
      it("returns `undefined` before any snapshot", () => {
        const { controller } = connectedController();
        expect(controller.getGraphWithHistory()).toBeUndefined();
      });

      it("keeps an edge a later snapshot drops, marked historical, until it returns", async () => {
        const { controller } = connectedController();
        const graphs = [
          snapshot([["a", "b"], ["b", "c"]], 1),
          snapshot([["b", "c"]], 2),
          snapshot([["a", "b"], ["b", "c"]], 3),
        ];
        controller.setRuntime(
          standInRuntime({
            getGraphSnapshot: () => Promise.resolve(graphs.shift()!),
          }).runtime,
        );

        await controller.requestGraphSnapshot();
        await controller.requestGraphSnapshot();
        expect(controller.getGraphWithHistory()?.edges).toEqual([
          { from: "b", to: "c", cells: ["b-cell"], isHistorical: false },
          { from: "a", to: "b", cells: [], isHistorical: true },
        ]);

        await controller.requestGraphSnapshot();
        expect(controller.getGraphWithHistory()).toEqual({
          nodes: snapshot([]).nodes,
          edges: [
            { from: "a", to: "b", cells: ["a-cell"], isHistorical: false },
            { from: "b", to: "c", cells: ["b-cell"], isHistorical: false },
          ],
          timestamp: 3,
        });
      });
    });

    describe("requestGraphSnapshot()", () => {
      it("takes up the worker's snapshot, then refreshes the flags", async () => {
        const { host, controller } = connectedController();
        const flags: LoggerFlagsData = { runner: { invalid: { x: null } } };
        const counts = Promise.resolve({ flags });
        controller.setRuntime(
          standInRuntime({
            getGraphSnapshot: () => Promise.resolve(snapshot([["a", "b"]])),
            getLoggerCounts: () => counts,
          }).runtime,
        );
        const updates = host.updates;

        await controller.requestGraphSnapshot();
        expect(controller.getGraphUpdateVersion()).toBe(1);
        expect(controller.getGraphWithHistory()?.edges).toHaveLength(1);

        // The controller is awaiting `counts` already, so it has taken the
        // flags up by the time this await returns.
        await counts;
        expect(controller.getActiveFlags()).toBe(flags);
        expect(host.updates).toBe(updates + 2);
      });

      it("does nothing without a runtime", async () => {
        const { host, controller } = connectedController();
        await controller.requestGraphSnapshot();
        expect(controller.getGraphUpdateVersion()).toBe(0);
        expect(host.updates).toBe(0);
      });
    });

    describe("requestPatternSources()", () => {
      it("takes up the worker's pattern sources", async () => {
        const { host, controller } = connectedController();
        const sources = [{ identity: "cf:module/one", files: [] }];
        controller.setRuntime(
          standInRuntime({
            getPatternSources: () => Promise.resolve({ patterns: sources }),
          }).runtime,
        );
        const version = controller.getPatternSourcesVersion();
        const updates = host.updates;

        await controller.requestPatternSources();
        expect(controller.getPatternSources()).toBe(sources);
        expect(controller.getPatternSourcesVersion()).toBe(version + 1);
        expect(host.updates).toBe(updates + 1);
      });

      it("logs a failure and keeps what it had", async () => {
        const { controller } = connectedController();
        controller.setRuntime(
          standInRuntime({
            getPatternSources: () => Promise.reject(new Error("no sources")),
          }).runtime,
        );
        const version = controller.getPatternSourcesVersion();

        await controller.requestPatternSources();
        expect(controller.getPatternSources()).toEqual([]);
        expect(controller.getPatternSourcesVersion()).toBe(version);
        expect(errors).toEqual([[
          "[DebuggerController] Failed to request pattern sources:",
          new Error("no sources"),
        ]]);
      });

      it("does nothing without a runtime", async () => {
        const { host, controller } = connectedController();
        await controller.requestPatternSources();
        expect(controller.getPatternSourcesVersion()).toBe(0);
        expect(host.updates).toBe(0);
      });
    });

    describe("setBreakpointsForActions()", () => {
      it("adds and removes breakpoints, sending the whole set to the worker", async () => {
        const { host, controller } = connectedController();
        const rt = standInRuntime();
        controller.setRuntime(rt.runtime);
        rt.calls.length = 0;
        const updates = host.updates;

        await controller.setBreakpointsForActions(["a", "b", "c"], true);
        await controller.setBreakpointsForActions(["b", "z"], false);
        expect(controller.getBreakpoints()).toEqual(new Set(["a", "c"]));
        expect(rt.calls).toEqual([
          ["setBreakpoints", ["a", "b", "c"]],
          ["setBreakpoints", ["a", "c"]],
        ]);
        expect(host.updates).toBe(updates + 2);
      });

      it("logs each of the worker's refusals and keeps the breakpoints", async () => {
        // `setRuntime()` sends the breakpoints too, and that refusal is
        // logged ahead of the later one.

        const { controller } = connectedController();
        controller.setRuntime(
          standInRuntime({
            setBreakpoints: () => Promise.reject(new Error("refused")),
          }).runtime,
        );

        await controller.setBreakpointsForActions(["a"], true);
        expect(controller.getBreakpoints()).toEqual(new Set(["a"]));
        const refusal = [
          "[DebuggerController] Failed to set breakpoints:",
          new Error("refused"),
        ];
        expect(errors).toEqual([refusal, refusal]);
      });

      it("keeps breakpoints set before there is a runtime", async () => {
        const { controller } = connectedController();
        await controller.setBreakpointsForActions(["a"], true);
        expect(controller.getBreakpoints()).toEqual(new Set(["a"]));
      });
    });

    describe("getBreakpoints()", () => {
      it("returns a copy the caller cannot change the breakpoints through", async () => {
        const { controller } = connectedController();
        await controller.setBreakpointsForActions(["a"], true);
        controller.getBreakpoints().add("b");
        expect(controller.getBreakpoints()).toEqual(new Set(["a"]));
      });
    });

    describe("getFlagMetadata()", () => {
      it("returns the metadata of a runner flag, and `null` for anything else", () => {
        const { controller } = connectedController();
        controller.updateFlags({
          runner: { invalid: { x: { reason: "bad" }, y: null } },
          other: { invalid: { z: { reason: "elsewhere" } } },
        });
        expect(controller.getFlagMetadata("invalid", "x")).toEqual({
          reason: "bad",
        });
        expect(controller.getFlagMetadata("invalid", "y")).toBeNull();
        expect(controller.getFlagMetadata("invalid", "z")).toBeNull();
        expect(controller.getFlagMetadata("missing", "x")).toBeNull();
      });

      it("returns `null` when no runner flags are set", () => {
        const { controller } = connectedController();
        expect(controller.getFlagMetadata("invalid", "x")).toBeNull();
      });
    });

    describe("requestFlags()", () => {
      it("logs a failure and keeps the flags it had", async () => {
        const { controller } = connectedController();
        const flags: LoggerFlagsData = { runner: { invalid: { x: null } } };
        controller.updateFlags(flags);
        controller.setRuntime(
          standInRuntime({
            getLoggerCounts: () => Promise.reject(new Error("no counts")),
          }).runtime,
        );

        await controller.requestFlags();
        expect(controller.getActiveFlags()).toBe(flags);
        expect(errors).toEqual([[
          "[DebuggerController] Failed to request flags:",
          new Error("no counts"),
        ]]);
      });

      it("does nothing without a runtime", async () => {
        const { host, controller } = connectedController();
        await controller.requestFlags();
        expect(controller.getActiveFlags()).toEqual({});
        expect(host.updates).toBe(0);
      });
    });

    describe("runDiagnosis()", () => {
      it("reports itself running until the worker's result arrives, then holds it", async () => {
        const { host, controller } = connectedController();
        const durations: (number | undefined)[] = [];
        const result = Promise.withResolvers<SchedulerDiagnosisResult>();
        controller.setRuntime(
          standInRuntime({
            detectNonIdempotent: (durationMs) => {
              durations.push(durationMs);
              return result.promise;
            },
          }).runtime,
        );
        const updates = host.updates;

        const running = controller.runDiagnosis();
        expect(controller.getIsDiagnosing()).toBe(true);
        expect(host.updates).toBe(updates + 1);

        result.resolve(diagnosis);
        await running;
        expect(controller.getIsDiagnosing()).toBe(false);
        expect(controller.getDiagnosisResult()).toBe(diagnosis);
        expect(durations).toEqual([5000]);
        expect(host.updates).toBe(updates + 2);
      });

      it("starts no second diagnosis while one is running", async () => {
        const { controller } = connectedController();
        const durations: (number | undefined)[] = [];
        const result = Promise.withResolvers<SchedulerDiagnosisResult>();
        controller.setRuntime(
          standInRuntime({
            detectNonIdempotent: (durationMs) => {
              durations.push(durationMs);
              return result.promise;
            },
          }).runtime,
        );

        const running = controller.runDiagnosis(100);
        await controller.runDiagnosis(200);
        result.resolve(diagnosis);
        await running;
        expect(durations).toEqual([100]);
      });

      it("logs a failure and drops the previous result", async () => {
        const { controller } = connectedController();
        let fail = false;
        controller.setRuntime(
          standInRuntime({
            detectNonIdempotent: () =>
              fail
                ? Promise.reject(new Error("diagnosis broke"))
                : Promise.resolve(diagnosis),
          }).runtime,
        );
        await controller.runDiagnosis();
        expect(controller.getDiagnosisResult()).toBe(diagnosis);

        fail = true;
        await controller.runDiagnosis();
        expect(controller.getDiagnosisResult()).toBeNull();
        expect(controller.getIsDiagnosing()).toBe(false);
        expect(errors).toEqual([[
          "[DebuggerController] Diagnosis failed:",
          new Error("diagnosis broke"),
        ]]);
      });

      it("does nothing without a runtime", async () => {
        const { host, controller } = connectedController();
        await controller.runDiagnosis();
        expect(controller.getIsDiagnosing()).toBe(false);
        expect(controller.getDiagnosisResult()).toBeNull();
        expect(host.updates).toBe(0);
      });
    });

    describe("setSchedulerBaselineStats()", () => {
      it("replaces the baseline and asks the host to update", () => {
        const { host, controller } = connectedController();
        expect(controller.getSchedulerBaselineStats()).toEqual(new Map());
        const stats = new Map([["a", { runCount: 2, totalTime: 5 }]]);

        controller.setSchedulerBaselineStats(stats);
        expect(controller.getSchedulerBaselineStats()).toBe(stats);
        expect(host.updates).toBe(1);
      });
    });
  });
});
