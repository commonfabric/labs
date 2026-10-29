import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  type PhaseTrace,
  reportCliPhase,
  timeCliPhase,
} from "../lib/trace-timing.ts";

function capturingTrace(enabled: boolean): PhaseTrace & { lines: string[] } {
  const lines: string[] = [];
  return { enabled, lines, log: (line) => lines.push(line) };
}

describe("timeCliPhase", () => {
  it("is the phase itself when tracing is off", async () => {
    const trace = capturingTrace(false);
    const value = await timeCliPhase("quiet", () => Promise.resolve(42), trace);
    expect(value).toBe(42);
    expect(trace.lines).toEqual([]);
  });

  it("reports one [cf-phase] line per phase, elapsed then label", async () => {
    const trace = capturingTrace(true);
    const value = await timeCliPhase("sync.piece", () => "done", trace);
    expect(value).toBe("done");
    expect(trace.lines).toHaveLength(1);
    expect(trace.lines[0]).toMatch(/^\[cf-phase\] \d+ms :: sync\.piece$/);
  });

  it("still reports a phase that threw, and rethrows it", async () => {
    const trace = capturingTrace(true);
    const failure = new Error("storage unreachable");
    await expect(
      timeCliPhase("sync.piece", () => Promise.reject(failure), trace),
    ).rejects.toBe(failure);
    expect(trace.lines).toHaveLength(1);
    expect(trace.lines[0]).toMatch(/:: sync\.piece$/);
  });
});

describe("reportCliPhase", () => {
  it("reports a phase timed elsewhere in whole milliseconds", () => {
    const trace = capturingTrace(true);
    reportCliPhase("newPiece.create.server.instantiate.run", 12.6, trace);
    expect(trace.lines).toEqual([
      "[cf-phase] 13ms :: newPiece.create.server.instantiate.run",
    ]);
  });

  it("reports nothing when tracing is off", () => {
    const trace = capturingTrace(false);
    reportCliPhase("newPiece.create.server.instantiate.run", 12.6, trace);
    expect(trace.lines).toEqual([]);
  });
});
