/** A #recipe with ingredients. */
type RecipeBase = {
  ingredients: string[];
};

/** Schedulable on the #mealPlan. */
type Schedulable = {
  plannedFor: string;
};

type SchemaRoot = RecipeBase & Schedulable;
