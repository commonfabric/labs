import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

const defaultDays = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
];

type MealSlot = "breakfast" | "lunch" | "dinner";

interface Ingredient {
  name: string;
  quantity: number;
  unit: string;
}

interface RecipeDefinition {
  name: string;
  ingredients: Ingredient[];
}

interface PlannedMeal {
  day: string;
  meal: MealSlot;
  pattern: string;
}

const defaultRecipes: RecipeDefinition[] = [
  {
    name: "Oatmeal Bowl",
    ingredients: [
      { name: "Rolled Oats", quantity: 1, unit: "cup" },
      { name: "Milk", quantity: 1, unit: "cup" },
      { name: "Berries", quantity: 0.5, unit: "cup" },
    ],
  },
  {
    name: "Veggie Curry",
    ingredients: [
      { name: "Chickpeas", quantity: 1, unit: "can" },
      { name: "Spinach", quantity: 2, unit: "cup" },
      { name: "Curry Paste", quantity: 2, unit: "tbsp" },
    ],
  },
  {
    name: "Quinoa Salad",
    ingredients: [
      { name: "Quinoa", quantity: 1, unit: "cup" },
      { name: "Cherry Tomato", quantity: 1, unit: "cup" },
      { name: "Olive Oil", quantity: 2, unit: "tbsp" },
    ],
  },
];

interface MenuPlannerArgs {
  days: Default<string[], typeof defaultDays>;
  recipes: Default<RecipeDefinition[], typeof defaultRecipes>;
  plan: Default<PlannedMeal[], []>;
}

interface AssignmentEvent {
  day?: string;
  meal?: string;
  pattern?: string;
}

interface ShoppingEntry {
  name: string;
  unit: string;
  quantity: number;
}

const sanitizeText = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const sanitizeDays = (value: readonly string[] | undefined): string[] => {
  if (!Array.isArray(value)) return [...defaultDays];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    const sanitized = sanitizeText(entry);
    if (!sanitized) continue;
    const normalized = sanitized[0].toUpperCase() + sanitized.slice(1);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result.length > 0 ? result : [...defaultDays];
};

const sanitizeIngredient = (
  value: Ingredient | undefined,
): Ingredient | null => {
  const name = sanitizeText(value?.name);
  if (!name) return null;
  const unit = sanitizeText(value?.unit) ?? "unit";
  const quantity = typeof value?.quantity === "number" &&
      Number.isFinite(value.quantity)
    ? Math.max(Math.round(value.quantity * 100) / 100, 0)
    : 0;
  return { name, unit, quantity };
};

const sanitizeRecipes = (
  value: readonly RecipeDefinition[] | undefined,
): RecipeDefinition[] => {
  if (!Array.isArray(value) || value.length === 0) {
    return structuredClone(defaultRecipes);
  }
  const recipes: RecipeDefinition[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const name = sanitizeText(entry?.name);
    if (!name || seen.has(name)) continue;
    const ingredients: Ingredient[] = [];
    if (Array.isArray(entry?.ingredients)) {
      for (const item of entry.ingredients) {
        const sanitized = sanitizeIngredient(item);
        if (sanitized && sanitized.quantity > 0) {
          ingredients.push(sanitized);
        }
      }
    }
    if (ingredients.length > 0) {
      seen.add(name);
      recipes.push({ name, ingredients });
    }
  }
  return recipes.length > 0 ? recipes : structuredClone(defaultRecipes);
};

const sanitizeMealSlot = (value: unknown): MealSlot => {
  const normalized = sanitizeText(value)?.toLowerCase();
  if (normalized === "lunch" || normalized === "dinner") {
    return normalized;
  }
  return "breakfast";
};

const sanitizePlan = (
  value: readonly PlannedMeal[] | undefined,
  days: readonly string[],
  recipes: readonly RecipeDefinition[],
): PlannedMeal[] => {
  if (!Array.isArray(value)) return [];
  const validDays = new Set(days);
  const validRecipes = new Set(recipes.map((entry) => entry.name));
  const result: PlannedMeal[] = [];
  for (const entry of value) {
    const day = sanitizeText(entry?.day);
    if (!day || !validDays.has(day)) continue;
    const meal = sanitizeMealSlot(entry?.meal);
    const pattern = sanitizeText(entry?.pattern);
    if (!pattern || !validRecipes.has(pattern)) continue;
    result.push({ day, meal, pattern });
  }
  return result;
};

const buildRecipeMap = (recipes: readonly RecipeDefinition[]) => {
  const map = new Map<string, Ingredient[]>();
  for (const entry of recipes) {
    map.set(entry.name, entry.ingredients);
  }
  return map;
};

const aggregateShopping = (
  plan: readonly PlannedMeal[],
  recipes: readonly RecipeDefinition[],
): ShoppingEntry[] => {
  const recipeMap = buildRecipeMap(recipes);
  const totals = new Map<string, ShoppingEntry>();
  for (const item of plan) {
    const ingredients = recipeMap.get(item.pattern);
    if (!ingredients) continue;
    for (const ingredient of ingredients) {
      const key = `${ingredient.name}__${ingredient.unit}`;
      const previous = totals.get(key);
      const quantity = (previous?.quantity ?? 0) + ingredient.quantity;
      totals.set(key, {
        name: ingredient.name,
        unit: ingredient.unit,
        quantity: Math.round(quantity * 100) / 100,
      });
    }
  }
  const entries = Array.from(totals.values());
  entries.sort((left, right) => left.name.localeCompare(right.name));
  return entries;
};

