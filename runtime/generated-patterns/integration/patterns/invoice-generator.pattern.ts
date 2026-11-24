import { type Cell, Default, handler, lift, pattern, str } from "commonfabric";

interface InvoiceItemInput {
  id?: string;
  description?: string;
  quantity?: number;
  unitPrice?: number;
  itemDiscountRate?: number;
}

interface InvoiceItem {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  itemDiscountRate: number;
}

interface InvoiceLineSummary extends InvoiceItem {
  baseTotal: number;
  itemDiscountAmount: number;
  lineTotal: number;
}

interface InvoiceTotals {
  subtotal: number;
  itemDiscountTotal: number;
  invoiceDiscountRate: number;
  invoiceDiscountAmount: number;
  discountedSubtotal: number;
  taxRate: number;
  taxAmount: number;
  totalDue: number;
}

interface InvoiceGeneratorArgs {
  items: Default<InvoiceItemInput[], typeof defaultItems>;
  taxRate: Default<number, 0.0725>;
  invoiceDiscountRate: Default<number, 0.05>;
}

interface UpdateItemEvent extends InvoiceItemInput {
  id?: string;
}

interface RateUpdateEvent {
  taxRate?: number;
  invoiceDiscountRate?: number;
}

const defaultItems: InvoiceItemInput[] = [
  {
    id: "design-services",
    description: "Design sprint and prototyping",
    quantity: 12,
    unitPrice: 120,
    itemDiscountRate: 0.1,
  },
  {
    id: "implementation",
    description: "Implementation sprint",
    quantity: 40,
    unitPrice: 95,
    itemDiscountRate: 0.05,
  },
  {
    id: "managed-hosting",
    description: "Managed hosting",
    quantity: 12,
    unitPrice: 12.5,
    itemDiscountRate: 0,
  },
];

const roundCurrency = (value: number): number => {
  return Math.round(value * 100) / 100;
};

const roundRate = (value: number): number => {
  return Math.round(value * 10000) / 10000;
};

const clampRate = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  if (value < 0) return 0;
  if (value > 1) return 1;
  return roundRate(value);
};

const sanitizeQuantity = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return Math.max(0, Math.round(fallback));
  }
  const normalized = Math.round(value);
  return normalized >= 0 ? normalized : 0;
};

const sanitizeMoney = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return roundCurrency(Math.max(0, fallback));
  }
  return roundCurrency(Math.max(0, value));
};

const sanitizeText = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed.slice(0, 80);
    }
  }
  return fallback;
};

const slugify = (value: string): string => {
  return value.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
};

const sanitizeIdentifier = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const slug = slugify(value.trim());
    if (slug.length > 0) return slug;
  }
  const fallbackSlug = slugify(fallback);
  return fallbackSlug.length > 0 ? fallbackSlug : "line";
};

const ensureUniqueId = (
  candidate: string,
  used: Set<string>,
  fallback: string,
): string => {
  const base = candidate.length > 0 ? candidate : fallback;
  let id = base.length > 0 ? base : fallback;
  let suffix = 2;
  while (used.has(id)) {
    id = `${base}-${suffix}`;
    suffix++;
  }
  used.add(id);
  return id;
};

const fallbackItemForIndex = (index: number): InvoiceItemInput => {
  const template = defaultItems[index];
  if (template) return template;
  return {
    id: `line-${index + 1}`,
    description: `Line ${index + 1}`,
    quantity: 1,
    unitPrice: 100,
    itemDiscountRate: 0,
  };
};

const sanitizeInvoiceItem = (
  raw: InvoiceItemInput | undefined,
  fallback: InvoiceItemInput,
  index: number,
  used: Set<string>,
): InvoiceItem => {
  const fallbackId = sanitizeIdentifier(fallback.id, `line-${index + 1}`);
  const candidateId = sanitizeIdentifier(raw?.id, fallbackId);
  const id = ensureUniqueId(candidateId, used, fallbackId);
  const fallbackDescription = sanitizeText(
    fallback.description,
    `Line ${index + 1}`,
  );
  const description = sanitizeText(raw?.description, fallbackDescription);
  const fallbackQuantity = sanitizeQuantity(fallback.quantity, 1);
  const quantity = sanitizeQuantity(raw?.quantity, fallbackQuantity);
  const fallbackUnitPrice = sanitizeMoney(fallback.unitPrice, 100);
  const unitPrice = sanitizeMoney(raw?.unitPrice, fallbackUnitPrice);
  const fallbackDiscount = clampRate(fallback.itemDiscountRate, 0);
  const itemDiscountRate = clampRate(
    raw?.itemDiscountRate,
    fallbackDiscount,
  );
  return { id, description, quantity, unitPrice, itemDiscountRate };
};

