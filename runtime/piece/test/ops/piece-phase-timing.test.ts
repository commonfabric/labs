import { expect } from "@std/expect";
import { getLogger } from "@commonfabric/logger";
import { stub } from "@std/testing/mock";
import { describe, it } from "@commonfabric/test-support/test";
import {
  type PhaseTrace,
  piecePhaseTrace,
  timePiecePhase,
} from "../../src/ops/piece-phase-timing.ts";

/** A trace that keeps the lines written to it. */
function recordingTrace(enabled: boolean): PhaseTrace & {
  lines: string[];
} {
  const lines: string[] = [];
  return { enabled, lines, log: (line) => lines.push(line) };
}

/** How many phases named `label` the `piece` logger's timing stats hold. */
function phasesTimed(label: string): number {
  return getLogger("piece").timeStats[`phase/${label}`]?.count ?? 0;
}

describe("piece-phase-timing", () => {
  describe("piecePhaseTrace", () => {
    it("writes each line to whichever console.error is in place when the line is written", () => {
      const first: unknown[][] = [];
      const second: unknown[][] = [];

      {
        using _error = stub(console, "error", (...parts) => first.push(parts));
        piecePhaseTrace.log("[piece-phase] 3ms :: open.sync");
      }
      {
        using _error = stub(console, "error", (...parts) => second.push(parts));
        piecePhaseTrace.log("[piece-phase] 5ms :: open.start");
      }

      expect(first).toEqual([["[piece-phase] 3ms :: open.sync"]]);
      expect(second).toEqual([["[piece-phase] 5ms :: open.start"]]);
    });
  });

  describe("timePiecePhase()", () => {
    it("resolves with what the phase returns, and writes one line naming the phase to an enabled trace", async () => {
      const trace = recordingTrace(true);

      expect(await timePiecePhase("open.sync", () => 7, trace)).toBe(7);

      expect(trace.lines).toHaveLength(1);
      expect(trace.lines[0]).toMatch(/^\[piece-phase\] \d+ms :: open\.sync$/);
    });

    it("writes the line for a phase that throws, and rethrows what it threw", async () => {
      const trace = recordingTrace(true);

      await expect(
        timePiecePhase(
          "open.start",
          () => Promise.reject(new Error("start refused")),
          trace,
        ),
      ).rejects.toThrow("start refused");

      expect(trace.lines).toHaveLength(1);
      expect(trace.lines[0]).toMatch(/^\[piece-phase\] \d+ms :: open\.start$/);
    });

    it("writes nothing to a disabled trace", async () => {
      const trace = recordingTrace(false);

      expect(
        await timePiecePhase("open.sync", () => Promise.resolve("done"), trace),
      ).toBe("done");

      expect(trace.lines).toEqual([]);
    });

    it("records each phase under its own label in the `piece` logger's timing stats, with the trace disabled", async () => {
      const before = {
        returned: phasesTimed("stats.returned"),
        threw: phasesTimed("stats.threw"),
        other: phasesTimed("stats.other"),
      };

      await timePiecePhase("stats.returned", () => 1, recordingTrace(false));
      await timePiecePhase(
        "stats.threw",
        () => Promise.reject(new Error("refused")),
        recordingTrace(false),
      ).catch(() => {});

      expect({
        returned: phasesTimed("stats.returned"),
        threw: phasesTimed("stats.threw"),
        other: phasesTimed("stats.other"),
      }).toEqual({
        returned: before.returned + 1,
        threw: before.threw + 1,
        other: before.other,
      });
    });
  });
});
