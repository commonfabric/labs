import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

interface CatalogItemInput {
  id?: string;
  title?: string;
  category?: string;
  brand?: string;
  price?: number;
  tags?: unknown;
}

interface CatalogItem {
  id: string;
  title: string;
  category: string;
  brand: string;
  price: number;
  tags: string[];
}

interface FacetSelection {
  categories: string[];
  brands: string[];
  priceCeiling: number | null;
}

interface PriceRange {
  min: number;
  max: number;
  average: number;
}

interface CatalogSearchArgs {
  catalog: Default<CatalogItemInput[], typeof defaultCatalog>;
}

const defaultCatalog: CatalogItem[] = [
  {
    id: "french-press",
    title: "Stainless Steel French Press",
    category: "Kitchen",
    brand: "Brew Pro",
    price: 48.5,
    tags: ["coffee", "brewing"],
  },
  {
    id: "pour-over-kit",
    title: "Pour Over Coffee Kit",
    category: "Kitchen",
    brand: "Daily Bean",
    price: 38,
    tags: ["coffee", "manual"],
  },
  {
    id: "hiking-pack",
    title: "Lightweight Hiking Backpack",
    category: "Outdoors",
    brand: "Trailhead",
    price: 96,
    tags: ["gear", "trail"],
  },
  {
    id: "trail-shoes",
    title: "Trail Running Shoes",
    category: "Outdoors",
    brand: "Trailhead",
    price: 120,
    tags: ["shoes", "running"],
  },
  {
    id: "noise-cancelling-headphones",
    title: "Noise Cancelling Headphones",
    category: "Electronics",
    brand: "Sonic Pulse",
    price: 180,
    tags: ["audio", "travel"],
  },
  {
    id: "smart-speaker",
    title: "Smart Home Speaker",
    category: "Electronics",
    brand: "Sonic Pulse",
    price: 140,
    tags: ["audio", "home"],
  },
];

const defaultSelection: FacetSelection = {
  categories: [],
  brands: [],
  priceCeiling: null,
};

const toTitleCase = (value: string): string =>
  value.split(/\s+/).filter((part) => part.length > 0).map((part) => {
    const head = part.charAt(0).toUpperCase();
    const rest = part.slice(1).toLowerCase();
    return `${head}${rest}`;
  }).join(" ");

const sanitizeString = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
};

const sanitizeFacet = (value: unknown, fallback: string): string => {
  const base = sanitizeString(value, fallback);
  if (base.length === 0) return fallback;
  return toTitleCase(base);
};

const sanitizePrice = (value: unknown, fallback: number): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.round(value * 100) / 100;
    if (normalized >= 0) return normalized;
  }
  return fallback;
};

const sanitizeTags = (value: unknown, fallback: string[]): string[] => {
  if (!Array.isArray(value)) return [...fallback];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const normalized = raw.trim().toLowerCase();
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    tags.push(normalized);
  }
  tags.sort((left, right) => left.localeCompare(right));
  return tags;
};

const normalizeId = (value: string): string =>
  value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "").replace(/-+$/, "");

const ensureUniqueId = (candidate: string, used: Set<string>): string => {
  const base = candidate.length > 0 ? candidate : "item";
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  const unique = `${base}-${suffix}`;
  used.add(unique);
  return unique;
};

const sanitizeCatalog = (value: unknown): CatalogItem[] => {
  const entries = Array.isArray(value) && value.length > 0
    ? (value as CatalogItemInput[])
    : defaultCatalog;
  const sanitized: CatalogItem[] = [];
  const used = new Set<string>();
  for (let index = 0; index < entries.length; index++) {
    const raw = entries[index] ?? {};
    const fallback = defaultCatalog[index % defaultCatalog.length];
    const title = sanitizeString(raw.title, fallback.title);
    const category = sanitizeFacet(raw.category, fallback.category);
    const brand = sanitizeFacet(raw.brand, fallback.brand);
    const price = sanitizePrice(raw.price, fallback.price);
    const tags = sanitizeTags(raw.tags, fallback.tags);
    const idSource = typeof raw.id === "string"
      ? raw.id
      : typeof raw.title === "string"
      ? raw.title
      : fallback.id;
    const normalized = normalizeId(idSource);
    const fallbackId = normalizeId(fallback.id);
    const id = ensureUniqueId(
      normalized.length > 0 ? normalized : fallbackId,
      used,
    );
    sanitized.push({ id, title, category, brand, price, tags });
  }
  sanitized.sort((left, right) => left.title.localeCompare(right.title));
  return sanitized;
};

const computeAvailableCategories = (
  items: readonly CatalogItem[],
): string[] => {
  const unique = new Set<string>();
  for (const item of items) unique.add(item.category);
  return Array.from(unique).sort((left, right) => left.localeCompare(right));
};

const computeAvailableBrands = (
  items: readonly CatalogItem[],
): string[] => {
  const unique = new Set<string>();
  for (const item of items) unique.add(item.brand);
  return Array.from(unique).sort((left, right) => left.localeCompare(right));
};

const computePriceRange = (items: readonly CatalogItem[]): PriceRange => {
  if (items.length === 0) {
    return { min: 0, max: 0, average: 0 };
  }
  let total = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    total += item.price;
    if (item.price < min) min = item.price;
    if (item.price > max) max = item.price;
  }
  const average = Math.round((total / items.length) * 100) / 100;
  return {
    min: Math.round(min * 100) / 100,
    max: Math.round(max * 100) / 100,
    average,
  };
};

