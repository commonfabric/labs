## `apps/meal-orchestrator/meal-orchestrator.tsx`

Plan a meal of several dishes: the event (name, date, serving time, guests),
equipment (ovens with rack positions and racks owned, stovetop burners), each
guest's dietary needs, and the menu of recipes and prepared foods from
`apps/food-recipe/`, read through the narrow `RecipeForMeal` /
`PreparedFoodForMeal` role types. "Link Dishes from Notes" has the model pick
the foods out of free-form planning notes, match each to a recipe or prepared
food already in the space (`wish("#recipe" / "#preparedFood")`), or offer to
create one, all reviewed with checkboxes before anything is added; existing
dishes can also be added by hand. It works out the meal's balance (dishes and
servings per course against the guest count), each guest's dietary fit
(unknown is never read as safe; "Analyze Diets" runs the recipes' own
analyzers), and an oven plan that gives every oven step an oven by temperature,
racks and height and reports what cannot fit, drawn as a timeline in clock
time. "Suggest Improvements" asks the model for menu ideas. Burners are
recorded but not scheduled: recipes do not say when they use one.

**Keywords:** meal-planning, recipe, prepared food, oven schedule, conflict
detection, dietary, generateObject, wish, composition, mentionable

### Input Schema

```ts
interface OvenConfig {
  rackPositions: number; // 3-7
  physicalRacks: number; // 1-3
}

interface GuestDietaryProfile {
  guestName: string;
  requirements: string[]; // "vegan", "gluten-free", "no-mushrooms"
}

// RecipeForMeal / PreparedFoodForMeal from ../food-recipe/schemas.tsx, every
// field optional, plus the dish's own stream.
interface MealRecipe extends Partial<RecipeForMeal> {
  analyzeDiet?: Stream<void>;
}
interface MealPreparedFood extends Partial<PreparedFoodForMeal> {
  addDietaryTag?: Stream<{ tag: string }>;
}

interface MealOrchestratorInput {
  mealName?: PerSpace<Writable<string | Default<"">>>;
  mealDate?: PerSpace<Writable<string | Default<"">>>; // "2026-11-26"
  mealTime?: PerSpace<Writable<string | Default<"">>>; // "18:00"
  guestCount?: PerSpace<Writable<number | Default<4>>>;
  ovens?: PerSpace<Writable<OvenConfig[]>>; // default: one 5-position, 2-rack oven
  stovetopBurners?: PerSpace<Writable<number | Default<4>>>;
  dietaryProfiles?: PerSpace<Writable<GuestDietaryProfile[] | Default<[]>>>;
  planningNotes?: PerSpace<Writable<string | Default<"">>>;
  recipes?: PerSpace<Writable<MealRecipe[] | Default<[]>>>;
  preparedFoods?: PerSpace<Writable<MealPreparedFood[] | Default<[]>>>;
  notes?: PerSpace<Writable<string | Default<"">>>;
}
```

### Output Schema

```ts
interface MealOrchestratorOutput {
  // every input field, as a plain value, plus:
  ovenPlan: {
    // start/end in minutes before serving; oven is an index, null if none fits
    events: {
      id: string;
      dish: string;
      step: string;
      start: number;
      end: number;
      temperature: number;
      heightSlots: number;
      width: "full" | "half";
      oven: number | null;
    }[];
    conflicts: {
      id: string;
      dish: string;
      step: string;
      at: number;
      temperature: number;
      with: string[];
      reason: string;
    }[];
    offTimeline: { dish: string; step: string; reason: string }[]; // night before, unscheduled
    warnings: string[]; // still in the oven after serving
  };
  balance: {
    categories: {
      category: RecipeCategory;
      label: string;
      dishes: number;
      servings: number;
    }[];
    dishCount: number;
    totalServings: number;
    warnings: string[];
  };
  dietary: {
    guest: string;
    requirement: string;
    fits: string[];
    conflicts: string[];
    unknown: string[];
    warning: string;
  }[];
  linkAnalysis: { items: LinkItem[] } | null; // under review
  suggestions: { suggestions: string[] } | null;
  mentionable: (RecipeForMeal | PreparedFoodForMeal)[]; // dishes it created
  addOven: Stream<void>;
  removeOven: Stream<{ index: number }>;
  setOvenField: Stream<
    { index: number; field: "rackPositions" | "physicalRacks"; value: string }
  >;
  addGuest: Stream<void>;
  removeGuest: Stream<{ index: number }>;
  setRequirements: Stream<{ index: number; requirements: string[] }>;
  linkNotes: Stream<void>;
  toggleLinkItem: Stream<{ index: number }>;
  applyLinking: Stream<void>;
  cancelLinking: Stream<void>;
  removeRecipe: Stream<{ index: number }>;
  removePreparedFood: Stream<{ index: number }>;
  analyzeDiets: Stream<void>;
  markSuits: Stream<{ index: number; requirement: string }>;
  suggest: Stream<void>;
  clearSuggestions: Stream<void>;
}
```

<!-- demo-list: `apps/meal-orchestrator/` (plan a multi-dish meal: link dishes from notes, dietary fit per guest, meal balance, and an oven plan with conflict detection) -->
