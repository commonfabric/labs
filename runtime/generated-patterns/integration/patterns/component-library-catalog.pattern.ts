import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

interface ComponentLibraryCatalogArgs {
  components: Default<ComponentSeed[], typeof defaultComponentSeeds>;
}

interface ComponentSeed {
  id?: string;
  name?: string;
  category?: string;
  description?: string;
  props?: string[];
}

interface ComponentDefinition {
  id: string;
  name: string;
  category: string;
  categoryKey: string;
  description: string;
  props: string[];
}

interface RecipeRegistrationEntry {
  componentId: string;
  pattern: string;
  props: string[];
}

interface RecipeRegistrationEvent {
  component?: string;
  pattern?: string;
  props?: string[];
}

interface ComponentCoverageView {
  id: string;
  name: string;
  category: string;
  props: string[];
  coveredProps: string[];
  uncoveredProps: string[];
  coveragePercent: number;
  recipeCount: number;
  recipes: string[];
}

interface PropCoverageView {
  prop: string;
  declared: number;
  covered: number;
  coveragePercent: number;
  components: string[];
  coveredComponents: string[];
  recipes: string[];
}

interface CoverageTotals {
  components: number;
  fullyCovered: number;
  partiallyCovered: number;
  uncovered: number;
  averageCoverage: number;
  props: number;
  propsCovered: number;
}

interface CategorySummary {
  key: string;
  label: string;
  componentCount: number;
}

const defaultComponentSeeds: ComponentSeed[] = [
  {
    id: "primary-button",
    name: "Primary Button",
    category: "Buttons",
    description: "Primary action button for critical flows.",
    props: ["label", "variant", "disabled", "size"],
  },
  {
    id: "secondary-button",
    name: "Secondary Button",
    category: "Buttons",
    description: "Secondary emphasis button for supporting actions.",
    props: ["label", "variant", "disabled"],
  },
  {
    id: "input-field",
    name: "Input Field",
    category: "Forms",
    description: "Form input field supporting helper and error states.",
    props: [
      "label",
      "value",
      "placeholder",
      "error",
      "helper-text",
    ],
  },
];

function sanitizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function titleCase(value: string): string {
  const parts = value
    .toLowerCase()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  if (parts.length === 0) return "";
  return parts
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

function slugify(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : fallback;
}

function sanitizeDescription(
  value: unknown,
  name: string,
  category: string,
): string {
  const text = sanitizeText(value);
  if (text) return text;
  return `${name} component within ${category}.`;
}

function sanitizeProps(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const props: string[] = [];
  for (const entry of value) {
    const text = sanitizeText(entry);
    if (!text) continue;
    const normalized = text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (normalized.length === 0) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    props.push(normalized);
  }
  props.sort((left, right) => left.localeCompare(right));
  return props;
}

function sanitizeComponentDefinitions(
  seeds: readonly ComponentSeed[] | undefined,
): ComponentDefinition[] {
  const source = Array.isArray(seeds) && seeds.length > 0
    ? seeds
    : defaultComponentSeeds;
  const map = new Map<string, ComponentDefinition>();
  source.forEach((seed, index) => {
    const nameSource = sanitizeText(seed?.name) ??
      sanitizeText(seed?.id) ??
      `Component ${index + 1}`;
    const name = titleCase(nameSource);
    const idSource = sanitizeText(seed?.id) ?? name;
    const id = slugify(idSource, `component-${index + 1}`);
    const categorySource = sanitizeText(seed?.category) ?? "General";
    const category = titleCase(categorySource);
    const categoryKey = slugify(category, "general");
    const description = sanitizeDescription(seed?.description, name, category);
    const props = sanitizeProps(seed?.props);
    const finalProps = props.length > 0 ? props : ["label"];
    map.set(id, {
      id,
      name,
      category,
      categoryKey,
      description,
      props: finalProps,
    });
  });
  const list = Array.from(map.values());
  list.sort((left, right) => {
    const categoryOrder = left.category.localeCompare(right.category);
    if (categoryOrder !== 0) return categoryOrder;
    return left.name.localeCompare(right.name);
  });
  return list;
}

function sanitizeComponentIdFromInput(
  value: unknown,
  components: readonly ComponentDefinition[],
): string | null {
  if (components.length === 0) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      const slug = slugify(trimmed, trimmed.toLowerCase());
      for (const component of components) {
        if (component.id === slug) return component.id;
        if (slugify(component.name, component.id) === slug) {
          return component.id;
        }
      }
    }
  }
  return components[0].id;
}