const filterItems = (input: {
  items: readonly CatalogItem[];
  categories: readonly string[];
  brands: readonly string[];
  priceCeiling: number | null;
}): CatalogItem[] => {
  const sourceItems = Array.isArray(input.items) ? input.items : [];
  const categories = Array.isArray(input.categories) ? input.categories : [];
  const brands = Array.isArray(input.brands) ? input.brands : [];
  const ceiling = typeof input.priceCeiling === "number" &&
      Number.isFinite(input.priceCeiling)
    ? input.priceCeiling
    : null;
  const categorySet = new Set(categories);
  const brandSet = new Set(brands);
  return sourceItems.filter((item) => {
    const matchesCategory = categorySet.size === 0 ||
      categorySet.has(item.category);
    const matchesBrand = brandSet.size === 0 || brandSet.has(item.brand);
    const matchesPrice = ceiling === null || item.price <= ceiling;
    return matchesCategory && matchesBrand && matchesPrice;
  });
};

const formatPrice = (value: number): string => `$${value.toFixed(2)}`;

const summarizeSelection = (
  categories: readonly string[],
  brands: readonly string[],
  priceCeiling: number | null,
): string => {
  const parts: string[] = [];
  parts.push(
    categories.length > 0
      ? `Categories: ${categories.join(", ")}`
      : "Categories: All",
  );
  parts.push(
    brands.length > 0 ? `Brands: ${brands.join(", ")}` : "Brands: All",
  );
  const hasCeiling = typeof priceCeiling === "number" &&
    Number.isFinite(priceCeiling);
  parts.push(
    hasCeiling ? `Price ≤ ${formatPrice(priceCeiling)}` : "Price ≤ Any",
  );
  return parts.join(" • ");
};

const toggleFacet = handler(
  (
    event: { value?: string } | undefined,
    context: { target: Cell<string[]> },
  ) => {
    const normalized = sanitizeFacet(event?.value, "");
    if (normalized.length === 0) return;
    const current = context.target.get();
    const next = current.slice();
    const index = next.indexOf(normalized);
    if (index >= 0) {
      next.splice(index, 1);
    } else {
      next.push(normalized);
      next.sort((left, right) => left.localeCompare(right));
    }
    context.target.set(next);
  },
);

const setPriceCeiling = handler(
  (
    event:
      | { ceiling?: number | null }
      | undefined,
    context: { price: Cell<number | null>; range: Cell<PriceRange> },
  ) => {
    if (event?.ceiling === null) {
      context.price.set(null);
      return;
    }
    if (typeof event?.ceiling !== "number" || !Number.isFinite(event.ceiling)) {
      context.price.set(null);
      return;
    }
    const sanitized = Math.max(0, Math.round(event.ceiling * 100) / 100);
    const range = context.range.get();
    if (range.max <= 0) {
      context.price.set(null);
      return;
    }
    const clamped = Math.min(sanitized, range.max);
    context.price.set(clamped);
  },
);

const clearFilters = handler(
  (_event: unknown, context: {
    categories: Cell<string[]>;
    brands: Cell<string[]>;
    price: Cell<number | null>;
  }) => {
    context.categories.set([...defaultSelection.categories]);
    context.brands.set([...defaultSelection.brands]);
    context.price.set(defaultSelection.priceCeiling);
  },
);

const liftItemsLength = lift((items: CatalogItem[]) => items.length);

const liftSelectionSummary = lift(
  (input: {
    categories: string[];
    brands: string[];
    price: number | null;
  }) => summarizeSelection(input.categories, input.brands, input.price),
);

const liftSanitizeCatalog = lift(sanitizeCatalog);
const liftComputeAvailableCategories = lift(computeAvailableCategories);
const liftComputeAvailableBrands = lift(computeAvailableBrands);
const liftComputePriceRange = lift(computePriceRange);
const liftFilterItems = lift(filterItems);

export const catalogSearchFacets = pattern<CatalogSearchArgs>(
  ({ catalog }) => {
    const sanitizedCatalog = liftSanitizeCatalog(catalog);

    const selectedCategories = cell<string[]>(
      structuredClone(defaultSelection.categories),
    );
    const selectedBrands = cell<string[]>(
      structuredClone(defaultSelection.brands),
    );
    const priceCeiling = cell<number | null>(defaultSelection.priceCeiling);

    const availableCategories = liftComputeAvailableCategories(
      sanitizedCatalog,
    );
    const availableBrands = liftComputeAvailableBrands(sanitizedCatalog);
    const priceRange = liftComputePriceRange(sanitizedCatalog);

    const filteredItems = liftFilterItems({
      items: sanitizedCatalog,
      categories: selectedCategories,
      brands: selectedBrands,
      priceCeiling,
    });

    const totalCount = liftItemsLength(sanitizedCatalog);
    const filteredCount = liftItemsLength(filteredItems);

    const selectionSummary = liftSelectionSummary({
      categories: selectedCategories,
      brands: selectedBrands,
      price: priceCeiling,
    });

    const statusLabel = str`Showing ${filteredCount} of ${totalCount} products`;

    return {
      catalog: sanitizedCatalog,
      facets: {
        available: {
          categories: availableCategories,
          brands: availableBrands,
          priceRange,
        },
        selection: {
          categories: selectedCategories,
          brands: selectedBrands,
          priceCeiling,
          summary: selectionSummary,
        },
      },
      results: {
        items: filteredItems,
        count: filteredCount,
        total: totalCount,
        statusLabel,
      },
      controls: {
        toggleCategory: toggleFacet({ target: selectedCategories }),
        toggleBrand: toggleFacet({ target: selectedBrands }),
        setPriceCeiling: setPriceCeiling({
          price: priceCeiling,
          range: priceRange,
        }),
        clearFilters: clearFilters({
          categories: selectedCategories,
          brands: selectedBrands,
          price: priceCeiling,
        }),
      },
    };
  },
);

export default catalogSearchFacets;
