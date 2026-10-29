import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

interface QuoteOptionSeed {
  id: string;
  label: string;
  price: number;
  defaultSelected: boolean;
}

interface QuoteOptionInput extends Partial<QuoteOptionSeed> {}

interface QuoteOption {
  id: string;
  label: string;
  price: number;
  selected: boolean;
}

interface ToggleOptionEvent {
  id?: string;
}

interface ConfigureOptionEvent {
  id?: string;
  price?: number;
  selected?: boolean;
  label?: string;
}

interface ConfigurePricingEvent {
  basePrice?: number;
  discountRate?: number;
}

interface QuoteConfigurationArgs {
  basePrice: Default<number, 1800>;
  discountRate: Default<number, 0>;
  options: Default<QuoteOptionInput[], typeof defaultOptionSeeds>;
}

interface PricingDetails {
  base: number;
  optionsTotal: number;
  subtotal: number;
  discountAmount: number;
  total: number;
}

const defaultBasePrice = 1800;

const defaultOptionSeeds: QuoteOptionSeed[] = [
  {
    id: "support",
    label: "Priority support",
    price: 250,
    defaultSelected: true,
  },
  {
    id: "training",
    label: "Team onboarding workshop",
    price: 450,
    defaultSelected: false,
  },
  {
    id: "analytics",
    label: "Advanced analytics suite",
    price: 600,
    defaultSelected: false,
  },
  {
    id: "compliance",
    label: "Regulatory compliance review",
    price: 320,
    defaultSelected: false,
  },
];

const maxDiscountRate = 0.5;
const currencyPrecision = 100;

const clampCurrency = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.max(value, 0) * currencyPrecision) / currencyPrecision;
};

const toIdentifier = (value: string): string => {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
};

const sanitizeLabel = (
  maybeLabel: unknown,
  fallback: string,
  index: number,
): string => {
  if (typeof maybeLabel === "string") {
    const trimmed = maybeLabel.trim();
    if (trimmed.length > 0) {
      return trimmed.slice(0, 64);
    }
  }
  if (fallback.length > 0) {
    return fallback.slice(0, 64);
  }
  return `Option ${index + 1}`;
};

const sanitizeId = (
  maybeId: unknown,
  label: string,
  fallback: string,
  index: number,
  used: Set<string>,
): string => {
  const base = typeof maybeId === "string" && maybeId.trim().length > 0
    ? toIdentifier(maybeId)
    : toIdentifier(label.length > 0 ? label : fallback);
  let candidate = base.length > 0 ? base : `option-${index + 1}`;
  if (!used.has(candidate)) {
    return candidate;
  }
  let attempt = 1;
  while (used.has(candidate)) {
    attempt += 1;
    const suffix = `-${attempt}`;
    const sliceLength = Math.max(16, 48 - suffix.length);
    candidate = `${candidate.slice(0, sliceLength)}${suffix}`;
  }
  return candidate;
};

const sanitizePrice = (maybePrice: unknown, fallback: number): number => {
  if (typeof maybePrice === "number" && Number.isFinite(maybePrice)) {
    return clampCurrency(maybePrice);
  }
  return clampCurrency(fallback);
};

const sanitizeSelected = (
  maybeSelected: unknown,
  fallback: boolean,
): boolean => {
  if (typeof maybeSelected === "boolean") {
    return maybeSelected;
  }
  return fallback;
};

