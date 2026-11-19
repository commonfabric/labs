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

export const DIFFICULTIES = ["easy", "medium", "hard"] as const;

export type Difficulty = typeof DIFFICULTIES[number];

const titleCase = (value: string) => value[0].toUpperCase() + value.slice(1);

export const CATEGORY_ITEMS = RECIPE_CATEGORIES.map((value) => ({
  label: titleCase(value),
  value,
}));

export const DIFFICULTY_ITEMS = DIFFICULTIES.map((value) => ({
  label: titleCase(value),
  value,
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
 *
 * "Never both" is kept by the writers in recipe-logic.ts, not by this type:
 * `withGroupNumber` (editing) clears the other field, and `cleanTiming`
 * (extraction and timing suggestions) keeps only one. A reader that meets
 * both anyway goes by `nightsBeforeServing` when it is above 0, as
 * `formatTiming` and the meal planner's oven plan do. Two optional fields
 * rather than a union keep the shape flat for the timing model's schema
 * (`TimingSuggestion` mirrors it) and for the meal planner, which reads it.
 *
 * An oven need occupies the oven from the group's start for `oven.duration`
 * minutes, so a planner places it at `minutesBeforeServing` (a night-before
 * group is outside the day's oven plan).
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

/**
 * Where a dish's `dietaryCompatibility` came from. "none" means nobody has
 * analyzed or declared it yet, so empty lists say nothing about the dish; a
 * planner must not read them as "contains nothing to avoid".
 */
export type DietarySource = "analyzed" | "stale" | "declared" | "none";

/** What every dish offers a meal planner. */
export interface MealDish {
  name: string;
  servings: number;
  category: RecipeCategory;
  dietaryCompatibility: DietaryCompatibility;
  dietarySource: DietarySource;
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
