import { handler, Writable } from "commonfabric";

/**
 * Rolls a die of the sides the event names, or else of the sides the handler
 * is bound to, or else a d6, into `value`.
 */
export const roll = handler<
  { sides?: number },
  { value: Writable<number>; sides?: number }
>(
  (args, state) => {
    const rawSides = args.sides ?? state.sides ?? 6;
    const floored = Math.floor(Number(rawSides));
    const sides = Number.isFinite(floored) && floored > 0 ? floored : 6;
    const rolled = Math.floor(Math.random() * sides) + 1;
    state.value.set(rolled);
  },
);

/** Reports the die's current value into `report`. */
export const getValue = handler<
  void,
  { value: Writable<number>; report: Writable<string> }
>(
  (_event, state) => {
    state.report.set(`Current die value is ${state.value.get()}`);
  },
);