function sanitizeRecipeLabel(
  value: unknown,
  _component: ComponentDefinition,
  fallback: string,
): string {
  const text = sanitizeText(value);
  if (text) return titleCase(text);
  return fallback;
}

function rebuildRegistrationMap(
  entries: unknown,
  components: readonly ComponentDefinition[],
): Map<string, RecipeRegistrationEntry> {
  const componentMap = new Map<string, ComponentDefinition>();
  components.forEach((component) => componentMap.set(component.id, component));
  const map = new Map<string, RecipeRegistrationEntry>();
  if (!Array.isArray(entries)) return map;
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const componentIdValue = (raw as { componentId?: unknown }).componentId;
    const componentKey = (raw as { component?: unknown }).component;
    const componentId = typeof componentIdValue === "string"
      ? componentIdValue
      : typeof componentKey === "string"
      ? slugify(componentKey, "component")
      : null;
    if (!componentId) continue;
    const component = componentMap.get(componentId);
    if (!component) continue;
    const pattern = sanitizeRecipeLabel(
      (raw as { pattern?: unknown }).pattern,
      component,
      component.name,
    );
    const allowed = new Set(component.props);
    const props = sanitizeProps((raw as { props?: unknown }).props)
      .filter((prop) => allowed.has(prop));
    const key = `${component.id}#${pattern}`;
    map.set(key, {
      componentId: component.id,
      pattern,
      props,
    });
  }
  return map;
}

function computeCategorySummary(
  components: readonly ComponentDefinition[],
): CategorySummary[] {
  const map = new Map<string, { label: string; count: number }>();
  for (const component of components) {
    const entry = map.get(component.categoryKey);
    if (entry) {
      entry.count += 1;
    } else {
      map.set(component.categoryKey, {
        label: component.category,
        count: 1,
      });
    }
  }
  const categories: CategorySummary[] = [];
  for (const [key, value] of map.entries()) {
    categories.push({
      key,
      label: value.label,
      componentCount: value.count,
    });
  }
  categories.sort((left, right) => left.label.localeCompare(right.label));
  return categories;
}

function computeComponentCoverage(
  components: readonly ComponentDefinition[],
  registrations: readonly RecipeRegistrationEntry[],
): ComponentCoverageView[] {
  const grouped = new Map<string, RecipeRegistrationEntry[]>();
  for (const entry of registrations) {
    const list = grouped.get(entry.componentId);
    if (list) {
      list.push({
        componentId: entry.componentId,
        pattern: entry.pattern,
        props: [...entry.props],
      });
    } else {
      grouped.set(entry.componentId, [{
        componentId: entry.componentId,
        pattern: entry.pattern,
        props: [...entry.props],
      }]);
    }
  }
  const coverage: ComponentCoverageView[] = [];
  for (const component of components) {
    const entries = grouped.get(component.id) ?? [];
    const allowed = new Set(component.props);
    const covered = new Set<string>();
    const recipeSet = new Set<string>();
    for (const entry of entries) {
      for (const prop of entry.props) {
        if (allowed.has(prop)) covered.add(prop);
      }
      recipeSet.add(entry.pattern);
    }
    const coveredProps = Array.from(covered).sort((left, right) =>
      left.localeCompare(right)
    );
    const uncoveredProps = component.props.filter((prop) => !covered.has(prop));
    const coveragePercent = component.props.length === 0
      ? 100
      : Math.round((coveredProps.length / component.props.length) * 100);
    coverage.push({
      id: component.id,
      name: component.name,
      category: component.category,
      props: [...component.props],
      coveredProps,
      uncoveredProps,
      coveragePercent,
      recipeCount: recipeSet.size,
      recipes: Array.from(recipeSet).sort((left, right) =>
        left.localeCompare(right)
      ),
    });
  }
  return coverage;
}

