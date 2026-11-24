import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolveScopeKey } from "@commonfabric/memory/v2";
import {
  fanOutHoldsSlot,
  type FanOutInstance,
  fanOutRunFinished,
  fanOutRunOpened,
  fanOutRunStarted,
  newFanOutNodeState,
} from "../../src/scheduler/fan-out.ts";
import {
  markInvalid,
  processStorageNotification,
  type StorageNotificationState,
} from "../../src/scheduler/invalidation.ts";
import { entityKey, entityNameKey } from "../../src/scheduler/keys.ts";
import { NodeRegistry } from "../../src/scheduler/node-record.ts";
import { SchedulerTriggerIndex } from "../../src/scheduler/trigger-index.ts";
import type { Action } from "../../src/scheduler/types.ts";
import type {
  ChangeGroup,
  IMemoryChange,
  IMemorySpaceAddress,
  IStorageTransaction,
} from "../../src/storage/interface.ts";

const TEST_IDENTITY = {
  principal: "did:test:invalidation",
  sessionId: "session-1",
};

const read: IMemorySpaceAddress = {
  space: "did:key:invalidation",
  scope: "space",
  id: "of:cell",
  path: ["value"],
};

type CausalEdge = Parameters<StorageNotificationState["recordCausalEdge"]>[0];

/**
 * A notification state over one registered reader of `read`, recording the
 * causal edges it is handed.
 */
function readerState(args: {
  reader: Action;
  diagnosisEnabled: boolean;
  changeGroupToActionId: Map<ChangeGroup, string>;
}) {
  const nodes = new NodeRegistry();
  nodes.register(args.reader, "computation");
  nodes.setStatus(args.reader, "clean");
  const triggerIndex = new SchedulerTriggerIndex(() => TEST_IDENTITY);
  triggerIndex.addActionReads(args.reader, [read], []);
  const edges: CausalEdge[] = [];
  const state: StorageNotificationState = {
    triggerIndex,
    nodes,
    getDiagnosisEnabled: () => args.diagnosisEnabled,
    getCollectTriggerTrace: () => false,
    changeGroupToActionId: args.changeGroupToActionId,
    recordCausalEdge: (edge) => edges.push(edge),
    actionChangeGroups: new WeakMap(),
    effects: new Set(),
    pending: new Set(),
    getActionId: (action) => action.name,
    recordCellUpdate: () => {},
    writersOf: () => undefined,
    recordTriggerTrace: () => {},
    markInvalid: (action, cause) => markInvalid(nodes, action, cause),
    isInvalid: (action) => nodes.getInvalidNodes().has(action),
    materializerIndex: {
      scopeKeyIdentity: () => TEST_IDENTITY,
      materializersByEntity: new Map(),
      effects: new Set(),
      getMaterializerWriteEnvelopes: () => undefined,
      isMaterializer: () => false,
    },
    queueExecution: () => {},
    isRendererInputSource: () => false,
    holdShapedNotification: (_groupKey, _itemKey, _chargeKey, deliver) =>
      deliver(),
  };
  return { state, nodes, edges };
}

/** A commit from a transaction in `changeGroup` that changes `read`. */
function commitIn(changeGroup: ChangeGroup) {
  const change: IMemoryChange = {
    address: {
      id: read.id,
      type: "application/json",
      path: [],
    },
    before: { value: 1 },
    after: { value: 2 },
  };
  return {
    type: "commit" as const,
    space: read.space,
    changes: [change],
    source: { changeGroup } as IStorageTransaction,
  };
}

