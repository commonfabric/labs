import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { SchedulerNode } from "../../src/scheduler/node-record.ts";
import type { Action } from "../../src/scheduler/types.ts";
import {
  createSchedulerTestRuntime,
  disposeSchedulerTestRuntime,
  Runtime,
} from "../scheduler-test-utils.ts";
import type {
  IExtendedStorageTransaction,
  SchedulerTestStorageManager,
} from "../scheduler-test-utils.ts";

/** A deadline no case waits out: the cases read gate state, never the clock. */
const FAR_FUTURE_MS = 60_000;

const NO_DEPENDENCIES = { reads: [], shallowReads: [], writes: [] };

/**
 * Replaces `record.status` with an accessor that counts its reads, so a case
 * can tell which records a walk looked at. The accessor keeps the record
 * writable: `NodeRegistry.setStatus()` assigns through it.
 */
function countStatusReads(record: SchedulerNode): () => number {
  let reads = 0;
  let status = record.status;
  Object.defineProperty(record, "status", {
    get: () => {
      reads++;
      return status;
    },
    set: (value: SchedulerNode["status"]) => {
      status = value;
    },
    enumerable: true,
    configurable: true,
  });
  return () => reads;
}

describe("Scheduler", () => {
  let storageManager: SchedulerTestStorageManager;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let subscribed: Action[];

  beforeEach(() => {
    ({ storageManager, runtime, tx } = createSchedulerTestRuntime(
      import.meta.url,
    ));
    subscribed = [];
  });

  afterEach(async () => {
    for (const action of subscribed) runtime.scheduler.unsubscribe(action);
    await disposeSchedulerTestRuntime({ storageManager, runtime, tx });
  });

  /** Registers a node for a fresh action and sets its status. */
  function registerNode(
    name: string,
    status: SchedulerNode["status"],
  ): SchedulerNode {
    const named = { [name]: () => {} };
    const action: Action = named[name];
    runtime.scheduler.subscribe(action, NO_DEPENDENCIES, {});
    subscribed.push(action);
    const nodes = runtime.scheduler.accessForTestingOnly.nodes;
    nodes.setStatus(action, status);
    return nodes.get(action)!;
  }

  function holdBackoff(record: SchedulerNode): void {
    runtime.scheduler.accessForTestingOnly.gates.holdInitialRun(
      record.action,
      performance.now() + FAR_FUTURE_MS,
    );
  }

  describe("instance members", () => {
    describe("clearBackoffForCleanNodes()", () => {
      it("clears the backoff of a clean node", () => {
        const clean = registerNode("cleanBackedOff", "clean");
        holdBackoff(clean);
        expect(clean.gate.backoffUntil).toBeDefined();

        runtime.scheduler.accessForTestingOnly.clearBackoffForCleanNodes();

        expect(clean.gate.backoffUntil).toBeUndefined();
      });

      it("keeps the backoff of a dirty node", () => {
        const dirty = registerNode("dirtyBackedOff", "invalid");
        holdBackoff(dirty);
        const deadline = dirty.gate.backoffUntil;

        runtime.scheduler.accessForTestingOnly.clearBackoffForCleanNodes();

        expect(dirty.gate.backoffUntil).toBe(deadline);
      });

      it("reads the status of the nodes holding backoff state only", () => {
        const backedOff = registerNode("backedOff", "clean");
        holdBackoff(backedOff);
        const bystanders = [
          registerNode("bystanderClean", "clean"),
          registerNode("bystanderDirty", "invalid"),
          registerNode("bystanderNeverRan", "never-ran"),
        ];
        const backedOffReads = countStatusReads(backedOff);
        const bystanderReads = bystanders.map(countStatusReads);

        runtime.scheduler.accessForTestingOnly.clearBackoffForCleanNodes();

        expect(backedOffReads()).toBeGreaterThan(0);
        expect(bystanderReads.map((reads) => reads())).toEqual([0, 0, 0]);
      });

      it("keeps a never-ran node whose initial-run hold was released out of the walk", () => {
        const released = registerNode("holdReleased", "never-ran");
        holdBackoff(released);
        runtime.scheduler.accessForTestingOnly.gates.releaseInitialRunHold(
          released.action,
        );
        const reads = countStatusReads(released);

        runtime.scheduler.accessForTestingOnly.clearBackoffForCleanNodes();

        expect(reads()).toBe(0);
      });

      it("keeps a node whose backoff it cleared out of the next walk", () => {
        const cleared = registerNode("clearedBefore", "clean");
        holdBackoff(cleared);
        runtime.scheduler.accessForTestingOnly.clearBackoffForCleanNodes();
        const reads = countStatusReads(cleared);

        runtime.scheduler.accessForTestingOnly.clearBackoffForCleanNodes();

        expect(reads()).toBe(0);
      });
    });
  });
});
