import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { LogCounts, LoggerBreakdown } from "@commonfabric/logger";
import type {
  CDFPoint,
  RuntimeTelemetryMarkerResult,
  TimingStats,
} from "@commonfabric/runtime-client";

import {
  activeSubtopicCount,
  allSubtopics,
  cdfChart,
  cdfChartTooltip,
  chartedOperations,
  countsTotal,
  cumulativePoints,
  eventColor,
  eventDetails,
  eventIcon,
  filterEvents,
  formatDuration,
  formatTimestamp,
  matchesActiveTopics,
  matchesSearch,
  mergeLoggerCounts,
  mergeLoggerTiming,
  messageCountsByTotal,
  subtopicKeys,
  toggleAllTopics,
  toggleMember,
  toggleTopic,
  topicState,
} from "../src/lib/debugger-view-model.ts";

/** Timing statistics over `cdf`, with every summary figure 0 but `count`. */
function timingStats(
  cdf: CDFPoint[],
  overrides: Partial<TimingStats> = {},
): TimingStats {
  return {
    count: cdf.length,
    min: 0,
    max: 0,
    totalTime: 0,
    average: 0,
    p50: 0,
    p95: 0,
    lastTime: 0,
    lastTimestamp: 0,
    slowest: [],
    cdf,
    cdfSinceBaseline: null,
    ...overrides,
  };
}

/** Samples at each latency, with the fraction at or below it. */
function samples(...latencies: number[]): CDFPoint[] {
  return latencies.map((x, i) => ({ x, y: (i + 1) / latencies.length }));
}

/** A breakdown of one logger, from per-message `[debug, info, warn, error]`. */
function breakdown(
  messages: Record<string, [number, number, number, number]>,
): LoggerBreakdown {
  const counts: Record<string, LogCounts> = {};
  let total = 0;
  for (const [key, [debug, info, warn, error]] of Object.entries(messages)) {
    const messageTotal = debug + info + warn + error;
    counts[key] = { debug, info, warn, error, total: messageTotal };
    total += messageTotal;
  }
  return Object.assign(counts, { total });
}

