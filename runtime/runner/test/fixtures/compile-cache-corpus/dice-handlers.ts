import { Default, handler, Writable } from "commonfabric";

export const roll = handler<
  { sides?: number | Default<6> },
  { value: Writable<number> }
>(
  (args, state) => {
    const rawSides = args.sides ?? 6;
    const floored = Math.floor(Number(rawSides));
    const sides = Number.isFinite(floored) && floored > 0 ? floored : 6;
    const rolled = Math.floor(Math.random() * sides) + 1;
    state.value.set(rolled);
  },
);

export const getValue = handler<
  { result?: Writable<string> },
  { value: Writable<number> }
>(
  (args, state) => {
    const current = state.value.get();
    args.result?.set(`Current die value is ${current}`);
  },
);
