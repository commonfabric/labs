import { assert, computed, pattern, TESTS, UI, Writable } from "commonfabric";

export const readBudgets = { initialization: { total: 20, perRun: 100 } };

const INDICES = Array.from({ length: 8 }, (_, index) => index);
const VALUES = INDICES.map((value) => ({ value }));

export default pattern(() => {
  const values = Writable.of(VALUES);
  const rows = INDICES.map((index) =>
    computed(() => values.key(index).get().value)
  );
  return {
    [UI]: <div>{rows}</div>,
    [TESTS]: [{ assertion: assert(() => values.get().length === 8) }],
  };
});
