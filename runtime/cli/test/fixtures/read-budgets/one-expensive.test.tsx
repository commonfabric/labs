import { assert, computed, pattern, TESTS, UI, Writable } from "commonfabric";

export const readBudgets = { initialization: { total: 100000, perRun: 100 } };

const VALUES = Array.from({ length: 1000 }, () => 1);

export default pattern(() => {
  const values = Writable.of(VALUES);
  const sum = computed(() =>
    values.get().reduce((total, value) => total + value, 0)
  );
  return {
    [UI]: <div>{sum}</div>,
    [TESTS]: [{ assertion: assert(() => sum === 1000) }],
  };
});