const sanitizeItemList = (
  value: readonly InvoiceItemInput[] | undefined,
  previous?: readonly InvoiceItem[],
): InvoiceItem[] => {
  const base = Array.isArray(value) ? value : [];
  const source = base.length > 0 ? base : defaultItems;
  const sanitized: InvoiceItem[] = [];
  const used = new Set<string>();

  for (let index = 0; index < source.length; index++) {
    const raw = source[index];
    const fallback = previous?.[index] ?? fallbackItemForIndex(index);
    const item = sanitizeInvoiceItem(raw, fallback, index, used);
    sanitized.push(item);
  }

  if (sanitized.length === 0) {
    return sanitizeItemList(defaultItems);
  }

  return sanitized;
};

const computeLineSummaries = (
  items: readonly InvoiceItem[],
): InvoiceLineSummary[] => {
  return items.map((item) => {
    const baseTotal = roundCurrency(item.quantity * item.unitPrice);
    const itemDiscountAmount = roundCurrency(
      baseTotal * clampRate(item.itemDiscountRate, 0),
    );
    const lineTotal = roundCurrency(baseTotal - itemDiscountAmount);
    return {
      ...item,
      baseTotal,
      itemDiscountAmount,
      lineTotal,
    };
  });
};

const computeInvoiceTotals = (
  lines: readonly InvoiceLineSummary[],
  invoiceDiscountRate: number,
  taxRate: number,
): InvoiceTotals => {
  const subtotal = roundCurrency(
    lines.reduce((total, line) => total + line.lineTotal, 0),
  );
  const itemDiscountTotal = roundCurrency(
    lines.reduce((total, line) => total + line.itemDiscountAmount, 0),
  );
  const normalizedInvoiceDiscount = clampRate(invoiceDiscountRate, 0);
  const invoiceDiscountAmount = roundCurrency(
    subtotal * normalizedInvoiceDiscount,
  );
  const discountedSubtotal = roundCurrency(
    subtotal - invoiceDiscountAmount,
  );
  const normalizedTaxRate = clampRate(taxRate, 0);
  const taxAmount = roundCurrency(discountedSubtotal * normalizedTaxRate);
  const totalDue = roundCurrency(discountedSubtotal + taxAmount);
  return {
    subtotal,
    itemDiscountTotal,
    invoiceDiscountRate: normalizedInvoiceDiscount,
    invoiceDiscountAmount,
    discountedSubtotal,
    taxRate: normalizedTaxRate,
    taxAmount,
    totalDue,
  };
};

const formatCurrency = (value: number): string => {
  return `$${value.toFixed(2)}`;
};

const updateItemDetails = handler(
  (
    event: UpdateItemEvent | undefined,
    context: { items: Cell<InvoiceItemInput[]> },
  ) => {
    const current = sanitizeItemList(context.items.get());
    const id = event?.id ? sanitizeIdentifier(event.id, "") : "";
    if (!id) return;
    const updated = current.map((entry) => {
      if (entry.id !== id) return entry;
      return {
        ...entry,
        description: event?.description ?? entry.description,
        quantity: typeof event?.quantity === "number"
          ? sanitizeQuantity(event.quantity, entry.quantity)
          : entry.quantity,
        unitPrice: typeof event?.unitPrice === "number"
          ? sanitizeMoney(event.unitPrice, entry.unitPrice)
          : entry.unitPrice,
        itemDiscountRate: typeof event?.itemDiscountRate === "number"
          ? clampRate(event.itemDiscountRate, entry.itemDiscountRate)
          : entry.itemDiscountRate,
      };
    });
    const sanitized = sanitizeItemList(updated, current);
    context.items.set(sanitized);
  },
);

const addInvoiceItem = handler(
  (
    event: InvoiceItemInput | undefined,
    context: { items: Cell<InvoiceItemInput[]> },
  ) => {
    const current = sanitizeItemList(context.items.get());
    const nextList = [...current, event ?? {}];
    const sanitized = sanitizeItemList(nextList, current);
    context.items.set(sanitized);
  },
);

const updateRates = handler(
  (
    event: RateUpdateEvent | undefined,
    context: {
      taxRate: Cell<number>;
      invoiceDiscountRate: Cell<number>;
    },
  ) => {
    if (typeof event?.taxRate === "number") {
      context.taxRate.set(
        clampRate(event.taxRate, context.taxRate.get()),
      );
    }
    if (typeof event?.invoiceDiscountRate === "number") {
      context.invoiceDiscountRate.set(
        clampRate(event.invoiceDiscountRate, context.invoiceDiscountRate.get()),
      );
    }
  },
);

