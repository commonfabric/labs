/**
 * Meal Orchestrator — plan a meal of several dishes: who is coming and what
 * they can eat, which recipes and prepared foods make up the menu, whether the
 * menu is balanced, and whether the ovens can cook it all on time.
 *
 * Jot rough ideas in the planning notes and "Link Dishes from Notes" has the
 * model pick out each food, match it to a recipe or prepared food already in
 * the space, or offer to create one; you review and check the list before
 * anything is added. Existing dishes can also be added by hand.
 *
 * The oven plan reads each recipe's step groups (when each starts before
 * serving and what it needs from the oven), gives every dish an oven, and
 * reports any dish no oven can take: a temperature another dish holds, too few
 * racks, or too little height. Balance and dietary fit are worked out from the
 * dishes themselves; dishes nobody has analyzed count as unknown, never safe.
 *
 * Ported from jkomoros/community-patterns (`meal-orchestrator.tsx`). It reads
 * dishes through the narrow `RecipeForMeal` / `PreparedFoodForMeal` role types
 * from `../food-recipe/schemas.tsx`.
 */
import {
  action,
  computed,
  Default,
  equals,
  FS,
  generateObject,
  handler,
  NAME,
  pattern,
  type PerSpace,
  type Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";
import {
  type DietaryCompatibility,
  type PreparedFoodForMeal,
  type RecipeForMeal,
} from "../food-recipe/schemas.tsx";
import FoodRecipe from "../food-recipe/main.tsx";
import PreparedFood from "../food-recipe/prepared-food.tsx";
import {
  clampCategory,
  DEFAULT_OVEN,
  dietaryChecks,
  type DietDish,
  type GuestDietaryProfile,
  type LinkAnalysis,
  LINKING_SYSTEM,
  linkingPrompt,
  type MealBalance,
  mealBalance,
  mealMarkdown,
  type MenuSuggestions,
  normalizeRequirement,
  type OvenConfig,
  type OvenField,
  type OvenPlan,
  planLinking,
  planOvens,
  type RequirementCheck,
  requirementFit,
  stepSummary,
  SUGGESTIONS_SYSTEM,
  suggestionsPrompt,
  tagFor,
  timeLabel,
  timeline,
  withOvenField,
} from "./meal-logic.ts";

/**
 * A recipe in the meal: the `RecipeForMeal` role with every field optional,
 * so one dish missing a field (an older recipe, or one still starting up)
 * reads as that field missing instead of voiding the whole list. Every read
 * defaults. `analyzeDiet` is the recipe's own stream, used to analyze a dish
 * whose dietary fit is unknown or out of date.
 */
export interface MealRecipe extends Partial<RecipeForMeal> {
  analyzeDiet?: Stream<void>;
}

/** A prepared food in the meal: the `PreparedFoodForMeal` role, every field
 * optional for the same reason. `addDietaryTag` records that it suits a
 * requirement, once someone has checked. */
export interface MealPreparedFood extends Partial<PreparedFoodForMeal> {
  addDietaryTag?: Stream<{ tag: string }>;
}

interface MealOrchestratorInput {
  mealName?: PerSpace<Writable<string | Default<"">>>;
  /** ISO date: "2026-11-26". */
  mealDate?: PerSpace<Writable<string | Default<"">>>;
  /** 24-hour serving time: "18:00". */
  mealTime?: PerSpace<Writable<string | Default<"">>>;
  guestCount?: PerSpace<Writable<number | Default<4>>>;
  ovens?: PerSpace<
    Writable<OvenConfig[] | Default<[{ rackPositions: 5; physicalRacks: 2 }]>>
  >;
  stovetopBurners?: PerSpace<Writable<number | Default<4>>>;
  dietaryProfiles?: PerSpace<Writable<GuestDietaryProfile[] | Default<[]>>>;
  /** Rough ideas, free text, to link dishes from. */
  planningNotes?: PerSpace<Writable<string | Default<"">>>;
  recipes?: PerSpace<Writable<MealRecipe[] | Default<[]>>>;
  preparedFoods?: PerSpace<Writable<MealPreparedFood[] | Default<[]>>>;
  notes?: PerSpace<Writable<string | Default<"">>>;
}

/** Meal planner that coordinates several recipes and prepared foods.
 * #mealPlan */
export interface MealOrchestratorOutput {
  [NAME]: string;
  [UI]: VNode;
  [FS]: {
    type: "text/markdown";
    frontmatter: { title: string };
    content: string;
  };
  mealName: string;
  mealDate: string;
  mealTime: string;
  guestCount: number;
  ovens: OvenConfig[];
  stovetopBurners: number;
  dietaryProfiles: GuestDietaryProfile[];
  planningNotes: string;
  recipes: MealRecipe[];
  preparedFoods: MealPreparedFood[];
  notes: string;
  /** Every oven step group placed in an oven, and what does not fit. */
  ovenPlan: OvenPlan;
  balance: MealBalance;
  dietary: RequirementCheck[];
  /** The notes analysis under review, or null. */
  linkAnalysis: LinkAnalysis | null;
  /** Menu suggestions, or null until asked for. */
  suggestions: MenuSuggestions | null;
  /** Dishes this meal created, published so other pieces can find them. */
  mentionable: (RecipeForMeal | PreparedFoodForMeal)[];

  addOven: Stream<void>;
  removeOven: Stream<{ index: number }>;
  setOvenField: Stream<{ index: number; field: OvenField; value: string }>;
  addGuest: Stream<void>;
  removeGuest: Stream<{ index: number }>;
  setRequirements: Stream<{ index: number; requirements: string[] }>;
  /** Ask the model to find the dishes in the planning notes. */
  linkNotes: Stream<void>;
  /** Check or uncheck one found item in the review. */
  toggleLinkItem: Stream<{ index: number }>;
  applyLinking: Stream<void>;
  cancelLinking: Stream<void>;
  removeRecipe: Stream<{ index: number }>;
  removePreparedFood: Stream<{ index: number }>;
  /** Run the dietary analysis of every recipe not analyzed or out of date. */
  analyzeDiets: Stream<void>;
  /** Record that a prepared food suits a requirement. */
  markSuits: Stream<{ index: number; requirement: string }>;
  /** Ask the model for menu suggestions. */
  suggest: Stream<void>;
  clearSuggestions: Stream<void>;
}

type ChangeEvent = { detail?: { value?: string } };

const setNumber = handler<ChangeEvent, { cell: Writable<number>; min: number }>(
  ({ detail }, { cell, min }) => {
    const text = String(detail?.value ?? "").trim();
    const n = Number(text);
    if (text !== "" && Number.isFinite(n)) {
      cell.set(Math.max(min, Math.round(n)));
    }
  },
);

const addRecipe = handler<
  unknown,
  { list: Writable<MealRecipe[]>; dish: Writable<MealRecipe> }
>((_, { list, dish }) => {
  list.addUnique(dish);
});

const addPreparedFood = handler<
  unknown,
  { list: Writable<MealPreparedFood[]>; dish: Writable<MealPreparedFood> }
>((_, { list, dish }) => {
  list.addUnique(dish);
});

/** A recipe whose diet is unknown or out of date and that has ingredients
 * to analyze (the analyzer does nothing without them). */
const canAnalyze = (r: MealRecipe | undefined): boolean =>
  !!r && r.dietarySource !== "analyzed" &&
  (r.ingredients ?? []).some((i) => (i?.item ?? "").trim() !== "");

/** A recipe row's second line. */
const recipeDetail = (r: MealRecipe | undefined): string =>
  r
    ? `${r.category ?? "other"} · serves ${r.servings ?? "?"} · ${
      DIET_LABEL[r.dietarySource ?? "none"] ?? ""
    }`
    : "missing";

/** A prepared food row's second line. */
const preparedDetail = (p: MealPreparedFood | undefined): string =>
  p
    ? `${p.category ?? "other"} · serves ${p.servings ?? "?"}${
      p.requiresReheating ? " · reheat" : ""
    }${p.prepTime ? ` · ${p.prepTime} min prep` : ""}`
    : "missing";

interface PreparedDiet {
  index: number;
  name: string;
  dish: DietDish | null;
}

/** The prepared foods whose fit for `requirement` is unknown, as buttons for
 * recording that someone checked. A meal has a few of each, so the scan per
 * requirement is cheap. */
const markable = (
  foods: readonly PreparedDiet[],
  requirement: string,
): { index: number; label: string }[] =>
  foods
    .filter((p) => p.dish && requirementFit(p.dish, requirement) === "unknown")
    .map((p) => ({
      index: p.index,
      label: `I checked: ${p.name} is ${tagFor(requirement)}`,
    }));

/** A dish's dietary lists copied out as plain data (empty when unknown), so
 * the meal's derived views hold values rather than links into the dish. */
const plainDiet = (
  d: Partial<DietaryCompatibility> | undefined,
): DietaryCompatibility => ({
  compatible: [...(d?.compatible ?? [])],
  incompatible: [...(d?.incompatible ?? [])],
  warnings: [...(d?.warnings ?? [])],
  primaryIngredients: [...(d?.primaryIngredients ?? [])],
});

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

const DIET_LABEL: Record<string, string> = {
  analyzed: "diet analyzed",
  stale: "diet analysis out of date",
  declared: "diet declared",
  none: "diet unknown",
};

const styles = {
  page: "padding: 12px; max-width: 900px;",
  title: { margin: "0 0 2px 0", fontSize: "20px", fontWeight: "700" },
  muted: {
    fontSize: "13px",
    color: "var(--cf-theme-color-text-secondary, #666)",
  },
  section: { margin: "0", fontSize: "14px", fontWeight: "600" },
  sectionHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "8px",
    flexWrap: "wrap",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    gap: "12px",
  },
  label: {
    display: "block",
    marginBottom: "4px",
    fontSize: "13px",
    fontWeight: "500",
  },
  ovenRow: {
    display: "grid",
    gridTemplateColumns: "auto 1fr 1fr auto",
    gap: "8px",
    alignItems: "end",
    padding: "8px",
    border: "1px solid var(--cf-theme-color-border, #e5e7eb)",
    borderRadius: "4px",
    background: "var(--cf-theme-color-surface-tertiary, #f9fafb)",
  },
  ovenName: {
    fontWeight: "600",
    color: "var(--cf-theme-color-text-secondary, #666)",
    fontSize: "14px",
  },
  guest: {
    padding: "8px",
    border: "1px solid var(--cf-theme-color-border, #e5e7eb)",
    borderRadius: "4px",
    background: "var(--cf-theme-color-surface-tertiary, #f9fafb)",
  },
  guestHeader: { display: "flex", gap: "8px", alignItems: "center" },
  dishRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "8px",
    padding: "8px",
    border: "1px solid var(--cf-theme-color-border, #e5e7eb)",
    borderRadius: "4px",
  },
  dishName: { fontWeight: "600" },
  chips: { display: "flex", flexWrap: "wrap", gap: "6px" },
  chip: {
    padding: "4px 10px",
    background: "var(--cf-theme-color-primary-subtle, #eef2ff)",
    color: "var(--cf-theme-color-text, #111)",
    borderRadius: "12px",
    fontSize: "13px",
  },
  warning: {
    padding: "8px 12px",
    background: "var(--cf-theme-color-status-warning-subtle, #fef3c7)",
    color: "var(--cf-theme-color-text, #111)",
    border: "1px solid var(--cf-theme-color-warning, #fcd34d)",
    borderRadius: "4px",
    fontSize: "13px",
  },
  conflict: {
    padding: "8px 12px",
    background: "var(--cf-theme-color-status-error-subtle, #fee2e2)",
    color: "var(--cf-theme-color-text, #111)",
    border: "1px solid var(--cf-theme-color-error, #fca5a5)",
    borderRadius: "4px",
    fontSize: "13px",
  },
  check: {
    padding: "8px",
    border: "1px solid var(--cf-theme-color-border, #e5e7eb)",
    borderRadius: "4px",
    fontSize: "13px",
  },
  axis: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: "11px",
    color: "var(--cf-theme-color-text-secondary, #666)",
  },
  lane: {
    position: "relative",
    height: "26px",
    background: "var(--cf-theme-color-surface-tertiary, #f3f4f6)",
    borderRadius: "2px",
  },
  rowLabel: {
    display: "flex",
    justifyContent: "space-between",
    gap: "8px",
    fontSize: "12px",
  },
  legend: {
    display: "flex",
    gap: "16px",
    fontSize: "11px",
    color: "var(--cf-theme-color-text-secondary, #666)",
  },
  reviewItem: {
    display: "flex",
    gap: "8px",
    alignItems: "flex-start",
    padding: "8px",
    border: "1px solid var(--cf-theme-color-border, #e5e7eb)",
    borderRadius: "4px",
  },
  quote: {
    fontSize: "12px",
    color: "var(--cf-theme-color-text-secondary, #666)",
    fontStyle: "italic",
  },
  error: { fontSize: "13px", color: "var(--cf-theme-color-error, #dc2626)" },
} as const;

