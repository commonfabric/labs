import { describe, expect, it } from "./scheduler-test-utils.ts";
import {
  applyActionReadDelta,
  ensureCancelForActionTriggers,
  SchedulerTriggerIndex,
  SchedulerTriggerSubscriptions,
} from "../src/scheduler/trigger-index.ts";
import type { Action, ReactivityLog } from "../src/scheduler/types.ts";
import type { IMemorySpaceAddress } from "../src/storage/interface.ts";

// Identity entity keys resolve scoped addresses against (stage E).
const TEST_IDENTITY = {
  principal: "did:test:alice",
  sessionId: "session-1",
};
const identityThunk = () => TEST_IDENTITY;

describe("SchedulerTriggerIndex", () => {
  it("removes empty trigger entities when the last action unsubscribes", () => {
    const triggerIndex = new SchedulerTriggerIndex(identityThunk);
    const action: Action = () => {};
    const read: IMemorySpaceAddress = {
      space: "did:key:trigger-index-test",
      scope: "space",
      id: "of:cell",
      path: ["value"],
    };

    const { entities } = triggerIndex.addActionReads(action, [read], []);
    expect(triggerIndex.hasRegisteredTriggers()).toBe(true);

    triggerIndex.removeActionFromEntities(action, entities);

    expect(triggerIndex.hasRegisteredTriggers()).toBe(false);
    expect(triggerIndex.triggers.size).toBe(0);
    expect(triggerIndex.nonRecursiveTriggers.size).toBe(0);
  });

  it("removes all trigger entities for an unloaded space", () => {
    const triggerIndex = new SchedulerTriggerIndex(identityThunk);
    const firstAction: Action = () => {};
    const secondAction: Action = () => {};
    const firstRead: IMemorySpaceAddress = {
      space: "did:key:trigger-index-space-a",
      scope: "space",
      id: "of:cell",
      path: ["value"],
    };
    const secondRead: IMemorySpaceAddress = {
      space: "did:key:trigger-index-space-b",
      scope: "space",
      id: "of:cell",
      path: ["value"],
    };
    triggerIndex.addActionReads(firstAction, [firstRead], []);
    triggerIndex.addActionReads(secondAction, [secondRead], []);

    triggerIndex.removeSpace("did:key:trigger-index-space-a");

    expect(triggerIndex.collectReadersForWrite(firstRead).size).toBe(0);
    expect(triggerIndex.collectReadersForWrite(secondRead).size).toBe(1);
    expect(triggerIndex.hasRegisteredTriggers()).toBe(true);
  });
});