// Module-scope lift definitions
const liftNormalizedItems = lift((value: InvoiceItemInput[] | undefined) =>
  sanitizeItemList(value)
);

const liftNormalizedTaxRate = lift((value: number | undefined) =>
  clampRate(value, 0.0725)
);

const liftNormalizedInvoiceDiscountRate = lift((value: number | undefined) =>
  clampRate(value, 0.05)
);

const liftLineSummaries = lift((entries: InvoiceItem[] | undefined) =>
  computeLineSummaries(Array.isArray(entries) ? entries : [])
);

const liftTotals = lift((input: {
  lines: InvoiceLineSummary[];
  invoiceDiscountRate: number;
  taxRate: number;
}) =>
  computeInvoiceTotals(
    input.lines,
    input.invoiceDiscountRate,
    input.taxRate,
  )
);

const liftSubtotal = lift((value: InvoiceTotals | undefined) =>
  value?.subtotal ?? 0
);

const liftItemDiscountTotal = lift((value: InvoiceTotals | undefined) =>
  value?.itemDiscountTotal ?? 0
);

const liftInvoiceDiscountAmount = lift((value: InvoiceTotals | undefined) =>
  value?.invoiceDiscountAmount ?? 0
);

const liftDiscountedSubtotal = lift((value: InvoiceTotals | undefined) =>
  value?.discountedSubtotal ?? 0
);

const liftTaxAmount = lift((value: InvoiceTotals | undefined) =>
  value?.taxAmount ?? 0
);

const liftTotalDue = lift((value: InvoiceTotals | undefined) =>
  value?.totalDue ?? 0
);

const liftFormattedTotalDue = lift((value: number | undefined) =>
  formatCurrency(value ?? 0)
);

const liftTaxRatePercent = lift((value: number | undefined) =>
  `${((value ?? 0) * 100).toFixed(2)}%`
);

const liftInvoiceDiscountPercent = lift((value: number | undefined) =>
  `${((value ?? 0) * 100).toFixed(2)}%`
);

const liftLineCount = lift((entries: InvoiceLineSummary[] | undefined) =>
  Array.isArray(entries) ? entries.length : 0
);

const liftLineLabels = lift((entries: InvoiceLineSummary[] | undefined) => {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) =>
    `${entry.description}: ${formatCurrency(entry.lineTotal)}`
  );
});

export const invoiceGeneratorPattern = pattern<InvoiceGeneratorArgs>(
  ({ items, taxRate, invoiceDiscountRate }) => {
    const normalizedItems = liftNormalizedItems(items);

    const normalizedTaxRate = liftNormalizedTaxRate(taxRate);

    const normalizedInvoiceDiscountRate = liftNormalizedInvoiceDiscountRate(
      invoiceDiscountRate,
    );

    const lineSummaries = liftLineSummaries(normalizedItems);

    const totals = liftTotals({
      lines: lineSummaries,
      invoiceDiscountRate: normalizedInvoiceDiscountRate,
      taxRate: normalizedTaxRate,
    });

    const subtotal = liftSubtotal(totals);

    const itemDiscountTotal = liftItemDiscountTotal(totals);

    const invoiceDiscountAmount = liftInvoiceDiscountAmount(totals);

    const discountedSubtotal = liftDiscountedSubtotal(totals);

    const taxAmount = liftTaxAmount(totals);

    const totalDue = liftTotalDue(totals);

    const formattedTotalDue = liftFormattedTotalDue(totalDue);

    const taxRatePercent = liftTaxRatePercent(normalizedTaxRate);

    const invoiceDiscountPercent = liftInvoiceDiscountPercent(
      normalizedInvoiceDiscountRate,
    );

    const lineCount = liftLineCount(lineSummaries);

    const lineLabels = liftLineLabels(lineSummaries);

    const summary =
      str`Total due ${formattedTotalDue} (tax ${taxRatePercent}, discount ${invoiceDiscountPercent})`;

    return {
      items,
      normalizedItems,
      lineSummaries,
      totals,
      subtotal,
      itemDiscountTotal,
      invoiceDiscountAmount,
      discountedSubtotal,
      taxAmount,
      totalDue,
      taxRatePercent,
      invoiceDiscountPercent,
      lineCount,
      lineLabels,
      formattedTotalDue,
      summary,
      controls: {
        addItem: addInvoiceItem({ items }),
        updateItem: updateItemDetails({ items }),
        updateRates: updateRates({
          taxRate,
          invoiceDiscountRate,
        }),
      },
    };
  },
);

export default invoiceGeneratorPattern;
