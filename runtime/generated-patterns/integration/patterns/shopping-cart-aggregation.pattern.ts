import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

interface CartItemInput {
  id?: string;
  name?: string;
  price?: number;
  quantity?: number;
  category?: string;
}

interface DiscountRuleInput {
  id?: string;
  label?: string;
  category?: string;
  threshold?: number;
  percent?: number;
}

interface ShoppingCartArgs {
  items: Default<CartItemInput[], []>;
  discounts: Default<DiscountRuleInput[], []>;
}

interface CartItem {
  id: string;
  name: string;
  price: number;
  quantity: number;
  category: string;
}

interface DiscountRule {
  id: string;
  label: string;
  category: string;
  threshold: number;
  percent: number;
}

interface LineTotal {
  id: string;
  name: string;
  category: string;
  unitPrice: number;
  quantity: number;
  subtotal: number;
}

interface CategoryTotal {
  category: string;
  quantity: number;
  subtotal: number;
}

interface DiscountApplication {
  id: string;
  label: string;
  category: string;
  threshold: number;
  percent: number;
  qualified: boolean;
  amount: number;
}

type CartEvent =
  | { type: "add"; item?: CartItemInput }
  | { type: "update"; id?: string; quantity?: number; price?: number }
  | { type: "remove"; id?: string }
  | { type: "clear" };

type DiscountEvent =
  | { type?: "replace"; rules?: DiscountRuleInput[] }
  | { type: "clear" };

const defaultItemName = "Item";
const defaultCategory = "general";

const clampNumber = (value: number, min: number, max: number): number => {
  if (Number.isNaN(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
};

const normalizeString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const claimIdentifier = (base: string, used: Set<string>): string => {
  let candidate = base;
  let suffix = 1;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
};

const sanitizeName = (value: unknown, index: number): string => {
  const normalized = normalizeString(value);
  if (normalized) return normalized;
  return `${defaultItemName} ${index + 1}`;
};

const sanitizeCategory = (value: unknown): string => {
  const normalized = normalizeString(value)?.toLowerCase();
  if (normalized) return normalized;
  return defaultCategory;
};

const sanitizePrice = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return clampNumber(Math.round(value * 100) / 100, 0, 1_000_000);
  }
  return 0;
};

const sanitizeQuantity = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const rounded = Math.trunc(value);
    return clampNumber(rounded, 0, 10_000);
  }
  return 1;
};

const sanitizePercent = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return clampNumber(Math.round(value * 100) / 100, 0, 100);
  }
  return 0;
};

const sanitizeThreshold = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const rounded = Math.trunc(value);
    return clampNumber(rounded, 1, 10_000);
  }
  return 1;
};

const sanitizeCartItem = (
  input: CartItemInput | undefined,
  index: number,
  used: Set<string>,
): CartItem => {
  const providedId = normalizeString(input?.id)?.toLowerCase();
  const fallback = `item-${index + 1}`;
  const id = providedId ?? claimIdentifier(fallback, used);
  const name = sanitizeName(input?.name ?? id, index);
  const price = sanitizePrice(input?.price);
  const quantity = sanitizeQuantity(input?.quantity);
  const category = sanitizeCategory(input?.category);
  return { id, name, price, quantity, category };
};

const sanitizeCartItems = (
  entries: readonly CartItemInput[] | undefined,
): CartItem[] => {
  const result: CartItem[] = [];
  const list = Array.isArray(entries) ? entries : [];
  const used = new Set<string>();
  for (let index = 0; index < list.length; index++) {
    const sanitized = sanitizeCartItem(list[index], index, used);
    used.add(sanitized.id);
    result.push(sanitized);
  }
  return result;
};

const sanitizeDiscountRule = (
  input: DiscountRuleInput | undefined,
  index: number,
  used: Set<string>,
): DiscountRule => {
  const providedId = normalizeString(input?.id)?.toLowerCase();
  const fallback = `rule-${index + 1}`;
  const id = providedId ?? claimIdentifier(fallback, used);
  const label = sanitizeName(input?.label ?? id, index);
  const category = sanitizeCategory(input?.category);
  const threshold = sanitizeThreshold(input?.threshold);
  const percent = sanitizePercent(input?.percent);
  return { id, label, category, threshold, percent };
};

