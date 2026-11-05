import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

interface TemplateSeed {
  id?: string;
  name?: string;
  category?: string;
  summary?: string;
  tags?: unknown;
  popularity?: number;
}

interface TemplateCard {
  id: string;
  name: string;
  categoryKey: string;
  category: string;
  summary: string;
  tags: string[];
  popularity: number;
}

interface CategoryFilter {
  key: string;
  label: string;
  count: number;
}

const defaultTemplateSeeds: TemplateSeed[] = [
  {
    id: "campaign-launch",
    name: "Campaign Launch Plan",
    category: "Marketing",
    summary: "Coordinate channel workstreams for launch readiness.",
    tags: ["campaign", "launch", "checklist"],
    popularity: 92,
  },
  {
    id: "brand-style-guide",
    name: "Brand Style Guide",
    category: "Design",
    summary: "Document voice, typography, and color decisions.",
    tags: ["design", "brand"],
    popularity: 84,
  },
  {
    id: "ops-standup-board",
    name: "Operations Standup Board",
    category: "Operations",
    summary: "Track blockers and owners for daily standups.",
    tags: ["operations", "standup"],
    popularity: 78,
  },
  {
    id: "budget-forecast",
    name: "Budget Forecast Tracker",
    category: "Finance",
    summary: "Model spend scenarios across quarters and teams.",
    tags: ["finance", "forecast"],
    popularity: 73,
  },
  {
    id: "support-playbook",
    name: "Support Response Playbook",
    category: "Support",
    summary: "Outline response templates per severity tier.",
    tags: ["support", "playbook"],
    popularity: 69,
  },
];

interface TemplateGalleryArgs {
  templates: Default<TemplateSeed[], typeof defaultTemplateSeeds>;
  category: Default<string, "all">;
}

interface SelectCategoryEvent {
  category?: string;
}

function sanitizeText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function slugify(value: string): string {
  const normalized = value.trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "general";
}

function formatCategoryLabel(value: string): string {
  const cleaned = value.trim().toLowerCase();
  const parts = cleaned.split(/\s+/);
  const labels = parts
    .filter((part) => part.length > 0)
    .map((part) => part[0].toUpperCase() + part.slice(1));
  return labels.length > 0 ? labels.join(" ") : "General";
}

function sanitizeSummary(value: unknown, fallback: string): string {
  const text = sanitizeText(value);
  return text ?? fallback;
}

function sanitizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const text = sanitizeText(entry);
    if (!text) continue;
    const normalized = text.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    tags.push(text);
  }
  return tags;
}

function sanitizePopularity(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  return clamped;
}

function buildTemplateCards(
  seeds: readonly TemplateSeed[],
): TemplateCard[] {
  const cards: TemplateCard[] = [];
  const seen = new Set<string>();
  for (const seed of seeds) {
    const name = sanitizeText(seed?.name);
    const category = sanitizeText(seed?.category);
    if (!name || !category) continue;
    const idSource = sanitizeText(seed?.id) ?? name;
    const id = slugify(idSource);
    if (seen.has(id)) continue;
    const categoryKey = slugify(category);
    const categoryLabel = formatCategoryLabel(category);
    const summary = sanitizeSummary(
      seed?.summary,
      `${categoryLabel} template`,
    );
    const tags = sanitizeTags(seed?.tags);
    const popularity = sanitizePopularity(seed?.popularity);
    cards.push({
      id,
      name,
      categoryKey,
      category: categoryLabel,
      summary,
      tags,
      popularity,
    });
    seen.add(id);
  }
  cards.sort((left, right) => {
    if (right.popularity === left.popularity) {
      return left.name.localeCompare(right.name);
    }
    return right.popularity - left.popularity;
  });
  return cards;
}

const sanitizedDefaultTemplates: TemplateCard[] = [
  {
    id: "campaign-launch",
    name: "Campaign Launch Plan",
    categoryKey: "marketing",
    category: "Marketing",
    summary: "Coordinate channel workstreams for launch readiness.",
    tags: ["campaign", "launch", "checklist"],
    popularity: 92,
  },
  {
    id: "brand-style-guide",
    name: "Brand Style Guide",
    categoryKey: "design",
    category: "Design",
    summary: "Document voice, typography, and color decisions.",
    tags: ["design", "brand"],
    popularity: 84,
  },
  {
    id: "ops-standup-board",
    name: "Operations Standup Board",
    categoryKey: "operations",
    category: "Operations",
    summary: "Track blockers and owners for daily standups.",
    tags: ["operations", "standup"],
    popularity: 78,
  },
  {
    id: "budget-forecast",
    name: "Budget Forecast Tracker",
    categoryKey: "finance",
    category: "Finance",
    summary: "Model spend scenarios across quarters and teams.",
    tags: ["finance", "forecast"],
    popularity: 73,
  },
  {
    id: "support-playbook",
    name: "Support Response Playbook",
    categoryKey: "support",
    category: "Support",
    summary: "Outline response templates per severity tier.",
    tags: ["support", "playbook"],
    popularity: 69,
  },
];

function cloneCards(entries: readonly TemplateCard[]): TemplateCard[] {
  return entries.map((entry) => ({
    ...entry,
    tags: [...entry.tags],
  }));
}

function sanitizeTemplateList(
  value: readonly TemplateSeed[] | undefined,
): TemplateCard[] {
  if (!Array.isArray(value) || value.length === 0) {
    return cloneCards(sanitizedDefaultTemplates);
  }
  const cards = buildTemplateCards(value);
  return cards.length > 0 ? cards : cloneCards(sanitizedDefaultTemplates);
}