const ensurePlanStructure = (
  days: readonly string[],
  plan: readonly PlannedMeal[],
): Record<string, Record<MealSlot, string>> => {
  const structure: Record<string, Record<MealSlot, string>> = {};
  for (const day of days) {
    structure[day] = { breakfast: "", lunch: "", dinner: "" };
  }
  for (const entry of plan) {
    if (!structure[entry.day]) continue;
    structure[entry.day][entry.meal] = entry.pattern;
  }
  return structure;
};

// Module-scope lift definitions
const liftSanitizeDays = lift(sanitizeDays);
const liftSanitizeRecipes = lift(sanitizeRecipes);

const liftPlanView = lift((inputs: {
  plan: PlannedMeal[] | undefined;
  days: string[];
  recipes: RecipeDefinition[];
}) => sanitizePlan(inputs.plan, inputs.days, inputs.recipes));

const liftPlanByDay = lift((inputs: {
  days: string[];
  plan: PlannedMeal[];
}) => ensurePlanStructure(inputs.days, inputs.plan));

const liftShoppingList = lift((inputs: {
  plan: PlannedMeal[];
  recipes: RecipeDefinition[];
}) => aggregateShopping(inputs.plan, inputs.recipes));

const liftPlannedCount = lift((entries: PlannedMeal[] | undefined) =>
  Array.isArray(entries) ? entries.length : 0
);

const assignMeal = handler(
  (
    event: AssignmentEvent | undefined,
    context: {
      plan: Cell<PlannedMeal[]>;
      daysView: Cell<string[]>;
      recipesView: Cell<RecipeDefinition[]>;
      sequence: Cell<number>;
      lastAction: Cell<string>;
    },
  ) => {
    const dayList = context.daysView.get();
    const recipeList = context.recipesView.get();
    const validDays = new Set(dayList);
    const validRecipes = new Set(recipeList.map((entry) => entry.name));
    const day = sanitizeText(event?.day) ?? dayList[0];
    if (!validDays.has(day)) return;
    const meal = sanitizeMealSlot(event?.meal);
    const recipeName = sanitizeText(event?.pattern);
    if (!recipeName || !validRecipes.has(recipeName)) return;

    const current = sanitizePlan(
      context.plan.get(),
      dayList,
      recipeList,
    );
    const filtered = current.filter((entry) =>
      !(entry.day === day && entry.meal === meal)
    );
    filtered.push({ day, meal, pattern: recipeName });
    context.plan.set(filtered);

    const sequenceValue = (context.sequence.get() ?? 0) + 1;
    context.sequence.set(sequenceValue);
    const action = `Assigned ${recipeName} to ${day} ${meal}`;
    context.lastAction.set(action);
  },
);

const clearMeal = handler(
  (
    event: AssignmentEvent | undefined,
    context: {
      plan: Cell<PlannedMeal[]>;
      daysView: Cell<string[]>;
      recipesView: Cell<RecipeDefinition[]>;
      sequence: Cell<number>;
      lastAction: Cell<string>;
    },
  ) => {
    const dayList = context.daysView.get();
    const recipeList = context.recipesView.get();
    const day = sanitizeText(event?.day) ?? dayList[0];
    if (!dayList.includes(day)) return;
    const meal = sanitizeMealSlot(event?.meal);
    const current = sanitizePlan(
      context.plan.get(),
      dayList,
      recipeList,
    );
    const filtered = current.filter((entry) =>
      !(entry.day === day && entry.meal === meal)
    );
    context.plan.set(filtered);
    const sequenceValue = (context.sequence.get() ?? 0) + 1;
    context.sequence.set(sequenceValue);
    const action = `Cleared ${day} ${meal}`;
    context.lastAction.set(action);
  },
);

export const menuPlanner = pattern<MenuPlannerArgs>(
  ({ days, recipes, plan }) => {
    const sequence = cell(0);
    const lastAction = cell("initialized");

    const daysView = liftSanitizeDays(days);
    const recipesView = liftSanitizeRecipes(recipes);
    const planView = liftPlanView({
      plan,
      days: daysView,
      recipes: recipesView,
    });

    const planByDay = liftPlanByDay({
      days: daysView,
      plan: planView,
    });

    const shoppingList = liftShoppingList({
      plan: planView,
      recipes: recipesView,
    });

    const plannedCount = liftPlannedCount(planView);

    const status = str`${plannedCount} meals scheduled`;

    return {
      days,
      recipes,
      plan,
      planByDay,
      shoppingList,
      plannedCount,
      status,
      lastAction,
      assignMeal: assignMeal({
        plan,
        daysView,
        recipesView,
        sequence,
        lastAction,
      }),
      clearMeal: clearMeal({
        plan,
        daysView,
        recipesView,
        sequence,
        lastAction,
      }),
    };
  },
);

export default menuPlanner;
