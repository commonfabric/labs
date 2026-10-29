/**
 * The per-runtime observer behind run_pattern's settle-window reads: piece
 * attribution through the canonical entity hash, the guard against errors
 * that arrive without a pattern frame, the exclusion of busy-window markers
 * that defer nothing, and sequence-scoped windows.
 */

import { describe, it } from "@std/testing/bdd";

import { expect } from "@std/expect";
import { type Runtime, RuntimeTelemetry } from "@commonfabric/runner";
import type { CfcRefusalDetail } from "@commonfabric/runner/cfc";
import {
  comparableEntityHash,
  fabricRuntimeObservations,
} from "../src/fabric-observations.ts";

type ErrorListener = (error: {
  pieceId?: string;
  patternId?: string;
  name?: string;
  message: string;
  refusals?: readonly CfcRefusalDetail[];
}) => void;

/** One writer-fit refusal, as the commit boundary mints it. */
const WRITER_FIT_REFUSAL: CfcRefusalDetail = {
  gate: "writer-fit",
  target: {
    space: "did:key:z6MkTest",
    id: "of:fid1:target",
    scope: "space",
    path: [],
  },
  offendingAtoms: ['"secret"'],
  inputs: [{
    read: {
      space: "did:key:z6MkTest",
      id: "of:fid1:source",
      scope: "space",
      path: ["secret"],
    },
    labelPath: ["secret"],
    atoms: ['"secret"'],
  }],
  attribution: "complete",
  reason: 'writer-fit confidentiality misfit: "secret"',
};

// A stand-in carrying exactly the two surfaces the observer subscribes to.
const stubRuntime = (): {
  runtime: Runtime;
  emitError: ErrorListener;
  telemetry: RuntimeTelemetry;
} => {
  let listener: ErrorListener | undefined;
  const telemetry = new RuntimeTelemetry();
  const runtime = {
    scheduler: {
      onError: (fn: ErrorListener) => {
        listener = fn;
      },
    },
    telemetry,
  } as unknown as Runtime;
  return {
    runtime,
    telemetry,
    emitError: (error) => listener?.(error as Parameters<ErrorListener>[0]),
  };
};