const sanitizeOptionList = (
  value: readonly QuoteOptionInput[] | undefined,
): QuoteOption[] => {
  const source = Array.isArray(value) && value.length > 0
    ? value
    : defaultOptionSeeds;
  const sanitized: QuoteOption[] = [];
  const usedIds = new Set<string>();
  for (let index = 0; index < source.length; index += 1) {
    const entry = source[index];
    const fallback = defaultOptionSeeds[index] ?? defaultOptionSeeds[0];
    const label = sanitizeLabel(
      entry?.label,
      fallback?.label ?? `Option ${index + 1}`,
      index,
    );
    const id = sanitizeId(
      entry?.id,
      label,
      fallback?.id ?? label,
      index,
      usedIds,
    );
    const price = sanitizePrice(entry?.price, fallback?.price ?? 0);
    const selected = sanitizeSelected(
      entry?.defaultSelected,
      fallback?.defaultSelected ?? false,
    );
    sanitized.push({ id, label, price, selected });
    usedIds.add(id);
  }
  if (sanitized.length === 0) {
    const fallback: QuoteOption[] = [];
    for (let index = 0; index < defaultOptionSeeds.length; index += 1) {
      const seed = defaultOptionSeeds[index];
      const id = sanitizeId(seed.id, seed.label, seed.id, index, usedIds);
      usedIds.add(id);
      fallback.push({
        id,
        label: seed.label,
        price: clampCurrency(seed.price),
        selected: seed.defaultSelected,
      });
    }
    return fallback;
  }
  return sanitized;
};

const normalizeOptionId = (value: unknown): string | null => {
  if (value == null) return null;
  const raw = typeof value === "string" ? value : String(value);
  const normalized = toIdentifier(raw);
  return normalized.length > 0 ? normalized : null;
};

const toRawOptionId = (value: unknown): string | null => {
  if (value == null) return null;
  const raw = typeof value === "string" ? value : String(value);
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 64) : null;
};

const optionMatchesId = (
  option: QuoteOption,
  normalized: string | null,
  raw: string | null,
): boolean => {
  if (normalized && option.id === normalized) return true;
  if (raw && option.id === raw) return true;
  if (raw) {
    const lowered = raw.toLowerCase();
    if (option.label.toLowerCase() === lowered) return true;
    const slugged = toIdentifier(raw);
    if (slugged.length > 0 && option.id === slugged) return true;
  }
  return false;
};

const sanitizeBasePrice = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return clampCurrency(defaultBasePrice);
  }
  return clampCurrency(Math.max(value, 0));
};

const sanitizeDiscountRate = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  if (value <= 0) return 0;
  if (value >= maxDiscountRate) return maxDiscountRate;
  return Math.round(value * 1000) / 1000;
};

const toggleOptionSelection = handler(
  (
    event: ToggleOptionEvent | undefined,
    context: { options: Cell<QuoteOption[]> },
  ) => {
    const normalizedId = normalizeOptionId(event?.id);
    const rawId = toRawOptionId(event?.id);
    if (!normalizedId && !rawId) return;
    const current = context.options.get();
    if (!Array.isArray(current) || current.length === 0) {
      return;
    }
    let changed = false;
    for (let index = 0; index < current.length; index += 1) {
      const option = current[index];
      if (!optionMatchesId(option, normalizedId, rawId)) {
        continue;
      }
      const selectedCell = context.options.key(index).key("selected");
      selectedCell.set(!option.selected);
      changed = true;
    }
    if (!changed) {
      return;
    }
  },
);

const configureOption = handler(
  (
    event: ConfigureOptionEvent | undefined,
    context: { options: Cell<QuoteOption[]> },
  ) => {
    const normalizedId = normalizeOptionId(event?.id);
    const rawId = toRawOptionId(event?.id);
    if (!normalizedId && !rawId) return;
    const current = context.options.get();
    if (!Array.isArray(current) || current.length === 0) {
      return;
    }
    let _changed = false;
    for (let index = 0; index < current.length; index += 1) {
      const option = current[index];
      if (!optionMatchesId(option, normalizedId, rawId)) {
        continue;
      }
      const price =
        typeof event?.price === "number" && Number.isFinite(event.price)
          ? clampCurrency(Math.max(event.price, 0))
          : option.price;
      const selected = typeof event?.selected === "boolean"
        ? event.selected
        : option.selected;
      const label = typeof event?.label === "string" && event.label.trim()
        ? event.label.trim().slice(0, 64)
        : option.label;
      if (price !== option.price) {
        context.options.key(index).key("price").set(price);
        _changed = true;
      }
      if (selected !== option.selected) {
        context.options.key(index).key("selected").set(selected);
        _changed = true;
      }
      if (label !== option.label) {
        context.options.key(index).key("label").set(label);
        _changed = true;
      }
    }
  },
);