describe("invalidation", () => {
  describe("processStorageNotification()", () => {
    describe("causal edges", () => {
      it("records the edge from the writer whose change group the commit carries to the reader it invalidates", () => {
        const reader: Action = function reader() {};
        const changeGroup: ChangeGroup = {};
        const { state, nodes, edges } = readerState({
          reader,
          diagnosisEnabled: true,
          changeGroupToActionId: new Map([[changeGroup, "writer"]]),
        });

        processStorageNotification(state, commitIn(changeGroup));

        expect(nodes.get(reader)?.status).toBe("invalid");
        expect(edges.map(({ timestamp: _, ...edge }) => edge)).toEqual([{
          writer: "writer",
          cell: entityKey(read, TEST_IDENTITY),
          triggered: "reader",
        }]);
      });

      it("records no edge for a change group no action registered", () => {
        const reader: Action = function reader() {};
        const { state, nodes, edges } = readerState({
          reader,
          diagnosisEnabled: true,
          changeGroupToActionId: new Map(),
        });

        processStorageNotification(state, commitIn({}));

        expect(nodes.get(reader)?.status).toBe("invalid");
        expect(edges).toEqual([]);
      });

      it("records no edge while diagnosis is off", () => {
        const reader: Action = function reader() {};
        const changeGroup: ChangeGroup = {};
        const { state, edges } = readerState({
          reader,
          diagnosisEnabled: false,
          changeGroupToActionId: new Map([[changeGroup, "writer"]]),
        });

        processStorageNotification(state, commitIn(changeGroup));

        expect(edges).toEqual([]);
      });
    });

    describe("the instances a node that runs once for each viewer writes", () => {
      // The node `writer` writes `of:cell`, declared in the space, once for
      // each of two viewers. Each run writes the viewer's own instance and
      // the instance at the space's key.

      const writer: Action = function writer() {};
      const instanceOf = (principal: string): FanOutInstance => {
        const identity = { principal, sessionId: `${principal}-session` };
        return { identity, key: resolveScopeKey("user", identity) };
      };
      const alice = instanceOf("did:key:alice");
      const bob = instanceOf("did:key:bob");

      /**
       * A notification state over `writer`, registered as writing
       * `of:cell`, with each viewer's run made, and the transaction each
       * run wrote through.
       */
      const writerState = () => {
        const { state, nodes } = readerState({
          reader: function reader() {},
          diagnosisEnabled: false,
          changeGroupToActionId: new Map(),
        });
        const fanOut = newFanOutNodeState();
        fanOut.narrowed = true;
        nodes.register(writer, "computation").fanOut = fanOut;
        const transactions = new Map<FanOutInstance, IStorageTransaction>();
        for (const instance of [alice, bob]) {
          const transaction = { sourceAction: writer } as IStorageTransaction;
          transactions.set(instance, transaction);
          const startGen = fanOutRunStarted(fanOut, instance);
          fanOutRunOpened(fanOut, instance, transaction);
          fanOutRunFinished(fanOut, instance, {
            discovered: "user",
            startGen,
            log: { reads: [], shallowReads: [], writes: [] },
            transaction,
          });
        }
        const written = entityNameKey(read);
        return {
          state: {
            ...state,
            writersOf: (entity) => entity === written ? [writer] : undefined,
          } satisfies StorageNotificationState,
          fanOut,
          transactions,
        };
      };

      /** A change to the instance of `of:cell` that `address` names. */
      const changeAt = (
        address: Pick<IMemoryChange["address"], "scope" | "scopeKey">,
      ): IMemoryChange => ({
        address: {
          id: read.id,
          type: "application/json",
          path: [],
          ...address,
        },
        before: { value: 1 },
        after: { value: 2 },
      });

      it("tells the node that the run whose commit changed an instance holds it, and that the run before it does not", () => {
        const { state, fanOut, transactions } = writerState();

        processStorageNotification(state, {
          type: "commit",
          space: read.space,
          changes: [changeAt({ scope: "space", scopeKey: "space" })],
          source: transactions.get(bob),
        });

        expect(fanOutHoldsSlot(fanOut, bob.key, "space", read.id)).toBe(true);
        expect(fanOutHoldsSlot(fanOut, alice.key, "space", read.id)).toBe(
          false,
        );
      });

      it("tells the node that a run's writes were applied where its commit changed another instance alone", () => {
        // Alice's commit changes the shared instance, and Bob's, which
        // writes the same there, changes his own alone: the shared one
        // holds what both wrote.

        const { state, fanOut, transactions } = writerState();

        processStorageNotification(state, {
          type: "commit",
          space: read.space,
          changes: [changeAt({ scope: "space", scopeKey: "space" })],
          source: transactions.get(alice),
        });
        processStorageNotification(state, {
          type: "commit",
          space: read.space,
          changes: [changeAt({ scope: "user", scopeKey: bob.key })],
          source: transactions.get(bob),
        });

        expect(fanOutHoldsSlot(fanOut, alice.key, "space", read.id)).toBe(true);
        expect(fanOutHoldsSlot(fanOut, bob.key, "space", read.id)).toBe(true);
      });

      it("counts a change the store pushed as no run's", () => {
        const { state, fanOut } = writerState();

        processStorageNotification(state, {
          type: "integrate",
          space: read.space,
          changes: [changeAt({ scope: "space" })],
        });

        expect(fanOutHoldsSlot(fanOut, alice.key, "space", read.id)).toBe(
          false,
        );
        expect(fanOutHoldsSlot(fanOut, bob.key, "space", read.id)).toBe(false);
      });

      it("counts a change that names no instance of a scoped document against every instance of it", () => {
        const { state, fanOut } = writerState();

        processStorageNotification(state, {
          type: "pull",
          space: read.space,
          changes: [changeAt({ scope: "user" })],
        });

        expect(fanOutHoldsSlot(fanOut, alice.key, alice.key, read.id)).toBe(
          false,
        );
      });
    });
  });

  describe("markInvalid()", () => {
    it("leaves an action that was never registered without a record", () => {
      const nodes = new NodeRegistry();
      const action: Action = function unknown() {};

      markInvalid(nodes, action, read);

      expect(nodes.get(action)).toBeUndefined();
      expect(nodes.getInvalidNodes().has(action)).toBe(false);
    });
  });
});
