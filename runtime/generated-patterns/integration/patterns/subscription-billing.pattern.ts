import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

type PlanId = "starter" | "growth" | "enterprise";

interface PlanDefinition {
  id: PlanId;
  name: string;
  price: number;
  cycleDays: number;
}

interface SubscriptionBillingArgs {
  plan: Default<PlanId, typeof defaultPlan>;
  lastInvoiceDate: Default<string, typeof defaultLastInvoiceDate>;
}

interface PlanChangeEvent {
  plan?: string;
  cycleDays?: number;
  lastInvoiceDate?: string;
}

interface InvoiceRecordedEvent {
  date?: string;
}

const defaultPlan: PlanId = "starter";
const defaultLastInvoiceDate = "2024-01-01";

const planCatalog: Record<PlanId, PlanDefinition> = {
  starter: { id: "starter", name: "Starter", price: 29, cycleDays: 30 },
  growth: { id: "growth", name: "Growth", price: 59, cycleDays: 30 },
  enterprise: {
    id: "enterprise",
    name: "Enterprise",
    price: 119,
    cycleDays: 90,
  },
};

const knownPlans = new Set<PlanId>(["starter", "growth", "enterprise"]);

const formatCurrency = (amount: number): string => {
  return `$${amount.toFixed(2)}`;
};

