## `apps/food-recipe/food-recipe.tsx`

One recipe with what a cook and a meal planner need from it: ingredients, steps
grouped into phases timed against serving (nights before, or minutes before)
with durations, how long each result can wait, and oven needs (temperature,
minutes, rack height and width); servings scaling that understands fractions;
dietary analysis (`recipe-analyzer.tsx`, run on request and flagged when out of
date); and a cooking view with a checkbox per step (`viewer.tsx`). Paste a
recipe or add photos and "Extract Recipe Data" has the model fill the fields,
shown as a field-by-field diff (the notes as a word diff) to apply or cancel;
"Suggest Timing" proposes timing for the step groups the same way. Shared types
live in `schemas.tsx`; a meal planner should read the narrow `RecipeForMeal`
role type rather than the full output.

**Keywords:** recipe, cooking, meal-planning, generateObject, image extraction,
diff review, oven, dietary

### Input Schema

```ts
interface Ingredient {
  item: string;
  amount: string; // free text: "1 1/2", "2-3"
  unit: string;
}

interface OvenNeed {
  temperature: number; // °F
  duration: number; // minutes in the oven
  heightSlots: number; // 1 sheet pan, 2 casserole, 5 turkey
  width: "full" | "half";
}

interface StepGroup {
  id: string;
  name: string;
  nightsBeforeServing?: number; // exclusive with minutesBeforeServing
  minutesBeforeServing?: number;
  duration?: number;
  maxWaitMinutes?: number;
  oven?: OvenNeed; // absent when no oven
  steps: { description: string }[];
}

interface FoodRecipeInput {
  name?: PerSpace<Writable<string | Default<"">>>;
  cuisine?: PerSpace<Writable<string | Default<"">>>;
  servings?: PerSpace<Writable<number | Default<4>>>;
  yield?: PerSpace<Writable<string | Default<"">>>;
  difficulty?: PerSpace<Writable<Difficulty | Default<"medium">>>;
  prepTime?: PerSpace<Writable<number | Default<0>>>;
  cookTime?: PerSpace<Writable<number | Default<0>>>;
  restTime?: PerSpace<Writable<number | Default<0>>>;
  holdTime?: PerSpace<Writable<number | Default<0>>>;
  category?: PerSpace<Writable<RecipeCategory | Default<"other">>>;
  ingredients?: PerSpace<Writable<Ingredient[] | Default<[]>>>;
  stepGroups?: PerSpace<Writable<StepGroup[] | Default<[]>>>;
  tags?: PerSpace<Writable<string[] | Default<[]>>>;
  notes?: PerSpace<Writable<string | Default<"">>>;
  source?: PerSpace<Writable<string | Default<"">>>;
}
```

### Output Schema

```ts
interface FoodRecipeOutput {
  // every input field, as a plain value, plus:
  totalTime: number; // prep + cook + rest
  ovenRequirements: {
    needsOven: boolean;
    temps: number[];
    tempChanges: boolean;
  };
  dietaryCompatibility: {
    compatible: string[];
    incompatible: string[];
    warnings: string[];
    primaryIngredients: string[];
  };
  // "none" = not analyzed yet: empty lists mean unknown, not safe
  dietarySource: "analyzed" | "stale" | "none";
  analyzeDiet: Stream<void>;
  extraction: RecipeExtraction | null; // under review
  timingSuggestions: TimingSuggestions | null; // under review
  extract: Stream<void>;
  applyExtraction: Stream<void>;
  cancelExtraction: Stream<void>;
  suggestTiming: Stream<void>;
  applyTiming: Stream<void>;
  cancelTiming: Stream<void>;
  scale: Stream<{ factor: number }>;
  addIngredient: Stream<void>;
  removeIngredient: Stream<{ index: number }>;
  addStepGroup: Stream<void>;
  removeStepGroup: Stream<{ id: string }>;
  moveStepGroup: Stream<{ id: string; delta: number }>;
  addStep: Stream<{ id: string }>;
  removeStep: Stream<{ id: string; step: number }>;
  moveStep: Stream<{ id: string; step: number; delta: number }>;
  setGroupNumber: Stream<
    { id: string; field: GroupNumberField; value: string }
  >;
  setOven: Stream<{ id: string; field: OvenField; value: string }>;
  cook: Stream<void>; // opens the cooking view
}
```

## `apps/food-recipe/prepared-food.tsx`

A dish nobody cooks from a recipe (store-bought, guest-brought, takeout) for
meal planning: servings, category, prep time, whether it needs reheating, and
hand-declared dietary tags (common tags one tap away) and main ingredients. Its
`dietaryCompatibility` has the recipe's shape so a planner treats both alike;
`PreparedFoodForMeal` in `schemas.tsx` is the narrow role type.

**Keywords:** meal-planning, prepared food, takeout, dietary tags, cf-tags

### Input Schema

```ts
interface PreparedFoodInput {
  name?: PerSpace<Writable<string | Default<"">>>;
  servings?: PerSpace<Writable<number | Default<4>>>;
  category?: PerSpace<Writable<RecipeCategory | Default<"other">>>;
  dietaryTags?: PerSpace<Writable<string[] | Default<[]>>>;
  primaryIngredients?: PerSpace<Writable<string[] | Default<[]>>>;
  description?: PerSpace<Writable<string | Default<"">>>;
  source?: PerSpace<Writable<string | Default<"">>>;
  prepTime?: PerSpace<Writable<number | Default<0>>>;
  requiresReheating?: PerSpace<Writable<boolean | Default<false>>>;
}
```

### Output Schema

```ts
interface PreparedFoodOutput {
  // every input field, as a plain value, plus:
  dietaryCompatibility: DietaryCompatibility; // compatible = dietaryTags
  dietarySource: "declared";
  addDietaryTag: Stream<{ tag: string }>;
}
```

<!-- demo-list: `apps/food-recipe/` (recipes with timed step groups, oven needs, photo/text extraction with diff review, a cooking view, and prepared food for meal planning) -->
