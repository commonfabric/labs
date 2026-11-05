import {
  action,
  assert,
  computed,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";

export default pattern(() => {
  const value = Writable.of({ count: 0 });
  const increments = Writable.of([1]);
  const increment = action(() => {
    const amount = increments.get().reduce((sum, item) => sum + item, 0);
    value.set({ count: value.get().count + amount });
  });
  const updated = assert(() => value.get().count === 1);
  return {
    [UI]: <div>{computed(() => value.get().count)}</div>,
    [TESTS]: [
      { action: increment },
      { assertion: updated },
      { settle: true, readBudget: { total: 0, perRun: 0 } },
    ],
  };
});
