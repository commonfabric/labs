import { computed, pattern, TESTS, UI, Writable } from "commonfabric";

export const readBudgets = { initialization: { total: 0 } };

export default pattern(() => {
  const value = Writable.of({ count: 1 });
  return {
    [UI]: <span>{computed(() => value.get().count)}</span>,
    [TESTS]: [{ render: {} }],
  };
});
