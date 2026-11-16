import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { FabricValue } from "@commonfabric/data-model";
import {
  captureCommittedReads,
  captureDiagnosisRecord,
  captureTransactionWrites,
  type CausalEdge,
  detectCausalCycles,
  type DiagnosisRecord,
  findDifferingWriteKeys,
  findNonIdempotentPair,
  makeAddressKey,
  runIdempotencyRecheck,
  runSchedulerDiagnosis,
  type SchedulerDiagnosisControlState,
  startSchedulerDiagnosis,
  stopSchedulerDiagnosis,
} from "../src/scheduler/diagnosis.ts";
import {
  type NonIdempotentReport,
  RuntimeTelemetry,
  type RuntimeTelemetryEvent,
  type SchedulerDiagnosisResult,
} from "../src/telemetry.ts";
import type { Action } from "../src/scheduler/types.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
} from "../src/storage/interface.ts";

const SPACE = "did:key:zDiagnosis" as IMemorySpaceAddress["space"];

function address(id: string, path: string[]): IMemorySpaceAddress {
  return { space: SPACE, id: id as IMemorySpaceAddress["id"], path };
}

function record(
  reads: Record<string, FabricValue>,
  writes: Record<string, FabricValue>,
): DiagnosisRecord {
  return {
    readValues: new Map(Object.entries(reads)),
    writeValues: new Map(Object.entries(writes)),
    timestamp: 0,
  };
}

/**
 * Minimal transaction stand-in: it answers the inspection hooks the recheck
 * consults (its reactivity log, its write details, and, when given, its read
 * details) and remembers whether it was aborted.
 */
function fakeTransaction(
  writes: readonly { address: IMemorySpaceAddress; value: FabricValue }[] = [],
  readDetails?: () => readonly {
    address: IMemorySpaceAddress;
    value?: FabricValue;
  }[],
): IExtendedStorageTransaction & { readonly wasAborted: () => boolean } {
  let aborted = false;
  const tx = {
    getReactivityLog: () => ({
      reads: [],
      shallowReads: [],
      writes: writes.map((write) => write.address),
    }),
    getWriteDetails: (space: IMemorySpaceAddress["space"]) =>
      writes.filter((write) => write.address.space === space),
    getReadDetails: readDetails,
    abort: () => {
      aborted = true;
    },
    wasAborted: () => aborted,
  };
  return tx as unknown as
    & IExtendedStorageTransaction
    & { readonly wasAborted: () => boolean };
}

