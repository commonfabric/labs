import { type Cell, Default, handler, lift, pattern, str } from "commonfabric";

interface NestedDeriveArgs {
  value: Default<number, 0>;
}

interface IncrementEvent {
  amount?: number;
}

interface SetValueEvent {
  value?: number;
}

const sanitizeNumber = (input: unknown, fallback: number): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return fallback;
  }
  return Math.trunc(input);
};

const adjustValue = handler(
  (
    event: IncrementEvent | undefined,
    context: { value: Cell<number> },
  ) => {
    const base = sanitizeNumber(context.value.get(), 0);
    const delta = sanitizeNumber(event?.amount, 1);
    context.value.set(base + delta);
  },
);

const setValue = handler(
  (
    event: SetValueEvent | undefined,
    context: { value: Cell<number> },
  ) => {
    const next = sanitizeNumber(event?.value, 0);
    context.value.set(next);
  },
);

const liftCurrent = lift((raw: number | undefined) =>
  typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : 0
);

const liftMagnitude = lift((count: number) => Math.abs(count));

const liftParity = lift((absolute: number) =>
  Math.abs(absolute % 2) === 0 ? "even" : "odd"
);

const liftEmphasis = lift((label: "even" | "odd") =>
  label === "even" ? "steady" : "swing"
);

const liftParityCode = lift((label: "steady" | "swing") =>
  label === "steady" ? 0 : 1
);

export const counterWithNestedDeriveWatchers = pattern<NestedDeriveArgs>(
  ({ value }) => {
    const current = liftCurrent(value);

    const magnitude = liftMagnitude(current);
    const parity = liftParity(magnitude);
    const emphasis = liftEmphasis(parity);
    const parityCode = liftParityCode(emphasis);

    const parityDetail = str`parity ${parity} emphasis ${emphasis}`;
    const summary =
      str`value ${current} magnitude ${magnitude} code ${parityCode}`;

    return {
      value,
      current,
      magnitude,
      parity,
      emphasis,
      parityCode,
      parityDetail,
      summary,
      increment: adjustValue({ value }),
      setValue: setValue({ value }),
    };
  },
);

export default counterWithNestedDeriveWatchers;
