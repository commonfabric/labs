import { computed, pattern, TESTS, Writable } from "commonfabric";

export const readBudgets = {};

export default pattern(() => {
  const value = Writable.of({ count: 1 });
  return {
    [TESTS]: [{
      render: <div>{computed(() => value.get().count)}</div>,
      readBudget: { total: 0, perRun: 0 },
    }],
  };
});