describe("applyActionReadDelta", () => {
  const emptyLog: ReactivityLog = { reads: [], shallowReads: [], writes: [] };

  it("updates triggers when only the read scope changes", () => {
    const triggerIndex = new SchedulerTriggerIndex(identityThunk);
    const state = new SchedulerTriggerSubscriptions({
      triggerIndex,
      cancels: new WeakMap(),
      getActionId: () => "test-action",
    });
    const action: Action = () => {};
    const base = {
      space: "did:key:trigger-index-test",
      id: "of:cell",
      path: ["value"],
    } as const;
    const spaceRead = { ...base, scope: "space" } as IMemorySpaceAddress;
    const userRead = { ...base, scope: "user" } as IMemorySpaceAddress;
    const firstLog: ReactivityLog = {
      reads: [spaceRead],
      shallowReads: [],
      writes: [],
    };
    const secondLog: ReactivityLog = {
      reads: [userRead],
      shallowReads: [],
      writes: [],
    };

    applyActionReadDelta(state, action, emptyLog, firstLog);
    ensureCancelForActionTriggers(state, action);

    // Same space/id/path, different scope: must NOT be treated as unchanged.
    applyActionReadDelta(state, action, firstLog, secondLog);

    expect(triggerIndex.collectReadersForWrite(userRead).has(action)).toBe(
      true,
    );
    expect(triggerIndex.collectReadersForWrite(spaceRead).has(action)).toBe(
      false,
    );
  });

  it("leaves a shallow read to a write more than one component below it", () => {
    // A shallow read of `value` sees `value` replaced and sees its own
    // members replaced, and nothing deeper. The index hands the read over,
    // because the write descends through it, and the depth test drops it.

    const triggerIndex = new SchedulerTriggerIndex(identityThunk);
    const state = new SchedulerTriggerSubscriptions({
      triggerIndex,
      cancels: new WeakMap(),
      getActionId: () => "test-action",
    });
    const action: Action = () => {};
    const shallowRead: IMemorySpaceAddress = {
      space: "did:key:trigger-index-shallow",
      scope: "space",
      id: "of:cell",
      path: ["value"],
    };
    const log: ReactivityLog = {
      reads: [],
      shallowReads: [shallowRead],
      writes: [],
    };
    applyActionReadDelta(state, action, emptyLog, log);

    const member = { ...shallowRead, path: ["value", "member"] };
    expect(triggerIndex.collectReadersForWrite(member).has(action)).toBe(true);

    const deeper = { ...shallowRead, path: ["value", "member", "field"] };
    expect(triggerIndex.collectReadersForWrite(deeper).has(action)).toBe(false);
  });

  it("re-registers an action whose reads are unchanged since the index forgot them", () => {
    // What an action last read and what the index currently holds are two
    // different facts, and `removeSpace()` moves only the second. An action
    // re-registering identical reads after one has to land in the index
    // again, so the delta is taken against what the index holds.

    const triggerIndex = new SchedulerTriggerIndex(identityThunk);
    const state = new SchedulerTriggerSubscriptions({
      triggerIndex,
      cancels: new WeakMap(),
      getActionId: () => "test-action",
    });
    const action: Action = () => {};
    const read: IMemorySpaceAddress = {
      space: "did:key:trigger-index-forgotten",
      scope: "space",
      id: "of:cell",
      path: ["value"],
    };
    const log: ReactivityLog = { reads: [read], shallowReads: [], writes: [] };

    applyActionReadDelta(state, action, emptyLog, log);
    expect(triggerIndex.collectReadersForWrite(read).has(action)).toBe(true);

    triggerIndex.removeSpace("did:key:trigger-index-forgotten");
    expect(triggerIndex.collectReadersForWrite(read).has(action)).toBe(false);

    applyActionReadDelta(state, action, log, log);

    expect(triggerIndex.collectReadersForWrite(read).has(action)).toBe(true);
  });

  it("keeps one cancel that removes the latest trigger entities", () => {
    const triggerIndex = new SchedulerTriggerIndex(identityThunk);
    const cancels = new WeakMap<Action, () => void>();
    const state = new SchedulerTriggerSubscriptions({
      triggerIndex,
      cancels,
      getActionId: () => "test-action",
    });
    const action: Action = () => {};
    const firstRead: IMemorySpaceAddress = {
      space: "did:key:trigger-index-cancel-a",
      scope: "space",
      id: "of:cell",
      path: ["value"],
    };
    const secondRead: IMemorySpaceAddress = {
      space: "did:key:trigger-index-cancel-b",
      scope: "space",
      id: "of:cell",
      path: ["value"],
    };
    const firstLog: ReactivityLog = {
      reads: [firstRead],
      shallowReads: [],
      writes: [],
    };
    const secondLog: ReactivityLog = {
      reads: [secondRead],
      shallowReads: [],
      writes: [],
    };

    applyActionReadDelta(state, action, emptyLog, firstLog);
    ensureCancelForActionTriggers(state, action);
    const firstCancel = cancels.get(action);
    applyActionReadDelta(state, action, firstLog, secondLog);
    ensureCancelForActionTriggers(state, action);

    expect(cancels.get(action)).toBe(firstCancel);

    cancels.get(action)?.();

    expect(triggerIndex.collectReadersForWrite(firstRead).has(action)).toBe(
      false,
    );
    expect(triggerIndex.collectReadersForWrite(secondRead).has(action)).toBe(
      false,
    );
  });
});
