import {
  Cell,
  cell,
  computed,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

type Parity = "even" | "odd";

interface ReferenceEqualityArgs {
  value: Default<number, 0>;
}

interface IncrementEvent {
  amount?: number;
}

interface OverrideEvent {
  value?: number;
}

interface Summary {
  value: number;
  parity: Parity;
  version: number;
}

interface StabilityStatus {
  stable: boolean;
  confirmations: number;
}

function ensureNumber(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const applyIncrement = handler(
  (
    event: IncrementEvent | undefined,
    context: {
      value: Cell<number>;
      stability: Cell<StabilityStatus>;
      version: Cell<number>;
    },
  ) => {
    const amount = event?.amount;
    if (typeof amount !== "number" || !Number.isFinite(amount)) {
      return;
    }

    const current = ensureNumber(context.value.get());
    const next = current + amount;
    if (next === current) {
      const status = context.stability.get();
      const confirmations = status.stable ? status.confirmations + 1 : 1;
      context.stability.set({ stable: true, confirmations });
      context.value.set(next);
      return;
    }

    context.value.set(next);
    context.stability.set({ stable: false, confirmations: 0 });
    const currentVersion = ensureNumber(context.version.get());
    context.version.set(currentVersion + 1);
  },
);

const liftCurrentValue = lift((raw: number | undefined) => ensureNumber(raw));

const liftParity = lift((snapshot: Summary) => snapshot.parity);

const liftVersion = lift((snapshot: Summary) => snapshot.version);

const applyOverride = handler(
  (
    event: OverrideEvent | undefined,
    context: {
      value: Cell<number>;
      stability: Cell<StabilityStatus>;
      version: Cell<number>;
    },
  ) => {
    const raw = event?.value;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return;
    }

    const current = ensureNumber(context.value.get());
    if (raw === current) {
      const status = context.stability.get();
      const confirmations = status.stable ? status.confirmations + 1 : 1;
      context.stability.set({ stable: true, confirmations });
      context.value.set(raw);
      return;
    }

    context.value.set(raw);
    context.stability.set({ stable: false, confirmations: 0 });
    const currentVersion = ensureNumber(context.version.get());
    context.version.set(currentVersion + 1);
  },
);

/**
 * Counter that keeps a derived summary stable when sanitized value does not
 * change between updates.
 */
export const counterWithReferenceEqualityAssertions = pattern<
  ReferenceEqualityArgs
>(
  ({ value }) => {
    const currentValue = liftCurrentValue(value);

    const stability = cell<StabilityStatus>({
      stable: true,
      confirmations: 1,
    });
    const versionCounter = cell<number>(0);

    const summary = computed((): Summary => {
      const count = currentValue;
      const version = versionCounter.get();
      const parity: Parity = count % 2 === 0 ? "even" : "odd";
      return {
        value: count,
        parity,
        version: ensureNumber(version),
      };
    });

    const parity = liftParity(summary);
    const version = liftVersion(summary);
    const label = str`Value ${currentValue} is ${parity}`;

    return {
      value,
      current: currentValue,
      summary,
      parity,
      version,
      label,
      referenceStatus: stability,
      increment: applyIncrement({ value, stability, version: versionCounter }),
      override: applyOverride({ value, stability, version: versionCounter }),
    };
  },
);

export default counterWithReferenceEqualityAssertions;