const NORMAL_BAR = "linear-gradient(90deg, #93c5fd, #60a5fa)";
const CONFLICT_BAR = "linear-gradient(90deg, #fca5a5, #f87171)";

const MealOrchestrator = pattern<MealOrchestratorInput, MealOrchestratorOutput>(
  ({
    mealName,
    mealDate,
    mealTime,
    guestCount,
    ovens,
    stovetopBurners,
    dietaryProfiles,
    planningNotes,
    recipes,
    preparedFoods,
    notes,
  }) => {
    const displayName = computed(() =>
      mealName.get().trim() || "Untitled Meal"
    );
    const guestText = computed(() => String(guestCount.get()));
    const burnerText = computed(() => String(stovetopBurners.get()));
    const ovenTitle = computed(() =>
      `Equipment (${plural(ovens.get().length, "oven", "ovens")})`
    );
    const needsTitle = computed(() =>
      `Dietary Needs (${
        plural(
          dietaryProfiles.get().filter((p) => (p.requirements ?? []).length > 0)
            .length,
          "guest",
          "guests",
        )
      } with needs)`
    );
    const recipeCount = computed(() => recipes.get().filter(Boolean).length);
    const preparedCount = computed(() =>
      preparedFoods.get().filter(Boolean).length
    );

    // Dishes this meal created. They are also in `recipes` or
    // `preparedFoods`, but stay published here after being removed from the
    // meal, so they are never lost.
    const created = new Writable.perSpace<
      (RecipeForMeal | PreparedFoodForMeal)[]
    >([]);

    // --- Dishes in the space -------------------------------------------------

    const recipeLibrary = wish<MealRecipe>({
      query: "#recipe",
      scope: ["."],
      headless: true,
    }).candidates;
    const preparedLibrary = wish<MealPreparedFood>({
      query: "#preparedFood",
      scope: ["."],
      headless: true,
    }).candidates;

    const libraryFilter = new Writable.perSession<string>("");
    const recipeChoices = computed(() => {
      const q = libraryFilter.get().trim().toLowerCase();
      const inMeal = recipes.get();
      return (recipeLibrary ?? [])
        .filter((r) => !!r && !inMeal.some((m) => equals(m, r)))
        .filter((r) => !q || (r.name ?? "").toLowerCase().includes(q))
        .slice(0, 8);
    });
    const preparedChoices = computed(() => {
      const q = libraryFilter.get().trim().toLowerCase();
      const inMeal = preparedFoods.get();
      return (preparedLibrary ?? [])
        .filter((p) => !!p && !inMeal.some((m) => equals(m, p)))
        .filter((p) => !q || (p.name ?? "").toLowerCase().includes(q))
        .slice(0, 8);
    });
    const hasChoices = computed(() =>
      recipeChoices.length + preparedChoices.length > 0
    );
    const noChoicesText = computed(() =>
      libraryFilter.get().trim()
        ? "Nothing here matches the filter."
        : "No other recipes or prepared foods found here. Link them from the planning notes to create them."
    );

    // --- Equipment and guests -------------------------------------------------

    const addOven = action(() => ovens.push({ ...DEFAULT_OVEN }));
    const removeOven = action(({ index }: { index: number }) => {
      ovens.set(ovens.get().filter((_, i) => i !== index));
    });
    const setOvenField = action(
      ({ index, field, value }: {
        index: number;
        field: OvenField;
        value: string;
      }) => {
        ovens.set(
          ovens.get().map((o, i) =>
            i === index ? withOvenField(o, field, value) : o
          ),
        );
      },
    );

    const addGuest = action(() =>
      dietaryProfiles.push({ guestName: "", requirements: [] })
    );
    const removeGuest = action(({ index }: { index: number }) => {
      dietaryProfiles.set(dietaryProfiles.get().filter((_, i) => i !== index));
    });
    const setRequirements = action(
      ({ index, requirements }: { index: number; requirements: string[] }) => {
        const clean = [
          ...new Set(requirements.map(normalizeRequirement).filter(Boolean)),
        ];
        dietaryProfiles.set(
          dietaryProfiles.get().map((p, i) =>
            i === index ? { ...p, requirements: clean } : p
          ),
        );
      },
    );

    // --- Dishes ---------------------------------------------------------------

    const removeRecipe = action(({ index }: { index: number }) => {
      recipes.set(recipes.get().filter((_, i) => i !== index));
    });
    const removePreparedFood = action(({ index }: { index: number }) => {
      preparedFoods.set(preparedFoods.get().filter((_, i) => i !== index));
    });

    const needsAnalysis = computed(() =>
      recipes.get().filter(canAnalyze).length
    );
    const analyzeLabel = computed(() => `Analyze Diets (${needsAnalysis})`);
    const analyzeDiets = action(() => {
      recipes.get().forEach((r) => {
        if (canAnalyze(r)) r.analyzeDiet?.send();
      });
    });

    // Writes a declared tag into the prepared food itself, where every meal
    // using it sees it; the button says it is for after checking the label.
    const markSuits = action(
      ({ index, requirement }: { index: number; requirement: string }) => {
        const tag = tagFor(requirement);
        const food = preparedFoods.get()[index];
        if (tag && food) food.addDietaryTag?.send({ tag });
      },
    );

    // --- Analysis -------------------------------------------------------------

    const ovenPlan = computed(() =>
      planOvens(
        recipes.get().filter(Boolean).map((r) => ({
          name: r.name ?? "",
          stepGroups: r.stepGroups ?? [],
        })),
        ovens.get(),
      )
    );
    const drawn = computed(() => timeline(ovenPlan, mealTime.get()));
    // Bar offsets as CSS strings, made here: a template literal over a row
    // field inside the bar's style object reaches the DOM as
    // "[object Object]%".
    const bars = computed(() =>
      drawn.rows.map((row) => ({
        ...row,
        leftCss: `${row.left}%`,
        widthCss: `${row.width}%`,
      }))
    );
    const hasTimeline = computed(() => ovenPlan.events.length > 0);
    const hasOvenNotes = computed(() =>
      ovenPlan.events.length + ovenPlan.offTimeline.length > 0
    );
    const ovenHeading = computed(() =>
      `Oven Timeline (${
        plural(ovenPlan.conflicts.length, "conflict", "conflicts")
      })`
    );
    const conflictLines = computed(() =>
      ovenPlan.conflicts.map((c) => ({
        head: `${c.dish} (${c.step}, ${c.temperature}°F from ${
          timeLabel(mealTime.get(), c.at)
        })`,
        reason: c.reason,
      }))
    );
    const offTimelineLines = computed(() =>
      ovenPlan.offTimeline.map((o) => `${o.dish} (${o.step}) is ${o.reason}`)
    );

    const allDishes = computed(() => [
      ...recipes.get().filter(Boolean).map((r) => ({
        name: (r.name ?? "").trim() || "Untitled Recipe",
        servings: r.servings ?? 0,
        category: clampCategory(r.category),
        dietaryCompatibility: plainDiet(r.dietaryCompatibility),
        dietarySource: r.dietarySource ?? "none",
        ingredients: (r.ingredients ?? []).map((i) => i?.item ?? "")
          .filter((i) => i.trim() !== ""),
        kind: "recipe" as const,
      })),
      ...preparedFoods.get().filter(Boolean).map((p) => ({
        name: (p.name ?? "").trim() || "Untitled Item",
        servings: p.servings ?? 0,
        category: clampCategory(p.category),
        dietaryCompatibility: plainDiet(p.dietaryCompatibility),
        dietarySource: p.dietarySource ?? "none",
        kind: "prepared" as const,
      })),
    ]);
    const hasDishes = computed(() => allDishes.length > 0);
    const balance = computed(() => mealBalance(allDishes, guestCount.get()));
    const servingsLine = computed(() =>
      `${plural(balance.dishCount, "dish", "dishes")}, ${
        plural(balance.totalServings, "serving", "servings")
      } in all, for ${plural(guestCount.get(), "guest", "guests")}`
    );
    const dietary = computed(() =>
      dietaryChecks(allDishes, dietaryProfiles.get())
    );
    // Prepared foods by their index in `preparedFoods`, for marking one as
    // suiting a need once someone has checked.
    const preparedDiet = computed((): PreparedDiet[] =>
      preparedFoods.get().map((p, index) => ({
        index,
        name: (p?.name ?? "").trim() || "Untitled Item",
        dish: p
          ? {
            name: p.name ?? "",
            category: clampCategory(p.category),
            dietaryCompatibility: plainDiet(p.dietaryCompatibility),
            dietarySource: p.dietarySource ?? "none",
          }
          : null,
      }))
    );
    const dietaryRows = computed(() =>
      dietary.map((c) => ({
        ...c,
        title: `${c.guest}: ${c.requirement}`,
        fitsText: c.fits.join(", "),
        conflictsText: c.conflicts.join(", "),
        unknownText: c.unknown.join(", "),
        canMark: markable(preparedDiet, c.requirement),
      }))
    );
    const hasDietary = computed(() => dietary.length > 0);

    // --- Menu suggestions -----------------------------------------------------

    const suggestRequest = new Writable.perSession<string>("");
    const suggestLlm = generateObject<MenuSuggestions>({
      system: SUGGESTIONS_SYSTEM,
      prompt: suggestRequest,
      // The default model rejects this schema in strict mode
      // (`additionalProperties` must be false, which toolshed does not add),
      // so name one that accepts it. Remove once top/3114 is fixed.
      model: "anthropic:claude-haiku-4-5",
    });
    const suggestions = computed((): MenuSuggestions | null =>
      suggestRequest.get() && suggestLlm.result ? suggestLlm.result : null
    );
    const suggesting = computed(() => !!suggestLlm.pending);
    const suggestError = computed(() =>
      suggestRequest.get() && suggestLlm.error ? String(suggestLlm.error) : ""
    );
    const suggestLabel = computed(() =>
      suggesting ? "Suggesting..." : "Suggest Improvements"
    );
    const suggest = action(() => {
      const retry = suggestError ? `\n\n(retry ${Date.now()})` : "";
      suggestRequest.set(
        suggestionsPrompt({
          mealName: mealName.get(),
          guestCount: guestCount.get(),
          dishes: allDishes,
          requirements: [
            ...new Set(
              dietaryProfiles.get().flatMap((p) => p.requirements ?? []),
            ),
          ],
          knownProblems: [
            ...balance.warnings,
            ...dietary.map((c) => c.warning).filter(Boolean),
            ...ovenPlan.conflicts.map((c) => `${c.dish}: ${c.reason}`),
            ...ovenPlan.warnings,
          ],
        }) + retry,
      );
    });
    const clearSuggestions = action(() => suggestRequest.set(""));

    // --- Linking planning notes ----------------------------------------------
    // The request and the review belong to the person linking, so they are
    // per session; what is applied lands in the shared meal.

    const linkRequest = new Writable.perSession<string>("");
    const unchecked = new Writable.perSession<number[]>([]);
    const linkLlm = generateObject<LinkAnalysis>({
      system: LINKING_SYSTEM,
      prompt: linkRequest,
      // The default model rejects this schema in strict mode
      // (`additionalProperties` must be false, which toolshed does not add),
      // so name one that accepts it. Remove once top/3114 is fixed.
      model: "anthropic:claude-haiku-4-5",
    });
    const linkAnalysis = computed((): LinkAnalysis | null =>
      linkRequest.get() && linkLlm.result ? linkLlm.result : null
    );
    const linking = computed(() => !!linkLlm.pending);
    const linkError = computed(() =>
      linkRequest.get() && linkLlm.error ? String(linkLlm.error) : ""
    );
    const linkLabel = computed(() =>
      linking ? "Linking..." : "Link Dishes from Notes"
    );
    const canLink = computed(() =>
      !linking && planningNotes.get().trim() !== ""
    );

    const libraryRecipeNames = computed(() =>
      (recipeLibrary ?? []).map((r) => r?.name ?? "")
    );
    const libraryPreparedNames = computed(() =>
      (preparedLibrary ?? []).map((p) => p?.name ?? "")
    );
    const inMealNames = computed(() => allDishes.map((d) => d.name));

    const reviewSteps = computed(() =>
      planLinking({
        items: linkAnalysis?.items ?? [],
        unchecked: unchecked.get(),
        libraryRecipes: libraryRecipeNames,
        libraryPrepared: libraryPreparedNames,
        inMeal: inMealNames,
      })
    );
    const reviewRows = computed(() =>
      (linkAnalysis?.items ?? []).map((item, index) => {
        const step = reviewSteps[index];
        const checked = !unchecked.get().includes(index);
        const details = [
          item.servings ? `serves ${item.servings}` : "",
          item.category ?? "",
          item.source ?? "",
        ].filter(Boolean).join(" · ");
        return {
          index,
          checked,
          // A dish already in the meal is skipped whatever the box says.
          toggleable: !(step?.kind === "skip" && step.reason !== "unchecked"),
          name: step && step.kind !== "skip"
            ? step.name
            : (item.name ?? "").trim() || "(unnamed)",
          action: step ? stepSummary(step) : "",
          details,
          quote: item.quote ? `"${item.quote}"` : "",
        };
      })
    );
    const reviewEmpty = computed(() => reviewRows.length === 0);

    const linkNotes = action(() => {
      const text = planningNotes.get();
      if (!text.trim()) return;
      const retry = linkError ? `\n\n(retry ${Date.now()})` : "";
      unchecked.set([]);
      linkRequest.set(
        linkingPrompt({
          notes: text,
          libraryRecipes: libraryRecipeNames,
          libraryPrepared: libraryPreparedNames,
          inMeal: inMealNames,
        }) + retry,
      );
    });
    const toggleLinkItem = action(({ index }: { index: number }) => {
      const list = unchecked.get();
      unchecked.set(
        list.includes(index)
          ? list.filter((i) => i !== index)
          : [...list, index],
      );
    });
    const cancelLinking = action(() => {
      linkRequest.set("");
      unchecked.set([]);
    });
    const applyLinking = action(() => {
      if (!linkAnalysis) return;
      reviewSteps.forEach((step) => {
        if (step.kind === "link") {
          if (step.type === "recipe") {
            const dish = recipeLibrary[step.index];
            if (dish) recipes.push(dish);
          } else {
            const dish = preparedLibrary[step.index];
            if (dish) preparedFoods.push(dish);
          }
        } else if (step.kind === "create") {
          if (step.type === "recipe") {
            const dish = FoodRecipe({
              name: step.name,
              servings: step.servings,
              category: step.category,
              notes: step.notes,
              source: step.source,
            });
            recipes.push(dish);
            created.push(dish);
          } else {
            const dish = PreparedFood({
              name: step.name,
              servings: step.servings,
              category: step.category,
              description: step.notes,
              source: step.source,
            });
            preparedFoods.push(dish);
            created.push(dish);
          }
        }
      });
      linkRequest.set("");
      unchecked.set([]);
    });

    const fsContent = computed(() =>
      mealMarkdown({
        name: displayName,
        date: mealDate.get(),
        time: mealTime.get(),
        guestCount: guestCount.get(),
        recipes: allDishes.filter((d) => d.kind === "recipe"),
        preparedFoods: allDishes.filter((d) => d.kind === "prepared"),
        guests: dietaryProfiles.get(),
        ovenPlan,
        notes: notes.get(),
      })
    );

    // --- View -----------------------------------------------------------------

    // The review opens from derived state, which it must not write: with
    // dismissible={false} cf-modal never writes $open, and Cancel/Apply close
    // it by clearing the request.
    const linkReview = (
      <cf-modal
        $open={computed(() => linkAnalysis !== null)}
        dismissible={false}
        size="lg"
      >
        <div slot="header">
          <h3 style={styles.section}>Review Dishes from Notes</h3>
        </div>
        <cf-vstack gap="2">
          {reviewEmpty
            ? <div style={styles.muted}>No dishes found in the notes.</div>
            : null}
          {reviewRows.map((row) => (
            <div style={styles.reviewItem}>
              {row.toggleable
                ? (
                  <cf-checkbox
                    checked={row.checked}
                    oncf-change={() =>
                      toggleLinkItem.send({ index: row.index })}
                  />
                )
                : null}
              <cf-vstack gap="1">
                <strong>{row.name}</strong>
                <div style={styles.muted}>{row.action}</div>
                {row.details
                  ? <div style={styles.muted}>{row.details}</div>
                  : null}
                {row.quote ? <div style={styles.quote}>{row.quote}</div> : null}
              </cf-vstack>
            </div>
          ))}
        </cf-vstack>
        <div slot="footer">
          <cf-hstack gap="2" justify="end">
            <cf-button variant="secondary" onClick={cancelLinking}>
              Cancel
            </cf-button>
            <cf-button variant="primary" onClick={applyLinking}>
              Add Checked
            </cf-button>
          </cf-hstack>
        </div>
      </cf-modal>
    );

    return {
      [NAME]: computed(() => `🍽️ ${displayName}`),
      [UI]: (
        <cf-screen>
          <cf-vstack gap="2" style={styles.page}>
            <div>
              <h1 style={styles.title}>{displayName}</h1>
              <div style={styles.muted}>
                Plan a meal of several dishes, with oven scheduling and dietary
                checks
              </div>
            </div>

            <cf-card>
              <cf-vstack gap="2">
                <h3 style={styles.section}>Event</h3>
                <div style={styles.grid}>
                  <label>
                    <span style={styles.label}>Meal Name</span>
                    <cf-input
                      $value={mealName}
                      placeholder="e.g., Thanksgiving Dinner"
                    />
                  </label>
                  <label>
                    <span style={styles.label}>Guests</span>
                    <cf-input
                      type="number"
                      min="1"
                      value={guestText}
                      oncf-change={setNumber({ cell: guestCount, min: 1 })}
                    />
                  </label>
                  <label>
                    <span style={styles.label}>Date</span>
                    <cf-input type="date" $value={mealDate} />
                  </label>
                  <label>
                    <span style={styles.label}>Serving Time</span>
                    <cf-input type="time" $value={mealTime} />
                  </label>
                </div>
              </cf-vstack>
            </cf-card>

            <cf-card>
              <cf-vstack gap="2">
                <div style={styles.sectionHeader}>
                  <h3 style={styles.section}>
                    {ovenTitle}
                  </h3>
                  <cf-button variant="secondary" onClick={addOven}>
                    + Add Oven
                  </cf-button>
                </div>
                {ovens.map((oven, index) => (
                  <div style={styles.ovenRow}>
                    <div style={styles.ovenName}>Oven {index + 1}</div>
                    <label>
                      <span style={styles.label}>Rack positions (3-7)</span>
                      <cf-input
                        type="number"
                        min="3"
                        max="7"
                        value={computed(() => String(oven.rackPositions))}
                        oncf-change={(e: ChangeEvent) =>
                          setOvenField.send({
                            index,
                            field: "rackPositions",
                            value: e?.detail?.value ?? "",
                          })}
                      />
                    </label>
                    <label>
                      <span style={styles.label}>Racks owned (1-3)</span>
                      <cf-input
                        type="number"
                        min="1"
                        max="3"
                        value={computed(() => String(oven.physicalRacks))}
                        oncf-change={(e: ChangeEvent) =>
                          setOvenField.send({
                            index,
                            field: "physicalRacks",
                            value: e?.detail?.value ?? "",
                          })}
                      />
                    </label>
                    <cf-button
                      variant="ghost"
                      aria-label="Remove oven"
                      onClick={() => removeOven.send({ index })}
                    >
                      ×
                    </cf-button>
                  </div>
                ))}
                <label style={{ maxWidth: "200px" }}>
                  <span style={styles.label}>Stovetop burners</span>
                  <cf-input
                    type="number"
                    min="0"
                    max="12"
                    value={burnerText}
                    oncf-change={setNumber({ cell: stovetopBurners, min: 0 })}
                  />
                </label>
                <div style={styles.muted}>
                  Recipes do not record burner use yet, so only the ovens are
                  scheduled.
                </div>
              </cf-vstack>
            </cf-card>

            <cf-card>
              <cf-vstack gap="2">
                <div style={styles.sectionHeader}>
                  <h3 style={styles.section}>
                    {needsTitle}
                  </h3>
                  <cf-button variant="secondary" onClick={addGuest}>
                    + Add Guest
                  </cf-button>
                </div>
                {dietaryProfiles.map((profile, index) => (
                  <div style={styles.guest}>
                    <cf-vstack gap="1">
                      <div style={styles.guestHeader}>
                        <cf-input
                          $value={profile.guestName}
                          placeholder="Guest name (optional)"
                          style="flex: 1;"
                        />
                        <cf-button
                          variant="ghost"
                          aria-label="Remove guest"
                          onClick={() =>
                            removeGuest.send({ index })}
                        >
                          ×
                        </cf-button>
                      </div>
                      <cf-tags
                        tags={profile.requirements}
                        oncf-change={(
                          e: { detail?: { tags?: string[] } },
                        ) =>
                          setRequirements.send({
                            index,
                            requirements: e?.detail?.tags ?? [],
                          })}
                      />
                    </cf-vstack>
                  </div>
                ))}
                <div style={styles.muted}>
                  Tags like vegan, gluten-free, nut-free, or no-mushrooms.
                </div>
              </cf-vstack>
            </cf-card>

            <cf-card>
              <cf-vstack gap="2">
                <div style={styles.sectionHeader}>
                  <h3 style={styles.section}>Planning Notes</h3>
                  <cf-button
                    disabled={computed(() => !canLink)}
                    onClick={linkNotes}
                  >
                    {linkLabel}
                  </cf-button>
                </div>
                <cf-textarea
                  $value={planningNotes}
                  rows={4}
                  autoResize
                  placeholder="Rough ideas: turkey, Mom's stuffing, pie from Costco, Sam brings rolls..."
                />
                {linkError
                  ? (
                    <div style={styles.error}>
                      Linking failed: {linkError}
                    </div>
                  )
                  : null}
              </cf-vstack>
            </cf-card>

            <cf-card>
              <cf-vstack gap="2">
                <div style={styles.sectionHeader}>
                  <h3 style={styles.section}>🍳 Recipes ({recipeCount})</h3>
                  {needsAnalysis > 0
                    ? (
                      <cf-button variant="secondary" onClick={analyzeDiets}>
                        {analyzeLabel}
                      </cf-button>
                    )
                    : null}
                </div>
                {recipes.map((recipe, index) => (
                  <div style={styles.dishRow}>
                    <div>
                      <div style={styles.dishName}>
                        {computed(() =>
                          (recipe?.name ?? "").trim() || "Untitled Recipe"
                        )}
                      </div>
                      <div style={styles.muted}>
                        {computed(() => recipeDetail(recipe))}
                      </div>
                    </div>
                    <cf-hstack gap="1" align="center">
                      <cf-cell-link $cell={recipe} label="Open" static />
                      <cf-button
                        variant="ghost"
                        aria-label="Remove recipe"
                        onClick={() => removeRecipe.send({ index })}
                      >
                        ×
                      </cf-button>
                    </cf-hstack>
                  </div>
                ))}
              </cf-vstack>
            </cf-card>

            <cf-card>
              <cf-vstack gap="2">
                <h3 style={styles.section}>
                  🛒 Prepared Foods ({preparedCount})
                </h3>
                {preparedFoods.map((food, index) => (
                  <div style={styles.dishRow}>
                    <div>
                      <div style={styles.dishName}>
                        {computed(() =>
                          (food?.name ?? "").trim() || "Untitled Item"
                        )}
                      </div>
                      <div style={styles.muted}>
                        {computed(() => preparedDetail(food))}
                      </div>
                    </div>
                    <cf-hstack gap="1" align="center">
                      <cf-cell-link $cell={food} label="Open" static />
                      <cf-button
                        variant="ghost"
                        aria-label="Remove prepared food"
                        onClick={() => removePreparedFood.send({ index })}
                      >
                        ×
                      </cf-button>
                    </cf-hstack>
                  </div>
                ))}
              </cf-vstack>
            </cf-card>

            <cf-card>
              <cf-vstack gap="2">
                <h3 style={styles.section}>Add Dishes from This Space</h3>
                <cf-input
                  $value={libraryFilter}
                  placeholder="Filter recipes and prepared foods..."
                />
                {hasChoices
                  ? null
                  : <div style={styles.muted}>{noChoicesText}</div>}
                <div style={styles.chips}>
                  {recipeChoices.map((dish) => (
                    <cf-button
                      variant="ghost"
                      size="sm"
                      onClick={addRecipe({ list: recipes, dish })}
                    >
                      + 🍳 {dish.name}
                    </cf-button>
                  ))}
                  {preparedChoices.map((dish) => (
                    <cf-button
                      variant="ghost"
                      size="sm"
                      onClick={addPreparedFood({ list: preparedFoods, dish })}
                    >
                      + 🛒 {dish.name}
                    </cf-button>
                  ))}
                </div>
              </cf-vstack>
            </cf-card>

            {hasDishes
              ? (
                <cf-card>
                  <cf-vstack gap="2">
                    <div style={styles.sectionHeader}>
                      <h3 style={styles.section}>Meal Balance</h3>
                      <cf-button
                        variant="secondary"
                        disabled={suggesting}
                        onClick={suggest}
                      >
                        {suggestLabel}
                      </cf-button>
                    </div>
                    <div style={styles.chips}>
                      {balance.categories.map((line) => (
                        <span style={styles.chip}>
                          {line.label}: {line.dishes} ({line.servings} servings)
                        </span>
                      ))}
                    </div>
                    <div style={styles.muted}>{servingsLine}</div>
                    {balance.warnings.map((w) => (
                      <div style={styles.warning}>{w}</div>
                    ))}
                    {hasDietary
                      ? (
                        <cf-vstack gap="1">
                          <h4 style={styles.section}>Dietary Fit</h4>
                          {dietaryRows.map((row) => (
                            <div style={styles.check}>
                              <strong>{row.title}</strong>
                              {row.warning
                                ? (
                                  <div style={styles.warning}>
                                    {row.warning}
                                  </div>
                                )
                                : null}
                              {row.fitsText
                                ? <div>✓ Suits: {row.fitsText}</div>
                                : null}
                              {row.conflictsText
                                ? (
                                  <div>
                                    ✗ Does not suit: {row.conflictsText}
                                  </div>
                                )
                                : null}
                              {row.unknownText
                                ? <div>? Unknown: {row.unknownText}</div>
                                : null}
                              {row.canMark.map((mark) => (
                                <cf-button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() =>
                                    markSuits.send({
                                      index: mark.index,
                                      requirement: row.requirement,
                                    })}
                                >
                                  {mark.label}
                                </cf-button>
                              ))}
                            </div>
                          ))}
                        </cf-vstack>
                      )
                      : null}
                    {suggestError
                      ? (
                        <div style={styles.error}>
                          Suggestions failed: {suggestError}
                        </div>
                      )
                      : null}
                    {suggestions
                      ? (
                        <cf-vstack gap="1">
                          <div style={styles.sectionHeader}>
                            <h4 style={styles.section}>Suggestions</h4>
                            <cf-button
                              variant="ghost"
                              size="sm"
                              onClick={clearSuggestions}
                            >
                              Dismiss
                            </cf-button>
                          </div>
                          <ul style={{ margin: "0", paddingLeft: "20px" }}>
                            {computed(() => suggestions?.suggestions ?? []).map(
                              (s) => <li>{s}</li>,
                            )}
                          </ul>
                        </cf-vstack>
                      )
                      : null}
                  </cf-vstack>
                </cf-card>
              )
              : null}

            {hasOvenNotes
              ? (
                <cf-card>
                  <cf-vstack gap="2">
                    <h3 style={styles.section}>
                      {ovenHeading}
                    </h3>
                    {conflictLines.map((c) => (
                      <div style={styles.conflict}>
                        <strong>{c.head}</strong>: {c.reason}
                      </div>
                    ))}
                    {ovenPlan.warnings.map((w) => (
                      <div style={styles.warning}>{w}</div>
                    ))}
                    {hasTimeline
                      ? (
                        <cf-vstack gap="1">
                          <div style={styles.axis}>
                            <span>{drawn.axis[0]}</span>
                            <span>{drawn.axis[1]}</span>
                            <span>{drawn.axis[2]}</span>
                          </div>
                          {bars.map((row) => (
                            <div>
                              <div style={styles.rowLabel}>
                                <span>
                                  <strong>{row.dish}</strong> · {row.step}
                                </span>
                                <span>{row.ovenLabel} · {row.when}</span>
                              </div>
                              <div style={styles.lane}>
                                <div
                                  style={{
                                    position: "absolute",
                                    top: "0",
                                    height: "100%",
                                    left: row.leftCss,
                                    width: row.widthCss,
                                    background: row.conflict
                                      ? CONFLICT_BAR
                                      : NORMAL_BAR,
                                    borderRadius: "2px",
                                    color: "#fff",
                                    fontSize: "11px",
                                    fontWeight: "600",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    overflow: "hidden",
                                  }}
                                >
                                  {row.temperature}°F
                                </div>
                              </div>
                            </div>
                          ))}
                          <div style={styles.legend}>
                            <span>Blue: has an oven</span>
                            <span>Red: no oven can take it then</span>
                          </div>
                        </cf-vstack>
                      )
                      : null}
                    {offTimelineLines.map((line) => (
                      <div style={styles.muted}>
                        Not on the day's plan: {line}
                      </div>
                    ))}
                  </cf-vstack>
                </cf-card>
              )
              : null}

            <cf-card>
              <cf-vstack gap="2">
                <h3 style={styles.section}>Notes</h3>
                <cf-textarea
                  $value={notes}
                  rows={3}
                  autoResize
                  placeholder="Anything else: who brings what, serving dishes, seating..."
                />
              </cf-vstack>
            </cf-card>

            {linkReview}
          </cf-vstack>
        </cf-screen>
      ),
      [FS]: {
        type: "text/markdown",
        frontmatter: { title: displayName },
        content: fsContent,
      },
      mealName,
      mealDate,
      mealTime,
      guestCount,
      ovens,
      stovetopBurners,
      dietaryProfiles,
      planningNotes,
      recipes,
      preparedFoods,
      notes,
      ovenPlan,
      balance,
      dietary,
      linkAnalysis,
      suggestions,
      mentionable: created,
      addOven,
      removeOven,
      setOvenField,
      addGuest,
      removeGuest,
      setRequirements,
      linkNotes,
      toggleLinkItem,
      applyLinking,
      cancelLinking,
      removeRecipe,
      removePreparedFood,
      analyzeDiets,
      markSuits,
      suggest,
      clearSuggestions,
    };
  },
);

export default MealOrchestrator;