function buildCategoryFilters(
  templates: readonly TemplateCard[],
): CategoryFilter[] {
  const counts = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const entry of templates) {
    const current = counts.get(entry.categoryKey) ?? 0;
    counts.set(entry.categoryKey, current + 1);
    if (!labels.has(entry.categoryKey)) {
      labels.set(entry.categoryKey, entry.category);
    }
  }
  const filters: CategoryFilter[] = [{
    key: "all",
    label: "All",
    count: templates.length,
  }];
  const keys = Array.from(labels.keys());
  keys.sort((left, right) => {
    const leftLabel = labels.get(left) ?? "General";
    const rightLabel = labels.get(right) ?? "General";
    return leftLabel.localeCompare(rightLabel);
  });
  for (const key of keys) {
    filters.push({
      key,
      label: labels.get(key) ?? "General",
      count: counts.get(key) ?? 0,
    });
  }
  return filters;
}

function sanitizeCategoryKey(
  value: unknown,
  valid: readonly string[],
): string {
  const requested = typeof value === "string" ? slugify(value) : "";
  if (requested.length > 0 && valid.includes(requested)) {
    return requested;
  }
  return valid.length > 0 ? valid[0] : "all";
}

function filterTemplates(
  templates: readonly TemplateCard[],
  category: string,
): TemplateCard[] {
  if (category === "all") {
    return cloneCards(templates);
  }
  const matches: TemplateCard[] = [];
  for (const template of templates) {
    if (template.categoryKey === category) {
      matches.push({
        ...template,
        tags: [...template.tags],
      });
    }
  }
  return matches;
}

function resolveCategoryLabel(
  active: string,
  filters: readonly CategoryFilter[],
): string {
  const match = filters.find((filter) => filter.key === active);
  return match ? match.label : "All";
}

const selectCategory = handler(
  (
    event: SelectCategoryEvent | undefined,
    context: {
      category: Cell<string>;
      categoryKeys: Cell<string[]>;
      categoryFilters: Cell<CategoryFilter[]>;
      sequence: Cell<number>;
      label: Cell<string>;
      history: Cell<string[]>;
    },
  ) => {
    const keys = context.categoryKeys.get() ?? [];
    const resolved = sanitizeCategoryKey(event?.category, keys);
    context.category.set(resolved);

    const filters = context.categoryFilters.get() ?? [];
    const label = resolveCategoryLabel(resolved, filters);
    const next = (context.sequence.get() ?? 0) + 1;
    context.sequence.set(next);
    context.label.set(`Category set to ${label}`);

    const previous = context.history.get() ?? [];
    const updated = [...previous, label];
    const limited = updated.length > 5 ? updated.slice(-5) : updated;
    context.history.set(limited);
  },
);

// Module-scope lift definitions
const liftSanitizeTemplateList = lift(sanitizeTemplateList);

const liftTotalCount = lift((entries: TemplateCard[] | undefined) =>
  Array.isArray(entries) ? entries.length : 0
);

const liftBuildCategoryFilters = lift(buildCategoryFilters);

const liftCategoryKeys = lift((filters: CategoryFilter[]) =>
  filters.map((filter) => filter.key)
);

const liftSelectedCategory = lift((inputs: {
  category: string | undefined;
  keys: string[];
}) => sanitizeCategoryKey(inputs.category, inputs.keys));

const liftVisibleTemplates = lift((inputs: {
  templates: TemplateCard[];
  category: string;
}) => filterTemplates(inputs.templates, inputs.category));

const liftVisibleCount = lift((entries: TemplateCard[] | undefined) =>
  Array.isArray(entries) ? entries.length : 0
);

const liftActiveCategoryLabel = lift((inputs: {
  key: string;
  filters: CategoryFilter[];
}) => resolveCategoryLabel(inputs.key, inputs.filters));

const liftFeaturedTemplate = lift((entries: TemplateCard[]) =>
  entries.length > 0 ? entries[0] : null
);

const liftSelectionTrail = lift((entries: string[] | undefined) => {
  if (!Array.isArray(entries) || entries.length === 0) {
    return "No selections yet";
  }
  return entries.join(" → ");
});

export const templateGallery = pattern<TemplateGalleryArgs>(
  ({ templates, category }) => {
    const selectionSequence = cell(0);
    const selectionLabel = cell("initial load");
    const selectionHistory = cell<string[]>([]);

    const templateList = liftSanitizeTemplateList(templates);

    const totalCount = liftTotalCount(templateList);

    const categoryFilters = liftBuildCategoryFilters(templateList);

    const categoryKeys = liftCategoryKeys(categoryFilters);

    const selectedCategory = liftSelectedCategory({
      category,
      keys: categoryKeys,
    });

    const visibleTemplates = liftVisibleTemplates({
      templates: templateList,
      category: selectedCategory,
    });

    const visibleCount = liftVisibleCount(visibleTemplates);

    const activeCategoryLabel = liftActiveCategoryLabel({
      key: selectedCategory,
      filters: categoryFilters,
    });

    const summary =
      str`${visibleCount} of ${totalCount} templates in ${activeCategoryLabel}`;

    const featuredTemplate = liftFeaturedTemplate(visibleTemplates);

    const selectionTrail = liftSelectionTrail(selectionHistory);

    const context = {
      category,
      categoryKeys,
      categoryFilters,
      sequence: selectionSequence,
      label: selectionLabel,
      history: selectionHistory,
    } as const;

    return {
      categories: categoryFilters,
      selectedCategory,
      visibleTemplates,
      counts: {
        total: totalCount,
        visible: visibleCount,
      },
      summary,
      featuredTemplate,
      selectionLabel,
      selectionTrail,
      handlers: {
        selectCategory: selectCategory(context as never),
      },
    };
  },
);

export default templateGallery;
