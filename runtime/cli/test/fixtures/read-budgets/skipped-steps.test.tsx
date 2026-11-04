import { action, assert, pattern, TESTS, Writable } from "commonfabric";

export const readBudgets = { steps: { total: 100000, perRun: 100000 } };

export default pattern(() => {
  const value = Writable.of(0);
  const increment = action(() => value.set(value.get() + 1));
  return {
    [TESTS]: [
      { assertion: assert(() => false), skip: true, readBudget: { total: 0 } },
      { action: increment, skip: true, readBudget: { total: 0 } },
      { assertion: assert(() => value.get() === 0) },
      { action: increment },
      { assertion: assert(() => false), skip: true, readBudget: { total: 0 } },
      { assertion: assert(() => value.get() === 1) },
    ],
  };
});
