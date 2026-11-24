import { Cell, cell, Default, handler, lift, pattern, str } from "commonfabric";

type GateMode = "enabled" | "disabled";

interface DerivedHandlerGateArgs {
  value: Default<number, 0>;
  gateMode: Default<GateMode, "enabled">;
}

const ensureNumber = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const normalizeAmount = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 1;

const clampGateMode = (value: unknown): GateMode =>
  value === "disabled" ? "disabled" : "enabled";

const applyIncrement = handler(
  (
    event: { amount?: number } | undefined,
    context: {
      value: Cell<number>;
      log: Cell<string[]>;
      blockedCount: Cell<number>;
      appliedCount: Cell<number>;
      canIncrement: Cell<boolean>;
    },
  ) => {
    const amount = normalizeAmount(event?.amount);
    const historyRaw = context.log.get();
    const history = Array.isArray(historyRaw) ? historyRaw : [];
    const allowed = context.canIncrement.get() === true;
    const currentValue = ensureNumber(context.value.get(), 0);
    const blocked = ensureNumber(context.blockedCount.get(), 0);
    const applied = ensureNumber(context.appliedCount.get(), 0);

    if (!allowed) {
      context.blockedCount.set(blocked + 1);
      context.log.set([...history, `blocked:${amount}`]);
      return;
    }

    const next = currentValue + amount;
    context.value.set(next);
    context.appliedCount.set(applied + 1);
    context.log.set([...history, `applied:${next}`]);
  },
);

const setGateMode = handler(
  (
    event: { mode?: GateMode } | undefined,
    context: { gateMode: Cell<GateMode> },
  ) => {
    const current = clampGateMode(context.gateMode.get());
    const next = event?.mode === "disabled"
      ? "disabled"
      : event?.mode === "enabled"
      ? "enabled"
      : current === "enabled"
      ? "disabled"
      : "enabled";

    if (next !== current) {
      context.gateMode.set(next);
    }
  },
);

const liftSafeValue = lift((input: number | undefined) =>
  typeof input === "number" && Number.isFinite(input) ? input : 0
);
const liftSafeGateMode = lift((mode: GateMode | string | undefined) =>
  mode === "disabled" ? "disabled" : "enabled"
);
const liftIsActive = lift((mode: GateMode) => mode === "enabled");
const liftStatusLabel = lift((mode: GateMode) =>
  mode === "disabled" ? "disabled" : "enabled"
);
const liftAttemptHistory = lift((entries: string[] | undefined) =>
  Array.isArray(entries) ? entries : []
);
const liftSafeCount = lift((count: number | undefined) =>
  typeof count === "number" && Number.isFinite(count) ? count : 0
);

export const counterWithDerivedHandlerGate = pattern<DerivedHandlerGateArgs>(
  ({ value, gateMode }) => {
    const attemptLog = cell<string[]>([]);
    const blockedCount = cell<number>(0);
    const appliedCount = cell<number>(0);

    const safeValue = liftSafeValue(value);

    const safeGateMode = liftSafeGateMode(gateMode);

    const isActive = liftIsActive(safeGateMode);

    const statusLabel = liftStatusLabel(safeGateMode);

    const attemptHistory = liftAttemptHistory(attemptLog);

    const blockedAttempts = liftSafeCount(blockedCount);

    const appliedAttempts = liftSafeCount(appliedCount);

    const increment = applyIncrement({
      value,
      log: attemptLog,
      blockedCount,
      appliedCount,
      canIncrement: isActive,
    });

    const toggleGate = setGateMode({ gateMode });

    return {
      value,
      gateMode: safeGateMode,
      current: safeValue,
      isActive,
      status: statusLabel,
      blockedAttempts,
      appliedAttempts,
      attemptHistory,
      label: str`Count ${safeValue} (${statusLabel})`,
      increment,
      toggleGate,
    };
  },
);

export default counterWithDerivedHandlerGate;