const configurePricing = handler(
  (
    event: ConfigurePricingEvent | undefined,
    context: { basePrice: Cell<number>; discountRate: Cell<number> },
  ) => {
    if (
      typeof event?.basePrice === "number" && Number.isFinite(event.basePrice)
    ) {
      context.basePrice.set(sanitizeBasePrice(event.basePrice));
    }
    if (
      typeof event?.discountRate === "number" &&
      Number.isFinite(event.discountRate)
    ) {
      context.discountRate.set(sanitizeDiscountRate(event.discountRate));
    }
  },
);

// Module-scope lift definitions
const liftSanitizeBasePrice = lift(sanitizeBasePrice);
const liftSanitizeDiscountRate = lift(sanitizeDiscountRate);

const liftOptionsView = lift((list: QuoteOption[] | undefined) => {
  if (!Array.isArray(list)) {
    return [] as QuoteOption[];
  }
  return list.map((option) => ({ ...option }));
});

const liftSelectedOptionIds = lift((list: QuoteOption[]) => {
  return list.filter((option) => option.selected).map((option) => option.id);
});

const liftPricing = lift((input: {
  base: number;
  addOns: QuoteOption[];
  discount: number;
}): PricingDetails => {
  const addOnTotal = input.addOns.reduce((total, option) => {
    return option.selected ? total + option.price : total;
  }, 0);
  const normalizedBase = clampCurrency(input.base);
  const normalizedAddOns = clampCurrency(addOnTotal);
  const subtotal = clampCurrency(normalizedBase + normalizedAddOns);
  const discountAmount = clampCurrency(subtotal * input.discount);
  const total = clampCurrency(subtotal - discountAmount);
  return {
    base: normalizedBase,
    optionsTotal: normalizedAddOns,
    subtotal,
    discountAmount,
    total,
  };
});

const liftSubtotal = lift((details: PricingDetails) => details.subtotal);
const liftDiscountAmount = lift((details: PricingDetails) =>
  details.discountAmount
);
const liftTotal = lift((details: PricingDetails) => details.total);
const liftOptionsTotal = lift((details: PricingDetails) =>
  details.optionsTotal
);
const liftFormatCurrency = lift((value: number) => `$${value.toFixed(2)}`);

const liftSyncOptions = lift((raw: QuoteOptionInput[] | undefined) => {
  return sanitizeOptionList(raw);
});

export const quoteConfiguration = pattern<QuoteConfigurationArgs>(
  ({ basePrice, discountRate, options }) => {
    const initialOptions = sanitizeOptionList(undefined);
    const optionState = cell<QuoteOption[]>(initialOptions);

    const syncOptions = liftSyncOptions(options);

    const safeBasePrice = liftSanitizeBasePrice(basePrice);
    const safeDiscountRate = liftSanitizeDiscountRate(discountRate);

    const optionsView = liftOptionsView(optionState);

    const selectedOptionIds = liftSelectedOptionIds(optionsView);

    const pricing = liftPricing({
      base: safeBasePrice,
      addOns: optionsView,
      discount: safeDiscountRate,
    });

    const subtotal = liftSubtotal(pricing);
    const discountAmount = liftDiscountAmount(pricing);
    const total = liftTotal(pricing);
    const optionsTotal = liftOptionsTotal(pricing);

    const formattedTotal = liftFormatCurrency(total);
    const formattedDiscount = liftFormatCurrency(discountAmount);
    const summary =
      str`Quote total ${formattedTotal} (discount ${formattedDiscount})`;

    return {
      basePrice: safeBasePrice,
      discountRate: safeDiscountRate,
      options: optionsView,
      selectedOptionIds,
      optionsTotal,
      subtotal,
      discountAmount,
      total,
      summary,
      pricing,
      toggleOption: toggleOptionSelection({ options: optionState }),
      configureOption: configureOption({ options: optionState }),
      configurePricing: configurePricing({
        basePrice,
        discountRate,
      }),
      effects: { syncOptions },
    };
  },
);

export default quoteConfiguration;
