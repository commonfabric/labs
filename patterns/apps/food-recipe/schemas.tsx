/**
 * Shared types for the food-recipe family: `food-recipe.tsx` (a recipe you
 * cook), `prepared-food.tsx` (food you buy or someone brings), `viewer.tsx`
 * (the cooking view) and `recipe-analyzer.tsx` (dietary analysis).
 *
 * A meal planner composes these, so the types it reads are kept small and
 * stable: `MealDish` is what every dish offers, `RecipeForMeal` adds what a
 * cooked dish needs for scheduling (step groups with timing, oven needs), and
 * `PreparedFoodForMeal` adds what a bought dish needs. A consumer should
 * declare one of these as its input rather than a pattern's full output.
 */

export const RECIPE_CATEGORIES = [
  "appetizer",
  "main",
  "side",
  "starch",
  "vegetable",
  "dessert",
  "bread",
  "other",
] as const;

export type RecipeCategory = typeof RECIPE_CATEGORIES[number];

export type Difficulty = "easy" | "medium" | "hard";

export const CATEGORY_ITEMS = RECIPE_CATEGORIES.map((value) => ({
  label: value[0].toUpperCase() + value.slice(1),
  value,
}));

export const UNITS = [
  "",
  "tsp",
  "tbsp",
  "cup",
  "oz",
  "lb",
  "g",
  "kg",
  "ml",
  "l",
  "piece",
  "clove",
  "can",
  "pinch",
  "to taste",
] as const;

export const UNIT_ITEMS = UNITS.map((unit) => ({
  label: unit || "—",
  value: unit,
}));

export interface Ingredient {
  item: string;
  /** Free text so "1 1/2", "2-3" and "a handful" all fit. */
  amount: string;
  unit: string;
}

export interface RecipeStep {
  description: string;
}

/** What a step group needs from the oven while it runs. */
export interface OvenNeed {
  /** °F. */
  temperature: number;
  /** Minutes in the oven. */
  duration: number;
  /** Rack height the dish takes: 1 a sheet pan, 2 a casserole, 5 a turkey. */
  heightSlots: number;
  width: "full" | "half";
}

/**
 * A phase of the recipe that happens at one time: "Night before", "Prep",
 * "Roast", "Finish". It starts either some nights before the meal or some
 * minutes before serving, never both; neither set means unscheduled.
 */
export interface StepGroup {
  id: string;
  name: string;
  nightsBeforeServing?: number;
  minutesBeforeServing?: number;
  /** Minutes the group takes, active and passive. */
  duration?: number;
  /** Minutes its result can wait before the next group without suffering. */
  maxWaitMinutes?: number;
  /** Absent when the group does not use the oven. */
  oven?: OvenNeed;
  steps: RecipeStep[];
}

export interface DietaryCompatibility {
  /** Dietary tags the dish meets: "vegan", "gluten-free", "nut-free", ... */
  compatible: string[];
  /** Dietary tags the dish fails. */
  incompatible: string[];
  /** Readable caveats: "Contains dairy (butter)". */
  warnings: string[];
  /** The handful of ingredients that define the dish, for "no-X" matching. */
  primaryIngredients: string[];
}

export const EMPTY_DIETARY: DietaryCompatibility = {
  compatible: [],
  incompatible: [],
  warnings: [],
  primaryIngredients: [],
};

export interface OvenRequirements {
  needsOven: boolean;
  /** Every distinct temperature, ascending. */
  temps: number[];
  /** More than one temperature is needed. */
  tempChanges: boolean;
}

/** What every dish offers a meal planner. */
export interface MealDish {
  name: string;
  servings: number;
  category: RecipeCategory;
  dietaryCompatibility: DietaryCompatibility;
}

/** A dish cooked from a recipe. */
export interface RecipeForMeal extends MealDish {
  prepTime: number;
  cookTime: number;
  restTime: number;
  holdTime: number;
  ingredients: Ingredient[];
  stepGroups: StepGroup[];
  ovenRequirements: OvenRequirements;
}

/** A dish bought, brought by a guest, or ordered in. */
export interface PreparedFoodForMeal extends MealDish {
  prepTime: number;
  requiresReheating: boolean;
}