function computePropCoverage(
  components: readonly ComponentDefinition[],
  registrations: readonly RecipeRegistrationEntry[],
): PropCoverageView[] {
  const componentMap = new Map<string, ComponentDefinition>();
  components.forEach((component) => componentMap.set(component.id, component));
  const catalog = new Map<
    string,
    {
      declared: Set<string>;
      covered: Map<string, Set<string>>;
    }
  >();
  for (const component of components) {
    for (const prop of component.props) {
      const entry = catalog.get(prop);
      if (entry) {
        entry.declared.add(component.id);
        entry.covered.set(component.id, new Set());
      } else {
        catalog.set(prop, {
          declared: new Set([component.id]),
          covered: new Map([[component.id, new Set<string>()]]),
        });
      }
    }
  }
  for (const registration of registrations) {
    const component = componentMap.get(registration.componentId);
    if (!component) continue;
    const allowed = new Set(component.props);
    for (const prop of registration.props) {
      if (!allowed.has(prop)) continue;
      const entry = catalog.get(prop);
      if (!entry) continue;
      const record = entry.covered.get(component.id);
      if (!record) continue;
      record.add(registration.pattern);
    }
  }
  const coverage: PropCoverageView[] = [];
  for (const [prop, data] of catalog.entries()) {
    const declaredComponents = Array.from(data.declared)
      .map((componentId) => componentMap.get(componentId)?.name ?? componentId)
      .sort((left, right) => left.localeCompare(right));
    const coveredComponents: string[] = [];
    const recipes = new Set<string>();
    for (const [componentId, recipeSet] of data.covered.entries()) {
      if (recipeSet.size === 0) continue;
      coveredComponents.push(
        componentMap.get(componentId)?.name ?? componentId,
      );
      recipeSet.forEach((pattern) => recipes.add(pattern));
    }
    coveredComponents.sort((left, right) => left.localeCompare(right));
    const declared = declaredComponents.length;
    const covered = coveredComponents.length;
    const coveragePercent = declared === 0
      ? 0
      : Math.round((covered / declared) * 100);
    coverage.push({
      prop,
      declared,
      covered,
      coveragePercent,
      components: declaredComponents,
      coveredComponents,
      recipes: Array.from(recipes).sort((left, right) =>
        left.localeCompare(right)
      ),
    });
  }
  coverage.sort((left, right) => {
    if (right.coveragePercent !== left.coveragePercent) {
      return right.coveragePercent - left.coveragePercent;
    }
    if (right.covered !== left.covered) {
      return right.covered - left.covered;
    }
    return left.prop.localeCompare(right.prop);
  });
  return coverage;
}

function summarizeCoverage(
  componentCoverage: readonly ComponentCoverageView[],
  propCoverage: readonly PropCoverageView[],
): CoverageTotals {
  const components = componentCoverage.length;
  let fullyCovered = 0;
  let partiallyCovered = 0;
  for (const entry of componentCoverage) {
    if (entry.coveragePercent === 100) {
      fullyCovered += 1;
    } else if (entry.coveragePercent > 0) {
      partiallyCovered += 1;
    }
  }
  const uncovered = components - fullyCovered - partiallyCovered;
  const totalPercent = componentCoverage.reduce(
    (sum, entry) => sum + entry.coveragePercent,
    0,
  );
  const averageCoverage = components === 0
    ? 0
    : Math.round(totalPercent / components);
  const props = propCoverage.length;
  const propsCovered = propCoverage.filter((entry) => entry.covered > 0)
    .length;
  return {
    components,
    fullyCovered,
    partiallyCovered,
    uncovered,
    averageCoverage,
    props,
    propsCovered,
  };
}

