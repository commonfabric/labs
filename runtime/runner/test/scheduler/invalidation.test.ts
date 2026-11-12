import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  markInvalid,
  processStorageNotification,
  type StorageNotificationState,
} from "../../src/scheduler/invalidation.ts";
import { entityKey } from "../../src/scheduler/keys.ts";
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
