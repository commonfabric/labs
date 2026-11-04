import { Cell, Default, handler, lift, pattern, str } from "commonfabric";

interface MutableTupleArgs {
  pair: Default<[number, number], [0, 0]>;
}

const setPair = handler(
  (
    event: { left?: number; right?: number } | undefined,
    context: { pair: Cell<[number, number]> },
  ) => {
    const left = typeof event?.left === "number" ? event.left : 0;
    const right = typeof event?.right === "number" ? event.right : 0;
    context.pair.set([left, right]);
  },
);

const adjustPair = handler(
  (
    event: { left?: number; right?: number } | undefined,
    context: { pair: Cell<[number, number]> },
  ) => {
    const current = context.pair.get() ?? [0, 0];
    const leftDelta = typeof event?.left === "number" ? event.left : 0;
    const rightDelta = typeof event?.right === "number" ? event.right : 0;
    context.pair.set([
      current[0] + leftDelta,
      current[1] + rightDelta,
    ]);
  },
);

const liftTuple = lift((values: [number, number] | undefined) => {
  const leftValue = Array.isArray(values) && typeof values[0] === "number"
    ? values[0]
    : 0;
  const rightValue = Array.isArray(values) && typeof values[1] === "number"
    ? values[1]
    : 0;
  return [leftValue, rightValue] as [number, number];
});

const liftLeft = lift((values: [number, number]) => values[0]);

const liftRight = lift((values: [number, number]) => values[1]);

const liftSum = lift((values: [number, number]) => values[0] + values[1]);

export const counterWithMutableTuple = pattern<MutableTupleArgs>(
  ({ pair }) => {
    const tuple = liftTuple(pair);
    const left = liftLeft(tuple);
    const right = liftRight(tuple);
    const sum = liftSum(tuple);
    const label = str`Tuple (${left}, ${right}) sum ${sum}`;

    return {
      pair,
      tuple,
      left,
      right,
      sum,
      label,
      set: setPair({ pair }),
      adjust: adjustPair({ pair }),
    };
  },
);

export default counterWithMutableTuple;
