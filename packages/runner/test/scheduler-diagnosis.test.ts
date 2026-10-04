import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { FabricValue } from "@commonfabric/data-model";
import {
  captureCommittedReads,
  captureTransactionWrites,
  detectCausalCycles,
  type DiagnosisRecord,
  findDifferingWriteKeys,
  findNonIdempotentPair,
  makeAddressKey,
  parseAddressKey,
  runIdempotencyRecheck,
} from "../src/scheduler/diagnosis.ts";
import type { NonIdempotentReport } from "../src/telemetry.ts";
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
 * Minimal transaction stand-in: it answers the two inspection hooks the
 * recheck consults (its reactivity log and its write details) and remembers
 * whether it was aborted.
 */
function fakeTransaction(
  writes: readonly { address: IMemorySpaceAddress; value: FabricValue }[] = [],
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

  describe("parseAddressKey", () => {
    it("reads back the document a key names, its scope included", () => {
      expect(parseAddressKey(makeAddressKey(address("of:e1", ["a"]))))
        .toEqual({ space: SPACE, id: "of:e1", scope: "space" });
      expect(
        parseAddressKey(
          makeAddressKey({ ...address("of:e1", ["a"]), scope: "user" }),
        ),
      ).toEqual({ space: SPACE, id: "of:e1", scope: "user" });
    });

    it("reads a key naming a data: document as naming none, since its id holds `/`", () => {
      const key = makeAddressKey(
        address('data:application/json,{"a":1}', ["a"]),
      );
      expect(parseAddressKey(key)).toBeUndefined();
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