const sanitizeDiscountRules = (
  entries: readonly DiscountRuleInput[] | undefined,
): DiscountRule[] => {
  const result: DiscountRule[] = [];
  const list = Array.isArray(entries) ? entries : [];
  const used = new Set<string>();
  for (let index = 0; index < list.length; index++) {
    const sanitized = sanitizeDiscountRule(list[index], index, used);
    used.add(sanitized.id);
    result.push(sanitized);
  }
  return result;
};

const roundCurrency = (value: number): number => {
  return Math.round(value * 100) / 100;
};

const formatCurrency = (value: number): string => {
  return `$${roundCurrency(value).toFixed(2)}`;
};

const computeLineTotals = (items: CartItem[]): LineTotal[] => {
  return items.map((item) => {
    const subtotal = roundCurrency(item.price * item.quantity);
    return {
      id: item.id,
      name: item.name,
      category: item.category,
      unitPrice: item.price,
      quantity: item.quantity,
      subtotal,
    };
  });
};

const computeCategoryTotals = (items: CartItem[]): CategoryTotal[] => {
  const map = new Map<string, { quantity: number; subtotal: number }>();
  for (const item of items) {
    const entry = map.get(item.category) ?? { quantity: 0, subtotal: 0 };
    entry.quantity += item.quantity;
    entry.subtotal = roundCurrency(entry.subtotal + item.price * item.quantity);
    map.set(item.category, entry);
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([category, entry]) => ({
      category,
      quantity: entry.quantity,
      subtotal: roundCurrency(entry.subtotal),
    }));
};

const computeDiscountApplications = (
  rules: DiscountRule[],
  totals: CategoryTotal[],
): DiscountApplication[] => {
  const index = new Map<string, CategoryTotal>();
  for (const entry of totals) {
    index.set(entry.category, entry);
  }
  return rules.map((rule) => {
    const bucket = index.get(rule.category);
    if (!bucket) {
      return { ...rule, qualified: false, amount: 0 };
    }
    const qualified = bucket.quantity >= rule.threshold && rule.percent > 0;
    if (!qualified) {
      return { ...rule, qualified, amount: 0 };
    }
    const raw = (bucket.subtotal * rule.percent) / 100;
    return { ...rule, qualified, amount: roundCurrency(raw) };
  });
};

const sumLineSubtotal = (lines: LineTotal[]): number => {
  let total = 0;
  for (const line of lines) {
    total = roundCurrency(total + line.subtotal);
  }
  return total;
};

const sumLineQuantity = (lines: LineTotal[]): number => {
  let total = 0;
  for (const line of lines) {
    total += line.quantity;
  }
  return total;
};

const sumDiscountAmount = (entries: DiscountApplication[]): number => {
  let total = 0;
  for (const entry of entries) {
    total = roundCurrency(total + entry.amount);
  }
  return total;
};

const modifyCart = handler(
  (
    event: CartEvent | undefined,
    context: { items: Cell<CartItemInput[]>; history: Cell<string[]> },
  ) => {
    if (!event || typeof event !== "object") return;

    const current = sanitizeCartItems(context.items.get());
    const used = new Set(current.map((item) => item.id));
    const existingHistory = context.history.get();
    const history = Array.isArray(existingHistory) ? [...existingHistory] : [];

    switch (event.type) {
      case "add": {
        const sanitized = sanitizeCartItem(event.item, current.length, used);
        const index = current.findIndex((item) => item.id === sanitized.id);
        const next = index >= 0
          ? current.map((item, position) =>
            position === index ? sanitized : item
          )
          : [...current, sanitized];
        const amountLabel = `${sanitized.quantity} x ` +
          `${formatCurrency(sanitized.price)}`;
        const message = index >= 0
          ? `Replaced ${sanitized.id} with ${amountLabel}`
          : `Added ${sanitized.id} with ${amountLabel}`;
        context.items.set(next);
        context.history.set([...history, message]);
        break;
      }
      case "update": {
        const id = normalizeString(event.id)?.toLowerCase();
        if (!id) return;
        const index = current.findIndex((item) => item.id === id);
        if (index === -1) return;
        const existing = current[index];
        const quantity = event.quantity === undefined
          ? existing.quantity
          : sanitizeQuantity(event.quantity);
        const price = event.price === undefined
          ? existing.price
          : sanitizePrice(event.price);
        const updated: CartItem = {
          ...existing,
          quantity,
          price,
        };
        const next = current.map((item, position) => {
          return position === index ? updated : item;
        });
        const message = `Updated ${updated.id} to ${updated.quantity} x ` +
          `${formatCurrency(updated.price)}`;
        context.items.set(next);
        context.history.set([...history, message]);
        break;
      }
      case "remove": {
        const id = normalizeString(event.id)?.toLowerCase();
        if (!id) return;
        if (!current.some((item) => item.id === id)) return;
        const next = current.filter((item) => item.id !== id);
        const message = `Removed ${id} from cart`;
        context.items.set(next);
        context.history.set([...history, message]);
        break;
      }
      case "clear": {
        if (current.length === 0) return;
        context.items.set([]);
        context.history.set([...history, "Cleared cart items"]);
        break;
      }
    }
  },
);