function formatRegistrationMessage(
  component: ComponentDefinition,
  pattern: string,
  props: readonly string[],
): string {
  const propLabel = props.length === component.props.length
    ? "all props"
    : `${props.length} props`;
  return `${component.name}: ${pattern} (${propLabel})`;
}

function readSequence(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return 0;
}

const liftSanitizeComponentDefinitions = lift((
  value: ComponentSeed[] | undefined,
) => sanitizeComponentDefinitions(value));

const liftSanitizeRegistrationEntries = lift((inputs: {
  entries: RecipeRegistrationEntry[] | undefined;
  components: ComponentDefinition[];
}) =>
  Array.isArray(inputs.entries)
    ? sanitizeRegistrationEntries(inputs.entries, inputs.components)
    : []
);

const liftComputeComponentCoverage = lift((inputs: {
  components: ComponentDefinition[];
  registrations: RecipeRegistrationEntry[];
}) => computeComponentCoverage(inputs.components, inputs.registrations));

const liftComputePropCoverage = lift((inputs: {
  components: ComponentDefinition[];
  registrations: RecipeRegistrationEntry[];
}) => computePropCoverage(inputs.components, inputs.registrations));

const liftSummarizeCoverage = lift((inputs: {
  components: ComponentCoverageView[];
  props: PropCoverageView[];
}) => summarizeCoverage(inputs.components, inputs.props));

const liftAverageCoverageLabel = lift((value: number | undefined) => {
  if (typeof value === "number") {
    return `${value}% average coverage`;
  }
  return "0% average coverage";
});

const liftCategorySummary = lift((entries: ComponentDefinition[]) =>
  computeCategorySummary(entries)
);

const liftRegistrationTrail = lift((entries: string[] | undefined) => {
  if (!Array.isArray(entries) || entries.length === 0) {
    return "No recipes registered yet";
  }
  return entries.join(" | ");
});

const liftLastRegistration = lift((entries: string[] | undefined) => {
  if (!Array.isArray(entries) || entries.length === 0) {
    return "none";
  }
  return entries[entries.length - 1];
});

const registerRecipe = handler(
  (
    event: RecipeRegistrationEvent | undefined,
    context: {
      components: Cell<ComponentSeed[]>;
      registrations: Cell<RecipeRegistrationEntry[]>;
      log: Cell<string[]>;
      sequence: Cell<number>;
    },
  ) => {
    const definitions = sanitizeComponentDefinitions(context.components.get());
    if (definitions.length === 0) return;
    const componentId = sanitizeComponentIdFromInput(
      event?.component,
      definitions,
    );
    if (!componentId) return;
    const component = definitions.find((item) => item.id === componentId);
    if (!component) return;

    const allowedProps = new Set(component.props);
    const normalizedProps = sanitizeProps(event?.props)
      .filter((prop) => allowedProps.has(prop));
    if (normalizedProps.length === 0) return;

    const sequenceValue = readSequence(context.sequence.get());
    const fallbackRecipe = `${component.name} Recipe ${sequenceValue + 1}`;
    const recipeLabel = sanitizeRecipeLabel(
      event?.pattern,
      component,
      fallbackRecipe,
    );
    context.sequence.set(sequenceValue + 1);

    const existing = rebuildRegistrationMap(
      context.registrations.get(),
      definitions,
    );
    existing.set(`${component.id}#${recipeLabel}`, {
      componentId: component.id,
      pattern: recipeLabel,
      props: normalizedProps,
    });

    const nextEntries = Array.from(existing.values());
    nextEntries.sort((left, right) => {
      if (left.componentId === right.componentId) {
        return left.pattern.localeCompare(right.pattern);
      }
      return left.componentId.localeCompare(right.componentId);
    });

    context.registrations.set(nextEntries.map((entry) => ({
      componentId: entry.componentId,
      pattern: entry.pattern,
      props: [...entry.props],
    })));

    const previousLog = Array.isArray(context.log.get())
      ? (context.log.get() as string[]).filter((value) =>
        typeof value === "string"
      )
      : [];
    const message = formatRegistrationMessage(
      component,
      recipeLabel,
      normalizedProps,
    );
    const nextLog = [...previousLog.slice(-4), message];
    context.log.set(nextLog);
  },
);