const parseIsoDate = (input: string): Date | null => {
  if (typeof input !== "string") return null;
  const date = new Date(`${input}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
};

const formatIsoDate = (date: Date): string => {
  return date.toISOString().slice(0, 10);
};

const sanitizePlanId = (value: unknown): PlanId => {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (knownPlans.has(normalized as PlanId)) {
      return normalized as PlanId;
    }
  }
  return defaultPlan;
};

const sanitizeCycleDays = (value: unknown, fallback: number): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const rounded = Math.trunc(value);
    return rounded > 0 ? rounded : fallback;
  }
  if (typeof fallback === "number" && fallback > 0) {
    return Math.trunc(fallback);
  }
  return planCatalog[defaultPlan].cycleDays;
};

const sanitizeInvoiceDate = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const parsed = parseIsoDate(value);
    if (parsed) return formatIsoDate(parsed);
  }
  const parsedFallback = parseIsoDate(fallback);
  if (parsedFallback) return formatIsoDate(parsedFallback);
  return defaultLastInvoiceDate;
};

const computeNextInvoiceDate = (input: {
  lastInvoice: string;
  cycleDays: number;
}): string => {
  const parsed = parseIsoDate(input.lastInvoice);
  if (!parsed) return defaultLastInvoiceDate;
  const increment = sanitizeCycleDays(input.cycleDays, 1);
  const next = new Date(parsed);
  next.setUTCDate(next.getUTCDate() + increment);
  return formatIsoDate(next);
};

const describePlanActivation = (
  plan: PlanDefinition,
  cycle: number,
  nextInvoice: string,
): string => {
  return `${plan.name} plan uses a ${cycle}-day cycle. Next invoice ${nextInvoice}`;
};

const describeInvoiceRecord = (
  plan: PlanDefinition,
  _cycle: number,
  invoice: string,
  nextInvoice: string,
): string => {
  return `Invoice recorded on ${invoice} for ${plan.name}. Next invoice ${nextInvoice}`;
};

const resolvePlanDefinition = (plan: PlanId): PlanDefinition => {
  return planCatalog[plan] ?? planCatalog[defaultPlan];
};

const changePlan = handler(
  (
    event: PlanChangeEvent | undefined,
    context: {
      plan: Cell<PlanId>;
      cycleOverride: Cell<number | null>;
      lastInvoice: Cell<string>;
      history: Cell<string[]>;
    },
  ) => {
    const currentPlan = sanitizePlanId(context.plan.get());
    const nextPlan = sanitizePlanId(event?.plan ?? currentPlan);
    const definition = resolvePlanDefinition(nextPlan);

    context.plan.set(nextPlan);

    if (event && Object.hasOwn(event, "cycleDays")) {
      const overrideValue = sanitizeCycleDays(
        event?.cycleDays,
        definition.cycleDays,
      );
      context.cycleOverride.set(overrideValue);
    } else if (currentPlan !== nextPlan) {
      context.cycleOverride.set(null);
    }

    const baseInvoice = sanitizeInvoiceDate(
      context.lastInvoice.get(),
      defaultLastInvoiceDate,
    );
    const updatedInvoice = event?.lastInvoiceDate
      ? sanitizeInvoiceDate(event.lastInvoiceDate, baseInvoice)
      : baseInvoice;
    context.lastInvoice.set(updatedInvoice);

    const resolvedCycle = sanitizeCycleDays(
      context.cycleOverride.get(),
      definition.cycleDays,
    );

    const nextInvoice = computeNextInvoiceDate({
      lastInvoice: updatedInvoice,
      cycleDays: resolvedCycle,
    });

    context.history.push(
      describePlanActivation(definition, resolvedCycle, nextInvoice),
    );
  },
);

const recordInvoice = handler(
  (
    event: InvoiceRecordedEvent | undefined,
    context: {
      plan: Cell<PlanId>;
      cycleOverride: Cell<number | null>;
      lastInvoice: Cell<string>;
      history: Cell<string[]>;
    },
  ) => {
    if (!event) return;
    const definition = resolvePlanDefinition(
      sanitizePlanId(context.plan.get()),
    );
    const resolvedCycle = sanitizeCycleDays(
      context.cycleOverride.get(),
      definition.cycleDays,
    );
    const previousInvoice = sanitizeInvoiceDate(
      context.lastInvoice.get(),
      defaultLastInvoiceDate,
    );
    const appliedInvoice = sanitizeInvoiceDate(
      event.date,
      previousInvoice,
    );
    context.lastInvoice.set(appliedInvoice);
    const nextInvoice = computeNextInvoiceDate({
      lastInvoice: appliedInvoice,
      cycleDays: resolvedCycle,
    });
    context.history.push(
      describeInvoiceRecord(
        definition,
        resolvedCycle,
        appliedInvoice,
        nextInvoice,
      ),
    );
  },
);

// Module-scope lift definitions
const liftSanitizePlanId = lift(sanitizePlanId);
const liftResolvePlanDefinition = lift(resolvePlanDefinition);

const liftCycleDays = lift((input: {
  plan: PlanId;
  override: number | null;
}) => {
  const definition = resolvePlanDefinition(input.plan);
  if (input.override === null || input.override === undefined) {
    return definition.cycleDays;
  }
  return sanitizeCycleDays(input.override, definition.cycleDays);
});

const liftNormalizedInvoice = lift((value: string | undefined) =>
  sanitizeInvoiceDate(value, defaultLastInvoiceDate)
);

const liftComputeNextInvoiceDate = lift(computeNextInvoiceDate);

const liftPlanName = lift((detail: PlanDefinition) => detail.name);
const liftPriceLabel = lift((detail: PlanDefinition) =>
  formatCurrency(detail.price)
);
const liftCycleLabel = lift((cycle: number) => `${cycle} days`);

export const subscriptionBilling = pattern<SubscriptionBillingArgs>(
  ({ plan, lastInvoiceDate }) => {
    const cycleOverride = cell<number | null>(null);
    const history = cell<string[]>([]);

    const currentPlan = liftSanitizePlanId(plan);
    const planDetails = liftResolvePlanDefinition(currentPlan);

    const cycleDays = liftCycleDays({
      plan: currentPlan,
      override: cycleOverride,
    });

    const normalizedInvoice = liftNormalizedInvoice(lastInvoiceDate);

    const nextInvoiceDate = liftComputeNextInvoiceDate({
      lastInvoice: normalizedInvoice,
      cycleDays,
    });

    const planName = liftPlanName(planDetails);
    const priceLabel = liftPriceLabel(planDetails);
    const cycleLabel = liftCycleLabel(cycleDays);

    const summary =
      str`${planName} plan renews on ${nextInvoiceDate} for ${priceLabel}`;

    return {
      planId: currentPlan,
      planName,
      planPrice: priceLabel,
      cycleDays,
      cycleLabel,
      lastInvoiceDate: normalizedInvoice,
      nextInvoiceDate,
      summary,
      history,
      changePlan: changePlan({
        plan,
        cycleOverride,
        lastInvoice: lastInvoiceDate,
        history,
      }),
      recordInvoice: recordInvoice({
        plan,
        cycleOverride,
        lastInvoice: lastInvoiceDate,
        history,
      }),
    };
  },
);

export default subscriptionBilling;
