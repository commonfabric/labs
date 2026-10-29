import { type Cell, Default, handler, lift, pattern, str } from "commonfabric";

interface CurrencyConversionArgs {
  baseCurrency: Default<string, "USD">;
  amount: Default<number, 100>;
  rates: Default<Record<string, number>, {
    USD: 1;
    EUR: 0.92;
    GBP: 0.78;
  }>;
  targets: Default<string[], ["USD", "EUR", "GBP"]>;
}

interface RateUpdateEvent {
  currency?: string;
  rate?: number;
}

interface AmountUpdateEvent {
  amount?: number;
}

const roundTo = (value: number, places: number): number => {
  const multiplier = 10 ** places;
  return Math.round(value * multiplier) / multiplier;
};

const sanitizeCode = (code: unknown, fallback: string): string => {
  if (typeof code === "string") {
    const trimmed = code.trim().toUpperCase();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
};

const sanitizeAmount = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return roundTo(value, 2);
};

const sanitizeRate = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = roundTo(value, 4);
  return normalized > 0 ? normalized : fallback;
};

const sanitizeRateMap = (
  value: Record<string, number> | undefined,
  base: string,
): Record<string, number> => {
  const sanitized: Record<string, number> = {};
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      const code = sanitizeCode(key, base);
      sanitized[code] = code === base ? 1 : sanitizeRate(value[key], 1);
    }
  }
  sanitized[base] = 1;
  return sanitized;
};

const ensureTargetList = (
  targets: readonly string[] | undefined,
  base: string,
  rateKeys: readonly string[],
): string[] => {
  const codes = new Set<string>();
  codes.add(base);
  if (targets) {
    for (const entry of targets) {
      codes.add(sanitizeCode(entry, base));
    }
  }
  for (const key of rateKeys) {
    codes.add(sanitizeCode(key, base));
  }
  const list = Array.from(codes);
  list.sort((left, right) => left.localeCompare(right));
  return list;
};

const computeConversions = (
  data: {
    amount: number;
    base: string;
    rates: Record<string, number>;
    codes: readonly string[];
  },
): Record<string, number> => {
  const conversions: Record<string, number> = {};
  for (const code of data.codes) {
    if (code === data.base) {
      conversions[code] = roundTo(data.amount, 2);
      continue;
    }
    const rate = sanitizeRate(data.rates[code], 1);
    conversions[code] = roundTo(data.amount * rate, 2);
  }
  return conversions;
};

const setBaseAmount = handler(
  (
    event: AmountUpdateEvent | number | undefined,
    context: { amount: Cell<number> },
  ) => {
    const fallback = sanitizeAmount(context.amount.get(), 0);
    if (typeof event === "number") {
      context.amount.set(sanitizeAmount(event, fallback));
      return;
    }
    if (typeof event?.amount === "number") {
      context.amount.set(sanitizeAmount(event.amount, fallback));
      return;
    }
    if (event === undefined) {
      context.amount.set(fallback);
    }
  },
);

const setConversionRate = handler(
  (
    event: RateUpdateEvent | undefined,
    context: {
      rates: Cell<Record<string, number>>;
      targets: Cell<string[]>;
      baseCurrency: Cell<string>;
    },
  ) => {
    const base = sanitizeCode(context.baseCurrency.get(), "USD");
    const normalized = sanitizeRateMap(context.rates.get(), base);
    const target = sanitizeCode(event?.currency, base);
    const existing = normalized[target] ?? 1;
    const nextRate = target === base ? 1 : sanitizeRate(event?.rate, existing);
    normalized[target] = nextRate;
    normalized[base] = 1;
    context.rates.set({ ...normalized });
    const updatedTargets = ensureTargetList(
      context.targets.get(),
      base,
      Object.keys(normalized),
    );
    context.targets.set(updatedTargets);
  },
);

const liftSanitizeCode = lift((value: string | undefined) =>
  sanitizeCode(value, "USD")
);

const liftSanitizeAmount = lift((value: number | undefined) =>
  sanitizeAmount(value, 0)
);

const liftNormalizeRates = lift((inputs: {
  rates: Record<string, number> | undefined;
  base: string;
}) => sanitizeRateMap(inputs.rates, inputs.base));

const liftCurrencyCodes = lift((inputs: {
  targets: string[] | undefined;
  base: string;
  normalizedRates: Record<string, number>;
}) =>
  ensureTargetList(
    inputs.targets,
    inputs.base,
    Object.keys(inputs.normalizedRates),
  )
);

const liftComputeConversions = lift((inputs: {
  amount: number;
  base: string;
  rates: Record<string, number>;
  codes: string[];
}) =>
  computeConversions({
    amount: inputs.amount,
    base: inputs.base,
    rates: inputs.rates,
    codes: inputs.codes,
  })
);

const liftConversionList = lift((inputs: {
  codes: string[];
  conversions: Record<string, number>;
}) =>
  inputs.codes.map((code) => {
    const value = inputs.conversions[code] ?? 0;
    return `${code} ${value.toFixed(2)}`;
  })
);

const liftCurrencyCount = lift((codes: string[]) => codes.length);

const liftAmountLabel = lift((value: number) => value.toFixed(2));

export const currencyConversionPattern = pattern<CurrencyConversionArgs>(
  ({ amount, baseCurrency, rates, targets }) => {
    const baseCode = liftSanitizeCode(baseCurrency);

    const normalizedAmount = liftSanitizeAmount(amount);

    const normalizedRates = liftNormalizeRates({
      rates,
      base: baseCode,
    });

    const currencyCodes = liftCurrencyCodes({
      targets,
      base: baseCode,
      normalizedRates,
    });

    const conversions = liftComputeConversions({
      amount: normalizedAmount,
      base: baseCode,
      rates: normalizedRates,
      codes: currencyCodes,
    });

    const conversionList = liftConversionList({
      codes: currencyCodes,
      conversions,
    });

    const currencyCount = liftCurrencyCount(currencyCodes);

    const amountLabel = liftAmountLabel(normalizedAmount);

    const summary =
      str`${amountLabel} ${baseCode} across ${currencyCount} currencies`;

    return {
      amount,
      baseCurrency,
      rates,
      targets,
      baseCode,
      normalizedAmount,
      normalizedRates,
      currencyCodes,
      conversions,
      conversionList,
      currencyCount,
      summary,
      setAmount: setBaseAmount({ amount }),
      updateRate: setConversionRate({
        rates,
        targets,
        baseCurrency,
      }),
    };
  },
);

export default currencyConversionPattern;