export const componentLibraryCatalog = pattern<ComponentLibraryCatalogArgs>(
  ({ components }) => {
    const registrations = cell<RecipeRegistrationEntry[]>([]);
    const registrationLog = cell<string[]>([]);
    const registrationSequence = cell(0);

    const componentList = liftSanitizeComponentDefinitions(components);

    const registrationList = liftSanitizeRegistrationEntries({
      entries: registrations,
      components: componentList,
    });

    const componentCoverage = liftComputeComponentCoverage({
      components: componentList,
      registrations: registrationList,
    });

    const propCoverage = liftComputePropCoverage({
      components: componentList,
      registrations: registrationList,
    });

    const coverageTotals = liftSummarizeCoverage({
      components: componentCoverage,
      props: propCoverage,
    });

    const componentCount = coverageTotals.components;
    const fullyCovered = coverageTotals.fullyCovered;
    const partiallyCovered = coverageTotals.partiallyCovered;
    const uncovered = coverageTotals.uncovered;
    const averageCoverage = coverageTotals.averageCoverage;
    const propCount = coverageTotals.props;
    const propsCovered = coverageTotals.propsCovered;

    const coverageSummary =
      str`${fullyCovered}/${componentCount} covered | props ${propsCovered}/${propCount}`;

    const averageCoverageLabel = liftAverageCoverageLabel(averageCoverage);

    const categorySummary = liftCategorySummary(componentList);

    const registrationTrail = liftRegistrationTrail(registrationLog);

    const lastRegistration = liftLastRegistration(registrationLog);

    return {
      components: componentList,
      categories: categorySummary,
      registrations: registrationList,
      componentCoverage,
      propCoverage,
      stats: {
        componentCount,
        fullyCovered,
        partiallyCovered,
        uncovered,
        averageCoverage,
        propCount,
        propsCovered,
      },
      coverageSummary,
      averageCoverageLabel,
      registrationTrail,
      lastRegistration,
      controls: {
        register: registerRecipe({
          components,
          registrations,
          log: registrationLog,
          sequence: registrationSequence,
        }),
      },
    };
  },
);

function sanitizeRegistrationEntries(
  entries: readonly RecipeRegistrationEntry[] | undefined,
  components: readonly ComponentDefinition[],
): RecipeRegistrationEntry[] {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const componentMap = new Map<string, ComponentDefinition>();
  components.forEach((component) => componentMap.set(component.id, component));
  const map = new Map<string, RecipeRegistrationEntry>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const component = componentMap.get(entry.componentId);
    if (!component) continue;
    const pattern = sanitizeRecipeLabel(
      entry.pattern,
      component,
      component.name,
    );
    const allowed = new Set(component.props);
    const props = entry.props
      .filter((prop: string) => allowed.has(prop))
      .sort((left: string, right: string) => left.localeCompare(right));
    const key = `${component.id}#${pattern}`;
    map.set(key, {
      componentId: component.id,
      pattern,
      props,
    });
  }
  const list = Array.from(map.values());
  list.sort((left, right) => {
    if (left.componentId === right.componentId) {
      return left.pattern.localeCompare(right.pattern);
    }
    return left.componentId.localeCompare(right.componentId);
  });
  return list;
}

export default componentLibraryCatalog;
