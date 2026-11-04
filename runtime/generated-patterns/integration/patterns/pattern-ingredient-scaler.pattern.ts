import { type Cell, cell, Default, handler, lift, pattern } from "commonfabric";

interface IngredientInput {
  name?: unknown;
  quantity?: unknown;
  unit?: unknown;
}

interface Ingredient {
  name: string;
  quantity: number;
  unit: string;
}

interface ServingsEvent {
  servings?: number;
  delta?: number;
}

const defaultRecipeName = "Herb Pasta";
const defaultBaseServings = 4;
const defaultDesiredServings = 4;
const defaultIngredients: Ingredient[] = [
  { name: "Spaghetti", quantity: 200, unit: "gram" },
  { name: "Cherry Tomato", quantity: 150, unit: "gram" },
  { name: "Olive Oil", quantity: 2, unit: "tbsp" },
  { name: "Basil", quantity: 6, unit: "leaf" },
];

interface RecipeIngredientScalerArgs {
  name: Default<string, typeof defaultRecipeName>;
  baseServings: Default<number, typeof defaultBaseServings>;
  desiredServings: Default<number, typeof defaultDesiredServings>;
  ingredients: Default<Ingredient[], typeof defaultIngredients>;
}

const formatNumber = (value: number): string => {
  const fixed = value.toFixed(2);
  return fixed.replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
};

const sanitizeServings = (
  value: unknown,
  fallback: number,
  minimum = 0.5,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return Math.max(fallback, minimum);
  }
  const rounded = Math.round(value * 10) / 10;
  if (rounded < minimum) {
    return Math.max(fallback, minimum);
  }
  return rounded;
};

const sanitizeQuantity = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  return Math.round(value * 100) / 100;
};

const textOrNull = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const sanitizeIngredientList = (value: unknown): Ingredient[] => {
  if (!Array.isArray(value)) {
    return defaultIngredients.map((item) => ({ ...item }));
  }
  const result: Ingredient[] = [];
  for (const entry of value as IngredientInput[]) {
    const name = textOrNull(entry?.name);
    if (!name) continue;
    const unit = textOrNull(entry?.unit) ?? "unit";
    const quantity = sanitizeQuantity(entry?.quantity);
    if (quantity <= 0) continue;
    result.push({ name, unit, quantity });
  }
  return result.length > 0
    ? result
    : defaultIngredients.map((item) => ({ ...item }));
};

const toMultiplier = (desired: number, base: number): number => {
  if (base <= 0) return 1;
  return Math.round((desired / base) * 100) / 100;
};

const appendHistory = (history: Cell<string[]>, entry: string) => {
  const current = history.get();
  const list = Array.isArray(current) ? current : [];
  history.set([...list, entry]);
};

const setServings = handler(
  (
    event: ServingsEvent | undefined,
    context: {
      desiredServings: Cell<number>;
      baseServings: Cell<number>;
      history: Cell<string[]>;
    },
  ) => {
    const base = sanitizeServings(
      context.baseServings.get(),
      defaultBaseServings,
      1,
    );
    const next = sanitizeServings(event?.servings, base, 0.5);
    context.desiredServings.set(next);
    const multiplier = toMultiplier(next, base);
    const message = `Set servings to ${formatNumber(next)} (x${
      formatNumber(multiplier)
    })`;
    appendHistory(context.history, message);
  },
);

const adjustServings = handler(
  (
    event: ServingsEvent | undefined,
    context: {
      desiredServings: Cell<number>;
      baseServings: Cell<number>;
      history: Cell<string[]>;
    },
  ) => {
    const base = sanitizeServings(
      context.baseServings.get(),
      defaultBaseServings,
      1,
    );
    const current = sanitizeServings(
      context.desiredServings.get(),
      base,
      0.5,
    );
    const delta = typeof event?.delta === "number" &&
        Number.isFinite(event.delta)
      ? event.delta
      : 0;
    const next = sanitizeServings(current + delta, base, 0.5);
    context.desiredServings.set(next);
    const multiplier = toMultiplier(next, base);
    const message =
      `Adjusted by ${formatNumber(delta)} -> ${formatNumber(next)} ` +
      `(x${formatNumber(multiplier)})`;
    appendHistory(context.history, message);
  },
);

// Module-scope lift definitions
const liftRecipeName = lift((value: string | undefined) => {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : defaultRecipeName;
});

const liftBaseView = lift((value: number | undefined) =>
  sanitizeServings(value, defaultBaseServings, 1)
);

const liftDesiredView = lift((input: {
  desired: number | undefined;
  base: number;
}) => sanitizeServings(input.desired, input.base, 0.5));

const liftIngredientList = lift(sanitizeIngredientList);

const liftMultiplier = lift((input: { desired: number; base: number }) =>
  toMultiplier(input.desired, input.base)
);

const liftScaledIngredients = lift((input: {
  items: Ingredient[];
  multiplier: number;
}) =>
  input.items.map((item) => ({
    name: item.name,
    unit: item.unit,
    quantity: Math.round(item.quantity * input.multiplier * 100) / 100,
  }))
);

const liftFormatNumber = lift(formatNumber);

const liftMultiplierLabel = lift((value: number) => `x${formatNumber(value)}`);

const liftScaledLabel = lift((items: Ingredient[]) =>
  items.map((item) =>
    `${item.name}: ${formatNumber(item.quantity)} ${item.unit}`
  ).join("; ")
);

const liftSummary = lift((input: {
  name: string;
  servings: string;
  multiplier: string;
}) => `${input.name}: ${input.servings} servings (${input.multiplier})`);

export const recipeIngredientScaler = pattern<RecipeIngredientScalerArgs>(
  ({ name, baseServings, desiredServings, ingredients }) => {
    const history = cell<string[]>([]);

    const recipeName = liftRecipeName(name);

    const baseView = liftBaseView(baseServings);

    const desiredView = liftDesiredView({
      desired: desiredServings,
      base: baseView,
    });

    const ingredientsView = liftIngredientList(ingredients);

    const multiplier = liftMultiplier({
      desired: desiredView,
      base: baseView,
    });

    const scaledIngredients = liftScaledIngredients({
      items: ingredientsView,
      multiplier,
    });

    const desiredLabel = liftFormatNumber(desiredView);
    const multiplierLabel = liftMultiplierLabel(multiplier);

    const scaledLabel = liftScaledLabel(scaledIngredients);

    const summary = liftSummary({
      name: recipeName,
      servings: desiredLabel,
      multiplier: multiplierLabel,
    });

    return {
      recipeName,
      baseServings: baseView,
      desiredServings: desiredView,
      desiredLabel,
      multiplier,
      multiplierLabel,
      ingredients: ingredientsView,
      scaledIngredients,
      scaledLabel,
      summary,
      history,
      setServings: setServings({
        desiredServings,
        baseServings,
        history,
      }),
      adjustServings: adjustServings({
        desiredServings,
        baseServings,
        history,
      }),
    };
  },
);

export default recipeIngredientScaler;
