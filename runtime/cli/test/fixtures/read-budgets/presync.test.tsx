import { assert, handler, pattern, TESTS, Writable } from "commonfabric";

export const readBudgets = { steps: { total: 100000, perRun: 100000 } };

const inspect = handler<unknown, {
  input: { nested: { values: number[] } };
  observed: Writable<number>;
}>((_event, { input, observed }) => {
  observed.set(input.nested.values.reduce((sum, value) => sum + value, 0));
});

export default pattern(() => {
  const input = Writable.of({ nested: { values: [2, 3] } });
  const observed = Writable.of(0);

  return {
    [TESTS]: [
      { action: inspect({ input, observed }) },
      { assertion: assert(() => observed.get() === 5) },
    ],
  };
});