describe("debugger-view-model", () => {
  describe("subtopicKeys()", () => {
    it("returns the topic's subtopics qualified by the topic", () => {
      expect(subtopicKeys("storage")).toEqual(["storage.push", "storage.pull"]);
      expect(subtopicKeys("cells")).toEqual(["cells.update"]);
    });
  });

  describe("allSubtopics()", () => {
    it("returns every subtopic of every topic", () => {
      expect([...allSubtopics()]).toEqual([
        "scheduler.run",
        "scheduler.invocation",
        "storage.push",
        "storage.pull",
        "cells.update",
      ]);
    });
  });

  describe("topicState()", () => {
    it("returns `active` when every subtopic of the topic is kept", () => {
      expect(topicState(allSubtopics(), "storage")).toBe("active");
    });

    it("returns `partial` when some of the topic's subtopics are kept", () => {
      expect(topicState(new Set(["storage.pull"]), "storage")).toBe("partial");
    });

    it("returns `inactive` when only other topics' subtopics are kept", () => {
      expect(topicState(new Set(["scheduler.run"]), "storage")).toBe(
        "inactive",
      );
    });
  });

  describe("activeSubtopicCount()", () => {
    it("returns how many of the topic's subtopics are kept, ignoring other topics'", () => {
      const active = new Set(["storage.pull", "scheduler.run"]);
      expect(activeSubtopicCount(active, "storage")).toBe(1);
      expect(activeSubtopicCount(active, "cells")).toBe(0);
    });
  });

  describe("toggleTopic()", () => {
    it("adds every subtopic of a topic none of which is kept, leaving the rest", () => {
      const active = new Set(["cells.update"]);
      expect([...toggleTopic(active, "storage")]).toEqual([
        "cells.update",
        "storage.push",
        "storage.pull",
      ]);
      expect([...active]).toEqual(["cells.update"]);
    });

    it("removes every subtopic of a topic some of which is kept", () => {
      const active = new Set(["cells.update", "storage.pull"]);
      expect([...toggleTopic(active, "storage")]).toEqual(["cells.update"]);
    });
  });

  describe("toggleAllTopics()", () => {
    it("returns an empty filter when anything is kept", () => {
      expect(toggleAllTopics(new Set(["cells.update"])).size).toBe(0);
    });

    it("returns every subtopic when nothing is kept", () => {
      expect(toggleAllTopics(new Set())).toEqual(allSubtopics());
    });
  });

  describe("toggleMember()", () => {
    it("returns a copy with an absent member added", () => {
      const set = new Set([1]);
      expect([...toggleMember(set, 2)]).toEqual([1, 2]);
      expect([...set]).toEqual([1]);
    });

    it("returns a copy with a present member removed", () => {
      expect([...toggleMember(new Set([1, 2]), 1)]).toEqual([2]);
    });
  });

  describe("eventIcon()", () => {
    it("returns the icon of the topic whose subtopic prefixes the type", () => {
      expect(eventIcon("storage.pull.complete")).toBe("💾");
      expect(eventIcon("cell.update")).toBe("📝");
    });

    it("returns the default icon for a type no topic matches", () => {
      expect(eventIcon("cfc.prepare-reject")).toBe("📊");
    });
  });

  describe("eventColor()", () => {
    it("returns the color of the topic whose subtopic prefixes the type", () => {
      expect(eventColor("scheduler.invocation")).toBe("#3b82f6");
    });

    it("returns the default color for a type no topic matches", () => {
      expect(eventColor("scheduler.subscribe")).toBe("#64748b");
    });
  });

  describe("matchesActiveTopics()", () => {
    it("returns `true` when a kept subtopic prefixes the type", () => {
      expect(
        matchesActiveTopics(new Set(["storage.pull"]), "storage.pull.start"),
      )
        .toBe(true);
    });

    it("returns `false` when the subtopic prefixing the type is not kept", () => {
      expect(
        matchesActiveTopics(new Set(["storage.push"]), "storage.pull.start"),
      )
        .toBe(false);
    });

    it("returns `false` for a type no subtopic prefixes, whatever is kept", () => {
      expect(matchesActiveTopics(allSubtopics(), "cfc.prepare-reject")).toBe(
        false,
      );
    });
  });

  describe("matchesSearch()", () => {
    const marker: RuntimeTelemetryMarkerResult = {
      type: "storage.pull.start",
      id: "Pull-Seven",
      operation: "sync",
      timeStamp: 1,
    };

    it("returns `true` for an empty search", () => {
      expect(matchesSearch(marker, "")).toBe(true);
    });

    it("returns `true` when the rendered event holds the search in another case", () => {
      expect(matchesSearch(marker, "pull-SEVEN")).toBe(true);
    });

    it("returns `false` when the rendered event does not hold the search", () => {
      expect(matchesSearch(marker, "pull-eight")).toBe(false);
    });

    it("returns `true` for the name of a function the event holds", () => {
      // A function is rendered by its name, so that a search finds an action
      // an event carries.

      const withHandler = Object.assign(
        { ...marker },
        { handler: function flushOutbox() {} },
      );
      expect(matchesSearch(withHandler, "flushoutbox")).toBe(true);
    });
  });

  describe("filterEvents()", () => {
    it("returns the events both the topic filter and the search keep, in order", () => {
      const markers: RuntimeTelemetryMarkerResult[] = [
        { type: "storage.pull.start", id: "a", operation: "x", timeStamp: 1 },
        { type: "scheduler.run", actionId: "keep-me", timeStamp: 2 },
        { type: "scheduler.run", actionId: "other", timeStamp: 3 },
        { type: "storage.pull.error", id: "keep-me", error: "e", timeStamp: 4 },
      ];
      const active = new Set(["scheduler.run", "storage.pull"]);
      expect(filterEvents(markers, active, "keep-me").map((m) => m.timeStamp))
        .toEqual([2, 4]);
      expect(
        filterEvents(markers, new Set(["scheduler.run"]), "keep-me").map((m) =>
          m.timeStamp
        ),
      ).toEqual([2]);
    });
  });

  describe("formatTimestamp()", () => {
    it("returns the local clock time with the milliseconds padded to three digits", () => {
      const timestamp = Date.UTC(2026, 0, 2, 3, 4, 5, 7);
      expect(formatTimestamp(timestamp)).toBe(
        `${new Date(timestamp).toLocaleTimeString()}.007`,
      );
    });
  });

  describe("eventDetails()", () => {
    it("returns a scheduler run's action and what its info says", () => {
      expect(eventDetails({
        type: "scheduler.run",
        actionId: "action-1",
        actionInfo: {
          patternName: "Counter",
          moduleName: "counter.tsx",
          reads: ["a", "b"],
          writes: ["c"],
        },
        timeStamp: 1,
      })).toEqual([
        { label: "action", value: "action-1", isError: false },
        { label: "pattern", value: "Counter", isError: false },
        { label: "module", value: "counter.tsx", isError: false },
        { label: "reads", value: "2 dependencies", isError: false },
        { label: "writes", value: "1 outputs", isError: false },
      ]);
    });

    it("returns an invocation's handler, leaves out empty reads and writes, and marks its error", () => {
      expect(eventDetails({
        type: "scheduler.invocation",
        handlerId: "handler-1",
        handlerInfo: { reads: [], writes: [] },
        error: "boom",
        timeStamp: 1,
      })).toEqual([
        { label: "handler", value: "handler-1", isError: false },
        { label: "error", value: "boom", isError: true },
      ]);
    });

    it("returns a cell update's address and that the cell was updated", () => {
      expect(eventDetails({
        type: "cell.update",
        change: {
          address: {
            id: "of:cell-1",
            type: "application/json",
            path: ["items", "0"],
          },
          before: 1,
          after: 2,
        },
        timeStamp: 1,
      })).toEqual([
        { label: "cell", value: "of:cell-1", isError: false },
        { label: "path", value: "items/0", isError: false },
        { label: "type", value: "application/json", isError: false },
        { label: "change", value: "updated", isError: false },
      ]);
    });

    it("returns `created` for a cell with no value before, and `deleted` for one with none after", () => {
      const details = (before: number | undefined, after: number | undefined) =>
        eventDetails({
          type: "cell.update",
          change: { address: { id: "of:cell-1", path: [] }, before, after },
          timeStamp: 1,
        });
      expect(details(undefined, 1)).toEqual([
        { label: "cell", value: "of:cell-1", isError: false },
        { label: "path", value: "", isError: false },
        { label: "change", value: "created", isError: false },
      ]);
      expect(details(1, undefined).at(-1)?.value).toBe("deleted");
    });

    it("returns each other field of any other event, skipping an absent one", () => {
      expect(eventDetails({
        type: "scheduler.non-settling",
        busyTime: 12,
        windowDuration: 100,
        busyRatio: 0.12,
        deferredActions: [{ label: "slow" }],
        deferredActionCount: undefined,
        timeStamp: 1,
      })).toEqual([
        { label: "busyTime", value: "12", isError: false },
        { label: "windowDuration", value: "100", isError: false },
        { label: "busyRatio", value: "0.12", isError: false },
        {
          label: "deferredActions",
          value: '[{label:"slow"}]',
          isError: false,
        },
      ]);
      expect(eventDetails({
        type: "scheduler.subscribe",
        actionId: "a",
        isEffect: false,
        timeStamp: 1,
      })).toEqual([
        { label: "actionId", value: "a", isError: false },
        { label: "isEffect", value: "false", isError: false },
      ]);
    });
  });

  describe("countsTotal()", () => {
    it("returns the grand total, or 0 for no counts", () => {
      expect(countsTotal({ total: 7 })).toBe(7);
      expect(countsTotal(null)).toBe(0);
    });
  });

  describe("mergeLoggerCounts()", () => {
    it("returns the main thread's counts unchanged when the worker has none", () => {
      const main = { total: 3, a: 3 };
      expect(mergeLoggerCounts(main, null)).toBe(main);
    });

    it("adds the two sides logger by logger and message by message", () => {
      const merged = mergeLoggerCounts(
        {
          total: 10,
          shared: breakdown({ hit: [1, 1, 0, 0], mainOnly: [0, 2, 0, 0] }),
          mainLogger: breakdown({ m: [1, 0, 0, 0] }),
          bare: 2,
        },
        {
          total: 6,
          shared: breakdown({ hit: [0, 1, 1, 1] }),
          workerLogger: breakdown({ w: [0, 0, 0, 1] }),
          bare: 3,
        },
      );
      expect(merged).toEqual({
        shared: {
          total: 7,
          hit: { debug: 1, info: 2, warn: 1, error: 1, total: 5 },
          mainOnly: { debug: 0, info: 2, warn: 0, error: 0, total: 2 },
        },
        mainLogger: breakdown({ m: [1, 0, 0, 0] }),
        workerLogger: breakdown({ w: [0, 0, 0, 1] }),
        bare: 5,
        total: 16,
      });
    });

    it("counts a bare count against a breakdown as 0", () => {
      expect(
        mergeLoggerCounts({ total: 0, x: 4 }, {
          total: 0,
          x: breakdown({ m: [1, 0, 0, 0] }),
        }).x,
      ).toBe(4);
    });
  });

  describe("mergeLoggerTiming()", () => {
    it("returns the main thread's timing unchanged when the worker has none", () => {
      const main = { a: { op: timingStats([]) } };
      expect(mergeLoggerTiming(main, null)).toBe(main);
    });

    it("takes a logger only one side times whole, and the worker's statistics for an operation both time", () => {
      const mainOp = timingStats([], { count: 1 });
      const workerOp = timingStats([], { count: 2 });
      const merged = mergeLoggerTiming(
        {
          shared: { op: mainOp, mainOnly: mainOp },
          mainLogger: { op: mainOp },
        },
        { shared: { op: workerOp }, workerLogger: { op: workerOp } },
      );
      expect(merged).toEqual({
        shared: { op: workerOp, mainOnly: mainOp },
        mainLogger: { op: mainOp },
        workerLogger: { op: workerOp },
      });
    });
  });

  describe("messageCountsByTotal()", () => {
    it("returns each message's counts, the busiest first, without the logger total", () => {
      const counts = breakdown({ quiet: [1, 0, 0, 0], busy: [0, 5, 0, 0] });
      expect(messageCountsByTotal(counts).map(([key]) => key)).toEqual([
        "busy",
        "quiet",
      ]);
    });
  });

  describe("chartedOperations()", () => {
    it("returns the operations with samples, the most often timed first", () => {
      const charted = chartedOperations({
        rare: timingStats(samples(1), { count: 1 }),
        empty: timingStats([], { count: 9 }),
        common: timingStats(samples(1, 2), { count: 5 }),
      });
      expect(charted.map(([key]) => key)).toEqual(["common", "rare"]);
    });
  });

  describe("formatDuration()", () => {
    it("returns microseconds below a millisecond, milliseconds below a second, and seconds above", () => {
      expect(formatDuration(0.25)).toBe("250μs");
      expect(formatDuration(12.34)).toBe("12.3ms");
      expect(formatDuration(1500)).toBe("1.50s");
    });
  });

  describe("cumulativePoints()", () => {
    it("returns the samples by latency, each with the time of it and every faster one", () => {
      expect(cumulativePoints(samples(3, 1, 2))).toEqual([
        {
          latency: 1,
          cumulativeTime: 1,
          eventIndex: 1,
          normalizedPosition: 1 / 3,
        },
        {
          latency: 2,
          cumulativeTime: 3,
          eventIndex: 2,
          normalizedPosition: 2 / 3,
        },
        { latency: 3, cumulativeTime: 6, eventIndex: 3, normalizedPosition: 1 },
      ]);
    });
  });

  describe("cdfChart()", () => {
    // The plot runs from x = 60 to 550 and from y = 160 (no time) up to
    // y = 25 (the curve's total time).

    it("returns the curve through every sample, scaled to fill the plot", () => {
      const chart = cdfChart(timingStats(samples(10, 30), { average: 28 }));
      expect(chart.maxTime).toBe(40);
      expect(chart.path).toBe("M 305 126.25 L 550 25");
      expect(chart.xTicks).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
      expect(chart.yTicks).toEqual([0, 8, 16, 24, 32, 40]);
      expect(chart.averagePosition).toBe(1);
      expect(chart.baselinePoints).toBeNull();
      expect(chart.baselinePath).toBeNull();
    });

    it("returns a baseline curve on its own scale when there is a baseline", () => {
      const chart = cdfChart(
        timingStats(samples(10, 30), { cdfSinceBaseline: samples(5) }),
      );
      expect(chart.maxBaselineTime).toBe(5);
      expect(chart.baselinePath).toBe("M 550 25");
      expect(chart.yTicks.at(-1)).toBe(40);
    });

    it("returns an empty baseline path when no sample has arrived since the baseline", () => {
      const chart = cdfChart(
        timingStats(samples(10), { cdfSinceBaseline: [] }),
      );
      expect(chart.baselinePoints).toEqual([]);
      expect(chart.baselinePath).toBe("");
      expect(chart.maxBaselineTime).toBe(chart.maxTime);
    });

    it("returns the middle as the average position when there are no samples", () => {
      const chart = cdfChart(timingStats([]));
      expect(chart.averagePosition).toBe(0.5);
      expect(chart.maxTime).toBe(0.001);
    });
  });

  describe("cdfChartTooltip()", () => {
    const chart = cdfChart(
      timingStats(samples(10, 30), { cdfSinceBaseline: samples(5) }),
    );

    it("returns `null` for a pointer outside the plot", () => {
      expect(cdfChartTooltip(chart, 30, 100, 600, 200)).toBeNull();
      expect(cdfChartTooltip(chart, 300, 190, 600, 200)).toBeNull();
    });

    it("returns `null` for a pointer near neither curve", () => {
      expect(cdfChartTooltip(chart, 100, 150, 600, 200)).toBeNull();
    });

    it("returns the nearest point of the main curve alone when only it is in reach", () => {
      expect(cdfChartTooltip(chart, 305, 126, 600, 200)).toBe(
        "All time: 10.0ms\n  Cumulative: 10.0ms\n  Event #1",
      );
    });

    it("returns both curves' nearest points when both are in reach", () => {
      expect(cdfChartTooltip(chart, 548, 27, 600, 200)).toBe(
        "All time: 30.0ms\n  Cumulative: 40.0ms\n  Event #2\n\n" +
          "Since baseline: 5.0ms\n  Cumulative: 5.0ms\n  Event #1",
      );
    });
  });
});
