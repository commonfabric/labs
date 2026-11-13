import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { updateSchedulerActionChangeGroup } from "../../src/scheduler/registration.ts";
import type { Action } from "../../src/scheduler/types.ts";
import type { ChangeGroup } from "../../src/storage/interface.ts";
import {
  createSchedulerTestRuntime,
  disposeSchedulerTestRuntime,
  type IExtendedStorageTransaction,
  type Runtime,
  type SchedulerTestStorageManager,
  space,
  toMemorySpaceAddress,
} from "../scheduler-test-utils.ts";

/** Change-group state for one action, `action`. */
function changeGroupState(
  owners: [ChangeGroup, string][],
  current?: ChangeGroup,
) {
  const action: Action = function action() {};
  const actionChangeGroups = new WeakMap<Action, ChangeGroup>();
  if (current !== undefined) actionChangeGroups.set(action, current);
  return {
    action,
    state: {
      actionChangeGroups,
      changeGroupToActionId: new Map(owners),
      getActionId: (candidate: Action) => candidate.name,
    },
  };
}

describe("registration", () => {
  describe("updateSchedulerActionChangeGroup()", () => {
    it("moves the action's ownership from its previous change group to the new one", () => {
      const previous: ChangeGroup = {};
      const next: ChangeGroup = {};
      const { action, state } = changeGroupState(
        [[previous, "action"]],
        previous,
      );

      updateSchedulerActionChangeGroup(state, action, { changeGroup: next });

      expect([...state.changeGroupToActionId]).toEqual([[next, "action"]]);
      expect(state.actionChangeGroups.get(action)).toBe(next);
    });

    it("keeps another action's ownership of the previous change group", () => {
      const previous: ChangeGroup = {};
      const next: ChangeGroup = {};
      const { action, state } = changeGroupState(
        [[previous, "other"]],
        previous,
      );

      updateSchedulerActionChangeGroup(state, action, { changeGroup: next });

      expect([...state.changeGroupToActionId]).toEqual([
        [previous, "other"],
        [next, "action"],
      ]);
    });

    it("leaves the change group alone for options that name none", () => {
      const previous: ChangeGroup = {};
      const { action, state } = changeGroupState(
        [[previous, "action"]],
        previous,
      );

      updateSchedulerActionChangeGroup(state, action, {});

      expect([...state.changeGroupToActionId]).toEqual([[previous, "action"]]);
      expect(state.actionChangeGroups.get(action)).toBe(previous);
    });
  });

  describe("unsubscribeSchedulerAction()", () => {
    // An effect subscribed in a change group does not run for commits made in
    // that group. `resubscribe()` without a group keeps whatever group the
    // action still holds, so the suppression after it says whether the
    // unsubscription kept the group.

    let storageManager: SchedulerTestStorageManager;
    let runtime: Runtime;
    let tx: IExtendedStorageTransaction;

    beforeEach(() => {
      ({ storageManager, runtime, tx } = createSchedulerTestRuntime(
        import.meta.url,
      ));
    });

    afterEach(async () => {
      await disposeSchedulerTestRuntime({ storageManager, runtime, tx });
    });

    /**
     * Subscribes an effect reading a cell in `changeGroup`, unsubscribes it
     * with `options`, resubscribes it naming no group, and returns how many
     * runs a commit in `changeGroup` adds.
     */
    async function runsForGroupCommitAfter(
      options: { preserveChangeGroup?: boolean },
    ): Promise<number> {
      const value = runtime.getCell<number>(
        space,
        `registration-change-group-${options.preserveChangeGroup}`,
        undefined,
        tx,
      );
      value.set(0);
      await tx.commit().settled;
      tx = runtime.edit();

      let runs = 0;
      const effect: Action = (actionTx) => {
        runs++;
        value.withTx(actionTx).get();
      };
      const log = {
        reads: [toMemorySpaceAddress(value.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [],
      };
      const changeGroup: ChangeGroup = {};
      runtime.scheduler.subscribe(effect, log, { isEffect: true, changeGroup });
      await runtime.scheduler.idle();
      runtime.scheduler.unsubscribe(effect, options);
      runtime.scheduler.resubscribe(effect, log, { isEffect: true });

      const before = runs;
      const groupTx = runtime.edit({ changeGroup });
      value.withTx(groupTx).set(1);
      await groupTx.commit().settled;
      await runtime.scheduler.idle();
      runtime.scheduler.unsubscribe(effect);
      return runs - before;
    }

    it("keeps the action's change group with `preserveChangeGroup`", async () => {
      expect(await runsForGroupCommitAfter({ preserveChangeGroup: true }))
        .toBe(0);
    });

    it("drops the action's change group by default", async () => {
      expect(await runsForGroupCommitAfter({})).toBe(1);
    });
  });
});