describe("scheduler-diagnosis", () => {
  describe("makeAddressKey", () => {
    it("joins space, id, and path with slashes", () => {
      expect(makeAddressKey(address("of:e1", ["a", "b"]))).toBe(
        "did:key:zDiagnosis/of:e1/a/b",
      );
    });

    it("leaves a trailing slash for an empty path", () => {
      expect(makeAddressKey(address("of:e1", []))).toBe(
        "did:key:zDiagnosis/of:e1/",
      );
    });
  });

  describe("findDifferingWriteKeys", () => {
    it("flags keys present in only one map", () => {
      const previous = new Map<string, FabricValue>([["a", 1]]);
      const latest = new Map<string, FabricValue>([["b", 2]]);
      expect(findDifferingWriteKeys(previous, latest).sort()).toEqual([
        "a",
        "b",
      ]);
    });

    it("flags keys whose value changed and ignores equal values", () => {
      const previous = new Map<string, FabricValue>([["a", 1], ["b", {
        x: 1,
      }]]);
      const latest = new Map<string, FabricValue>([["a", 2], ["b", { x: 1 }]]);
      expect(findDifferingWriteKeys(previous, latest)).toEqual(["a"]);
    });

    it("restricts the compared keys to the latest map when asked", () => {
      const previous = new Map<string, FabricValue>([["a", 1], ["gone", 9]]);
      const latest = new Map<string, FabricValue>([["a", 1], ["b", 2]]);
      // Union counts the key that only the previous map holds; "latest" does not.
      expect(findDifferingWriteKeys(previous, latest).sort()).toEqual([
        "b",
        "gone",
      ]);
      expect(
        findDifferingWriteKeys(previous, latest, { keySet: "latest" }),
      ).toEqual(["b"]);
    });
  });

  describe("findNonIdempotentPair", () => {
    it("returns undefined with fewer than two records", () => {
      expect(findNonIdempotentPair([])).toBeUndefined();
      expect(findNonIdempotentPair([record({ r: 1 }, { w: 1 })]))
        .toBeUndefined();
    });

    it("finds a pair with equal reads but differing writes", () => {
      const previous = record({ r: 1 }, { w: 1 });
      const latest = record({ r: 1 }, { w: 2 });
      const pair = findNonIdempotentPair([previous, latest]);
      expect(pair).toBeDefined();
      expect(pair!.previous).toBe(previous);
      expect(pair!.latest).toBe(latest);
      expect(pair!.differingWriteKeys).toEqual(["w"]);
    });

    it("returns undefined when reads differ between the runs", () => {
      const previous = record({ r: 1 }, { w: 1 });
      const latest = record({ r: 2 }, { w: 2 });
      expect(findNonIdempotentPair([previous, latest])).toBeUndefined();
    });

    it("returns undefined when reads and writes both match", () => {
      const previous = record({ r: 1 }, { w: 1 });
      const latest = record({ r: 1 }, { w: 1 });
      expect(findNonIdempotentPair([previous, latest])).toBeUndefined();
    });
  });

  describe("runIdempotencyRecheck", () => {
    it("returns without a violation and aborts the recheck transaction when the re-invoked action throws", () => {
      const counted = address("of:e1", ["value", "count"]);
      const tx = fakeTransaction([{ address: counted, value: 1 }]);
      const tx2 = fakeTransaction();
      const violations: NonIdempotentReport[] = [];
      let invocations = 0;

      const action: Action = () => {
        invocations++;
        throw new Error("recheck run failed");
      };

      const state = {
        idempotencyViolations: violations,
        createTx: () => tx2 as IExtendedStorageTransaction,
        invoke: (fn: () => unknown) => fn(),
        getActionId: () => "action-1",
        getActionTelemetryInfo: () => undefined,
      };

      expect(() =>
        runIdempotencyRecheck(state, action, tx, {
          reads: [],
          shallowReads: [],
          writes: [counted],
        })
      ).not.toThrow();

      expect(invocations).toBe(1);
      // The first run's write is not evidence of non-idempotency when the
      // second run produced no writes at all.
      expect(violations).toEqual([]);
      expect(tx2.wasAborted()).toBe(true);
    });
  });

  describe("runIdempotencyRecheck() over runs that wrote differently", () => {
    // The first run wrote 1 where the recheck run writes 2, so each case here
    // records a violation unless something else excuses the difference.

    const counted = address("of:e1", ["value", "count"]);
    const input = address("of:input", ["value"]);
    const log = { reads: [input], shallowReads: [], writes: [counted] };

    function recheck(
      action: Action,
      tx: IExtendedStorageTransaction,
      tx2: IExtendedStorageTransaction,
    ): NonIdempotentReport[] {
      const violations: NonIdempotentReport[] = [];
      runIdempotencyRecheck(
        {
          idempotencyViolations: violations,
          createTx: () => tx2,
          invoke: (fn) => fn(),
          getActionId: () => "action-1",
          getActionTelemetryInfo: () => undefined,
        },
        action,
        tx,
        log,
      );
      return violations;
    }

    it("records a violation when the inputs read the same in both runs", () => {
      const tx = fakeTransaction(
        [{ address: counted, value: 1 }],
        () => [{ address: input, value: "same" }],
      );
      const tx2 = fakeTransaction(
        [{ address: counted, value: 2 }],
        () => [{ address: input, value: "same" }],
      );

      const violations = recheck(() => {}, tx, tx2);

      expect(violations.map((v) => v.differingWriteKeys)).toEqual([[
        makeAddressKey(counted),
      ]]);
      expect(violations[0].runs.map((run) => run.writes)).toEqual([
        { [makeAddressKey(counted)]: 1 },
        { [makeAddressKey(counted)]: 2 },
      ]);
      expect(tx2.wasAborted()).toBe(true);
    });

    it("records nothing when another writer moved an input between the runs", () => {
      const tx = fakeTransaction(
        [{ address: counted, value: 1 }],
        () => [{ address: input, value: "before" }],
      );
      const tx2 = fakeTransaction(
        [{ address: counted, value: 2 }],
        () => [{ address: input, value: "after" }],
      );

      expect(recheck(() => {}, tx, tx2)).toEqual([]);
      expect(tx2.wasAborted()).toBe(true);
    });

    it("records a violation when the first run's read values cannot be inspected", () => {
      // With no read values to compare, nothing shows an input moved, so the
      // differing writes stand.
      const tx = fakeTransaction([{ address: counted, value: 1 }], () => {
        throw new Error("read details unavailable");
      });
      const tx2 = fakeTransaction(
        [{ address: counted, value: 2 }],
        () => [{ address: input, value: "after" }],
      );

      const violations = recheck(() => {}, tx, tx2);

      expect(violations.map((v) => v.actionId)).toEqual(["action-1"]);
      expect(tx2.wasAborted()).toBe(true);
    });

    it("records nothing for an action that returns a promise, and aborts the recheck transaction", () => {
      // The rejection the promise carries is swallowed: an unhandled one
      // would fail the test.
      const tx = fakeTransaction(
        [{ address: counted, value: 1 }],
        () => [{ address: input, value: "same" }],
      );
      const tx2 = fakeTransaction(
        [{ address: counted, value: 2 }],
        () => [{ address: input, value: "same" }],
      );

      const violations = recheck(
        () => Promise.reject(new Error("async action failed")),
        tx,
        tx2,
      );

      expect(violations).toEqual([]);
      expect(tx2.wasAborted()).toBe(true);
    });
  });

  describe("captureDiagnosisRecord()", () => {
    const written = address("of:written", ["value"]);
    const read = address("of:read", ["value"]);
    const info = { patternName: "counter-pattern" };
    const action: Action = () => {};

    function diagnosisState() {
      return {
        diagnosisHistory: new Map<string, DiagnosisRecord[]>(),
        diagnosisNonIdempotent: [] as NonIdempotentReport[],
        getActionTelemetryInfo: (target: Action) =>
          target === action ? info : undefined,
      };
    }

    /** Records one run that read `readValue` and wrote `writeValue`. */
    function capture(
      state: ReturnType<typeof diagnosisState>,
      readValue: FabricValue,
      writeValue: FabricValue,
    ): void {
      captureDiagnosisRecord({
        ...state,
        createReadTx: () =>
          ({
            tx: { read: () => ({ ok: { value: readValue } }) },
            abort: () => {},
          }) as unknown as IExtendedStorageTransaction,
      }, {
        actionId: "action-1",
        action,
        tx: fakeTransaction([{ address: written, value: writeValue }]),
        log: { reads: [read], shallowReads: [], writes: [written] },
      });
    }

    it("reports an action whose runs read the same values and wrote different ones", () => {
      const state = diagnosisState();

      capture(state, "in", 1);
      expect(state.diagnosisNonIdempotent).toEqual([]);
      capture(state, "in", 2);

      expect(state.diagnosisNonIdempotent).toEqual([{
        actionId: "action-1",
        actionInfo: info,
        runs: [
          {
            timestamp: expect.any(Number),
            reads: { [makeAddressKey(read)]: "in" },
            writes: { [makeAddressKey(written)]: 1 },
          },
          {
            timestamp: expect.any(Number),
            reads: { [makeAddressKey(read)]: "in" },
            writes: { [makeAddressKey(written)]: 2 },
          },
        ],
        differingWriteKeys: [makeAddressKey(written)],
      }]);
    });

    it("reports an action once however many of its runs differ", () => {
      const state = diagnosisState();

      capture(state, "in", 1);
      capture(state, "in", 2);
      capture(state, "in", 3);

      expect(state.diagnosisNonIdempotent.length).toBe(1);
      expect(
        state.diagnosisNonIdempotent[0].runs.map((run) => run.writes),
      ).toEqual([
        { [makeAddressKey(written)]: 1 },
        { [makeAddressKey(written)]: 2 },
      ]);
    });

    it("reports nothing when runs that read the same values wrote the same values", () => {
      const state = diagnosisState();

      capture(state, "in", 1);
      capture(state, "in", 1);

      expect(state.diagnosisNonIdempotent).toEqual([]);
      expect(state.diagnosisHistory.get("action-1")?.length).toBe(2);
    });

    it("keeps only the ten most recent runs of an action", () => {
      const state = diagnosisState();

      for (let run = 1; run <= 11; run++) capture(state, `in-${run}`, run);

      const history = state.diagnosisHistory.get("action-1") ?? [];
      expect(
        history.map((record) => record.readValues.get(makeAddressKey(read))),
      ).toEqual([
        "in-2",
        "in-3",
        "in-4",
        "in-5",
        "in-6",
        "in-7",
        "in-8",
        "in-9",
        "in-10",
        "in-11",
      ]);
      // Every run read something different, so none is a finding.
      expect(state.diagnosisNonIdempotent).toEqual([]);
    });
  });

  describe("a diagnosis run", () => {
    // `runSchedulerDiagnosis()` starts a diagnosis that stops on its own once
    // its duration has elapsed, and resolves with what it collected. The
    // timer is the runtime's own, so the package's clock advances to it as
    // soon as the test awaits.

    function controlState() {
      let enabled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let startTime = 0;
      let busyTime = 0;
      let resolve: ((result: SchedulerDiagnosisResult) => void) | null = null;
      const telemetry = new RuntimeTelemetry();
      const markers: unknown[] = [];
      telemetry.addEventListener("telemetry", (event) => {
        markers.push((event as RuntimeTelemetryEvent).detail.marker);
      });
      const state: SchedulerDiagnosisControlState = {
        telemetry,
        getDiagnosisEnabled: () => enabled,
        setDiagnosisEnabled: (value) => {
          enabled = value;
        },
        getDiagnosisTimeout: () => timeout,
        setDiagnosisTimeout: (value) => {
          timeout = value;
        },
        getDiagnosisStartTime: () => startTime,
        setDiagnosisStartTime: (value) => {
          startTime = value;
        },
        getDiagnosisBusyTime: () => busyTime,
        setDiagnosisBusyTime: (value) => {
          busyTime = value;
        },
        getDiagnosisResolve: () => resolve,
        setDiagnosisResolve: (value) => {
          resolve = value;
        },
        diagnosisHistory: new Map(),
        diagnosisNonIdempotent: [],
        causalEdges: [],
        idempotencyViolations: [],
        computations: new Set(),
        setIdempotencyCheckMode: () => {},
        runAction: () => Promise.resolve(),
      };
      return { state, markers };
    }

    const edge = (writer: string, triggered: string): CausalEdge => ({
      writer,
      triggered,
      cell: `of:${writer}`,
      timestamp: 0,
    });

    it("resolves with the cycles, findings and busy time it saw once its duration elapses", async () => {
      const { state, markers } = controlState();

      const result = runSchedulerDiagnosis(state, 1000);
      expect(state.getDiagnosisEnabled()).toBe(true);
      expect(markers).toEqual([
        { type: "scheduler.diagnosis.start", durationMs: 1000 },
      ]);
      const finding: NonIdempotentReport = {
        actionId: "a",
        runs: [],
        differingWriteKeys: ["k"],
      };
      state.diagnosisNonIdempotent.push(finding);
      state.diagnosisHistory.set("a", [record({}, {})]);
      state.causalEdges.push(edge("a", "b"), edge("b", "a"));
      state.setDiagnosisBusyTime(250);

      expect(await result).toEqual({
        nonIdempotent: [finding],
        cycles: [{
          cycle: [
            { actionId: "a", writesCell: "of:a" },
            { actionId: "b", writesCell: "of:b" },
          ],
          timestamp: expect.any(Number),
        }],
        duration: 1000,
        busyTime: 250,
      });
      expect(state.getDiagnosisEnabled()).toBe(false);
      expect(state.getDiagnosisTimeout()).toBe(null);
      expect(state.diagnosisHistory.size).toBe(0);
      expect(state.causalEdges).toEqual([]);
    });

    it("resolves early, with its timer cleared, when stopped", async () => {
      const { state } = controlState();

      const result = runSchedulerDiagnosis(state, 1000);
      expect(state.getDiagnosisTimeout()).not.toBe(null);
      stopSchedulerDiagnosis(state);

      expect((await result).duration).toBe(0);
      expect(state.getDiagnosisEnabled()).toBe(false);
      expect(state.getDiagnosisTimeout()).toBe(null);
    });

    it("leaves the state alone when stopped while no diagnosis runs", () => {
      const { state } = controlState();
      state.causalEdges.push(edge("a", "b"));

      stopSchedulerDiagnosis(state);

      expect(state.causalEdges).toEqual([edge("a", "b")]);
      expect(state.getDiagnosisEnabled()).toBe(false);
    });

    it("ends a diagnosis already running before starting the next", async () => {
      const { state, markers } = controlState();

      const first = runSchedulerDiagnosis(state, 1000);
      state.causalEdges.push(edge("a", "a"));
      const second = runSchedulerDiagnosis(state, 2000);

      expect((await first).cycles.map((c) => c.cycle)).toEqual([[
        { actionId: "a", writesCell: "of:a" },
      ]]);
      expect(state.getDiagnosisEnabled()).toBe(true);
      expect(state.causalEdges).toEqual([]);
      expect(markers).toEqual([
        { type: "scheduler.diagnosis.start", durationMs: 1000 },
        { type: "scheduler.diagnosis.start", durationMs: 2000 },
      ]);
      expect((await second).duration).toBe(2000);
    });

    it("ignores a start while a diagnosis is running", async () => {
      const { state, markers } = controlState();

      const result = runSchedulerDiagnosis(state, 1000);
      startSchedulerDiagnosis(state, 5000);

      expect(markers.length).toBe(1);
      expect((await result).duration).toBe(1000);
    });
  });

  describe("captureTransactionWrites", () => {
    it("records only the addresses the transaction has novelty for", () => {
      const written = address("of:written", ["value"]);
      const touched = address("of:touched", ["value"]);
      const tx = fakeTransaction([{ address: written, value: "new" }]);

      const values = captureTransactionWrites(tx, [written, touched]);

      // A write log entry with no novelty behind it is a no-op write or a
      // materialization touch, and recording it would read as a differing
      // write when the computation's output did not change.
      expect([...values.keys()]).toEqual([makeAddressKey(written)]);
      expect(values.get(makeAddressKey(written))).toBe("new");
    });

    it("reads each space's write details once for many addresses", () => {
      const first = address("of:first", ["value"]);
      const second = address("of:second", ["value"]);
      let detailReads = 0;
      const tx = {
        getWriteDetails: (space: IMemorySpaceAddress["space"]) => {
          detailReads++;
          return [
            { address: first, value: "a" },
            { address: second, value: "b" },
          ].filter((write) => write.address.space === space);
        },
      } as unknown as IExtendedStorageTransaction;

      const values = captureTransactionWrites(tx, [first, second]);

      expect(values.size).toBe(2);
      expect(detailReads).toBe(1);
    });

    it("substitutes the error value for a space it cannot read", () => {
      const target = address("of:unreadable", ["value"]);
      const tx = {
        getWriteDetails: () => {
          throw new Error("details unavailable");
        },
      } as unknown as IExtendedStorageTransaction;

      const values = captureTransactionWrites(tx, [target], {
        errorValue: "[write-error]",
      });

      expect(values.get(makeAddressKey(target))).toBe("[write-error]");
    });

    it("rethrows when no error value is offered", () => {
      const target = address("of:unreadable", ["value"]);
      const tx = {
        getWriteDetails: () => {
          throw new Error("details unavailable");
        },
      } as unknown as IExtendedStorageTransaction;

      expect(() => captureTransactionWrites(tx, [target])).toThrow(
        "details unavailable",
      );
    });
  });

  describe("captureCommittedReads", () => {
    /** A read-only transaction stand-in that answers one address. */
    function readerFor(
      answer: (path: readonly string[]) => { ok?: { value: FabricValue } },
      onAbort: () => void,
    ): IExtendedStorageTransaction {
      return {
        tx: {
          read: (addr: { path: readonly string[] }) => answer(addr.path),
        },
        abort: onAbort,
      } as unknown as IExtendedStorageTransaction;
    }

    it("returns the value each address read", () => {
      const target = address("of:read", ["value"]);
      const values = captureCommittedReads(
        [target],
        () => readerFor(() => ({ ok: { value: "committed" } }), () => {}),
      );

      expect(values.get(makeAddressKey(target))).toBe("committed");
    });

    it("records nothing of a runtime secret's value", () => {
      const secret = address("of:runtime-secret:salt", ["value"]);
      const values = captureCommittedReads(
        [secret],
        () => readerFor(() => ({ ok: { value: "the salt" } }), () => {}),
      );

      expect(values.has(makeAddressKey(secret))).toBe(false);
    });

    it("records a read of a runtime secret's label envelope", () => {
      const envelope = address("of:runtime-secret:salt", ["cfc"]);
      const values = captureCommittedReads(
        [envelope],
        () => readerFor(() => ({ ok: { value: "the envelope" } }), () => {}),
      );

      expect(values.get(makeAddressKey(envelope))).toBe("the envelope");
    });

    it("marks an address whose read threw", () => {
      const target = address("of:throws", ["value"]);
      const values = captureCommittedReads(
        [target],
        () =>
          readerFor(() => {
            throw new Error("read failed");
          }, () => {}),
      );

      expect(values.get(makeAddressKey(target))).toBe("[read-error]");
    });

    it("aborts every transaction it opened, including one that threw", () => {
      const ok = address("of:ok", ["value"]);
      const bad = address("of:bad", ["value"]);
      let aborts = 0;
      captureCommittedReads([ok, bad], () =>
        readerFor((path) => {
          if (path[0] === "value" && aborts === 1) throw new Error("read");
          return { ok: { value: "v" } };
        }, () => {
          aborts++;
        }));

      expect(aborts).toBe(2);
    });

    it("records an absent read as undefined rather than skipping it", () => {
      const target = address("of:absent", ["value"]);
      const values = captureCommittedReads(
        [target],
        () => readerFor(() => ({}), () => {}),
      );

      expect(values.has(makeAddressKey(target))).toBe(true);
      expect(values.get(makeAddressKey(target))).toBe(undefined);
    });
  });

  describe("detectCausalCycles", () => {
    const edge = (writer: string, triggered: string, cell: string) => ({
      writer,
      triggered,
      cell,
    });

    it("returns nothing for a graph that does not come back on itself", () => {
      expect(detectCausalCycles([
        edge("a", "b", "of:x"),
        edge("b", "c", "of:y"),
      ])).toEqual([]);
    });

    it("returns nothing for no edges at all", () => {
      expect(detectCausalCycles([])).toEqual([]);
    });

    it("reports an action that triggers itself", () => {
      const cycles = detectCausalCycles([edge("a", "a", "of:self")]);

      expect(cycles.length).toBe(1);
      expect(cycles[0].cycle).toEqual([{
        actionId: "a",
        writesCell: "of:self",
      }]);
    });

    it("reports a cycle across two actions, naming the cell each writes", () => {
      const cycles = detectCausalCycles([
        edge("a", "b", "of:x"),
        edge("b", "a", "of:y"),
      ]);

      expect(cycles.length).toBe(1);
      expect(cycles[0].cycle).toEqual([
        { actionId: "a", writesCell: "of:x" },
        { actionId: "b", writesCell: "of:y" },
      ]);
    });

    it("reports a cycle reached through a node outside it", () => {
      // `entry` leads into the loop without being part of it, so the reported
      // cycle starts where the loop closes rather than where the walk began.
      const cycles = detectCausalCycles([
        edge("entry", "a", "of:in"),
        edge("a", "b", "of:x"),
        edge("b", "a", "of:y"),
      ]);

      expect(cycles.length).toBe(1);
      expect(cycles[0].cycle.map((step) => step.actionId)).toEqual(["a", "b"]);
    });

    it("reports a cycle once when two paths lead into it", () => {
      // `left` and `right` both reach `a`; the walk from `right` finds `a`
      // already visited rather than walking into the loop a second time.
      const cycles = detectCausalCycles([
        edge("root", "left", "of:l"),
        edge("root", "right", "of:r"),
        edge("left", "a", "of:la"),
        edge("right", "a", "of:ra"),
        edge("a", "b", "of:x"),
        edge("b", "a", "of:y"),
      ]);

      expect(cycles.map((c) => c.cycle.map((step) => step.actionId)))
        .toEqual([["a", "b"]]);
    });

    it("reports each of two independent cycles", () => {
      const cycles = detectCausalCycles([
        edge("a", "b", "of:x"),
        edge("b", "a", "of:y"),
        edge("c", "d", "of:p"),
        edge("d", "c", "of:q"),
      ]);

      expect(cycles.length).toBe(2);
      expect(cycles.map((c) => c.cycle[0].actionId).sort()).toEqual(["a", "c"]);
    });
  });
});