describe("fabric-observations", () => {
  it("attributes errors through the canonical entity hash across the `of:` seam", () => {
    const { runtime, emitError } = stubRuntime();
    const observations = fabricRuntimeObservations(runtime);
    const start = observations.sequence();
    emitError({
      pieceId: "of:fid1:abc",
      patternId: "mod1",
      message: "boom",
    });
    expect(observations.errorsSince(start, "fid1:abc").map((e) => e.message))
      .toEqual(["boom"]);
    expect(observations.errorsSince(start, "fid1:other")).toEqual([]);
  });

  it("carries a commit refusal's structured refusals onto the record", () => {
    const { runtime, emitError } = stubRuntime();
    const observations = fabricRuntimeObservations(runtime);
    const start = observations.sequence();
    emitError({
      pieceId: "of:fid1:abc",
      name: "CfcCommitRefusalError",
      message: "CFC enforcement rejected commit",
      refusals: [WRITER_FIT_REFUSAL],
    });
    expect(observations.errorsSince(start, "fid1:abc")[0]!.refusals)
      .toEqual([WRITER_FIT_REFUSAL]);
  });

  it("leaves `refusals` absent on an error that carries none", () => {
    const { runtime, emitError } = stubRuntime();
    const observations = fabricRuntimeObservations(runtime);
    const start = observations.sequence();
    emitError({ pieceId: "of:fid1:abc", message: "boom" });
    expect(observations.errorsSince(start, "fid1:abc")[0]!).not.toHaveProperty(
      "refusals",
    );
  });

  it("drops an error without a piece id rather than throwing in the handler", () => {
    const { runtime, emitError } = stubRuntime();
    const observations = fabricRuntimeObservations(runtime);
    const start = observations.sequence();
    emitError({ message: "frameless" });
    emitError({ pieceId: "of:fid1:abc", message: "attributed" });
    expect(observations.errorsSince(start, "fid1:abc").map((e) => e.message))
      .toEqual(["attributed"]);
  });

  it("never matches a kinded piece id against its `of:` sibling", () => {
    const { runtime, emitError } = stubRuntime();
    const observations = fabricRuntimeObservations(runtime);
    const start = observations.sequence();
    emitError({ pieceId: "computed:fid1:abc", message: "kinded" });
    expect(observations.errorsSince(start, "fid1:abc")).toEqual([]);
    expect(observations.errorsSince(start, "computed:fid1:abc")).toEqual([]);
  });

  it("records only convergence-budget episodes, not busy-window markers", () => {
    const { runtime, telemetry } = stubRuntime();
    const observations = fabricRuntimeObservations(runtime);
    const start = observations.sequence();
    telemetry.submit({
      type: "scheduler.non-settling",
      busyTime: 0,
      windowDuration: 1,
      busyRatio: 0,
    });
    telemetry.submit({
      type: "scheduler.non-settling",
      busyTime: 0,
      windowDuration: 1,
      busyRatio: 0,
      deferredActionCount: 0,
      deferredActions: [],
    });
    telemetry.submit({
      type: "scheduler.non-settling",
      busyTime: 0,
      windowDuration: 1,
      busyRatio: 0,
      deferredActions: [{
        label: "cf:module/mod1:__cfLift_1:x",
        pieceId: "of:fid1:abc",
      }],
      deferredActionCount: 2,
    });
    const episodes = observations.episodesSince(start);
    expect(episodes.length).toBe(1);
    expect(episodes[0]!.deferredActionCount).toBe(2);
    // The marker's piece id is stored as the comparable entity hash — the
    // same reduction `errorsSince` applies — so a consumer compares hashes,
    // never raw id strings.
    expect(episodes[0]!.deferredActions).toEqual([{
      label: "cf:module/mod1:__cfLift_1:x",
      pieceId: comparableEntityHash("fid1:abc"),
    }]);
  });

  it("records a deferred action without observation identity as label alone", () => {
    const { runtime, telemetry } = stubRuntime();
    const observations = fabricRuntimeObservations(runtime);
    const start = observations.sequence();
    telemetry.submit({
      type: "scheduler.non-settling",
      busyTime: 0,
      windowDuration: 1,
      busyRatio: 0,
      deferredActions: [{ label: "raw:map:abc123" }],
      deferredActionCount: 1,
    });
    expect(observations.episodesSince(start)[0]!.deferredActions).toEqual([
      { label: "raw:map:abc123" },
    ]);
  });

  it("scopes reads to the window after the captured sequence", () => {
    const { runtime, emitError } = stubRuntime();
    const observations = fabricRuntimeObservations(runtime);
    emitError({ pieceId: "of:fid1:abc", message: "before" });
    const start = observations.sequence();
    emitError({ pieceId: "of:fid1:abc", message: "after" });
    expect(observations.errorsSince(start, "fid1:abc").map((e) => e.message))
      .toEqual(["after"]);
  });

  it("returns the same observer for the same runtime", () => {
    const { runtime } = stubRuntime();
    expect(fabricRuntimeObservations(runtime)).toBe(
      fabricRuntimeObservations(runtime),
    );
  });

  it("drops oldest records once the ring buffer is full", () => {
    const { runtime, emitError } = stubRuntime();
    const observations = fabricRuntimeObservations(runtime);
    const start = observations.sequence();
    // One past the 128-record bound: the first record falls off the ring.
    for (let i = 0; i < 129; i++) {
      emitError({ pieceId: "of:fid1:abc", message: `error-${i}` });
    }
    const seen = observations.errorsSince(start, "fid1:abc");
    expect(seen.length).toBe(128);
    expect(seen[0]!.message).toBe("error-1");
    expect(seen.at(-1)!.message).toBe("error-128");
  });

  it("ignores a telemetry event that is not a runtime telemetry event", () => {
    const { runtime, telemetry } = stubRuntime();
    const observations = fabricRuntimeObservations(runtime);
    const start = observations.sequence();
    telemetry.dispatchEvent(new Event("telemetry"));
    expect(observations.episodesSince(start)).toEqual([]);
  });
});