const configureDiscounts = handler(
  (
    event: DiscountEvent | undefined,
    context: { discounts: Cell<DiscountRuleInput[]>; history: Cell<string[]> },
  ) => {
    if (!event || typeof event !== "object") return;

    const history = Array.isArray(context.history.get())
      ? [...context.history.get()]
      : [];

    if (event.type === "clear") {
      context.discounts.set([]);
      context.history.set([...history, "Cleared discounts"]);
      return;
    }

    const rules = sanitizeDiscountRules(event.rules);
    context.discounts.set(rules);
    const message = `Configured ${rules.length} discount rule(s)`;
    context.history.set([...history, message]);
  },
);

// Module-scope lift definitions
const liftSanitizeCartItems = lift(sanitizeCartItems);
const liftSanitizeDiscountRules = lift(sanitizeDiscountRules);
const liftComputeCategoryTotals = lift(computeCategoryTotals);
const liftComputeLineTotals = lift(computeLineTotals);
const liftSumLineSubtotal = lift(sumLineSubtotal);
const liftSumLineQuantity = lift(sumLineQuantity);

const liftDiscountApplications = lift((input: {
  rules: DiscountRule[];
  totals: CategoryTotal[];
}) => computeDiscountApplications(input.rules, input.totals));

const liftSumDiscountAmount = lift(sumDiscountAmount);

const liftGrandTotal = lift((input: { subtotal: number; discount: number }) =>
  roundCurrency(Math.max(0, input.subtotal - input.discount))
);

const liftFormatCurrency = lift(formatCurrency);

const liftLastEvent = lift((input: { log: string[]; lines: LineTotal[] }) => {
  if (!Array.isArray(input.log) || input.log.length === 0) {
    const count = Array.isArray(input.lines) ? input.lines.length : 0;
    return `Cart initialized with ${count} item(s)`;
  }
  return input.log[input.log.length - 1];
});

export const shoppingCartAggregation = pattern<ShoppingCartArgs>(
  ({ items, discounts }) => {
    const cartItems = liftSanitizeCartItems(items);
    const discountRules = liftSanitizeDiscountRules(discounts);

    const categoryTotals = liftComputeCategoryTotals(cartItems);
    const lineTotals = liftComputeLineTotals(cartItems);

    const subtotal = liftSumLineSubtotal(lineTotals);

    const itemCount = liftSumLineQuantity(lineTotals);

    const discountApplications = liftDiscountApplications({
      rules: discountRules,
      totals: categoryTotals,
    });

    const totalDiscount = liftSumDiscountAmount(discountApplications);

    const grandTotal = liftGrandTotal({
      subtotal,
      discount: totalDiscount,
    });

    const subtotalDisplay = liftFormatCurrency(subtotal);
    const discountDisplay = liftFormatCurrency(totalDiscount);
    const totalDisplay = liftFormatCurrency(grandTotal);

    const history = cell<string[]>([]);
    const lastEvent = liftLastEvent({
      log: history,
      lines: lineTotals,
    });

    const summary =
      str`Cart subtotal ${subtotalDisplay} • discount ${discountDisplay} • total ${totalDisplay}`;

    return {
      items: cartItems,
      discountRules,
      categoryTotals,
      lineTotals,
      discountBreakdown: discountApplications,
      subtotal,
      itemCount,
      totalDiscount,
      total: grandTotal,
      summary,
      history,
      lastEvent,
      modify: modifyCart({ items, history }),
      configureDiscounts: configureDiscounts({ discounts, history }),
    };
  },
);

export default shoppingCartAggregation;
