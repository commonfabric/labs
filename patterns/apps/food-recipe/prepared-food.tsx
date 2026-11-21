/**
 * Prepared Food — a dish nobody cooks from a recipe: store-bought, brought by
 * a guest, or takeout. It records what a meal planner needs to fit it in:
 * servings, category, how much prep or reheating it wants, and its dietary
 * fit. With no ingredient list to analyze, the dietary tags and main
 * ingredients are declared by hand; common tags are one tap away.
 *
 * Ported from jkomoros/community-patterns (`prepared-food.tsx`). Tags and
 * ingredients use `cf-tags`, and its `dietaryCompatibility` has the same shape
 * as a recipe's so a planner treats both alike; `dietarySource` is "declared" once
 * something is entered and "none" before.
 */
import {
  action,
  computed,
  Default,
  FS,
  handler,
  NAME,
  pattern,
  type PerSpace,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import {
  CATEGORY_ITEMS,
  type DietaryCompatibility,
  type DietarySource,
  type PreparedFoodForMeal,
  type RecipeCategory,
} from "./schemas.tsx";

export const COMMON_DIETARY_TAGS = [
  "vegan",
  "vegetarian",
  "gluten-free",
  "dairy-free",
  "nut-free",
  "soy-free",
  "egg-free",
  "shellfish-free",
  "pescatarian",
  "kosher",
  "halal",
  "keto",
  "low-carb",
  "low-sodium",
];

export const DECLARED_WARNING =
  "Declared by hand, not analyzed: check the label or ask who made it.";

/** `list` lowercased, trimmed and without repeats or blanks. */
export const normalizedTags = (list: readonly string[]): string[] => [
  ...new Set(list.map((t) => t.trim().toLowerCase()).filter(Boolean)),
];

interface PreparedFoodInput {
  name?: PerSpace<Writable<string | Default<"">>>;
  servings?: PerSpace<Writable<number | Default<4>>>;
  category?: PerSpace<Writable<RecipeCategory | Default<"other">>>;
  /** Diets it suits, declared by hand. */
  dietaryTags?: PerSpace<Writable<string[] | Default<[]>>>;
  /** Main ingredients, for "no-X" matching. */
  primaryIngredients?: PerSpace<Writable<string[] | Default<[]>>>;
  description?: PerSpace<Writable<string | Default<"">>>;
  /** Where it comes from: "Costco", "Aunt Mary". */
  source?: PerSpace<Writable<string | Default<"">>>;
  /** Minutes of prep it still needs. */
  prepTime?: PerSpace<Writable<number | Default<0>>>;
  requiresReheating?: PerSpace<Writable<boolean | Default<false>>>;
}

/** Prepared food: store-bought, guest-brought or takeout. #preparedFood */
export interface PreparedFoodOutput {
  [NAME]: string;
  [UI]: VNode;
  [FS]: {
    type: "text/markdown";
    frontmatter: { title: string };
    content: string;
  };
  name: string;
  servings: number;
  category: RecipeCategory;
  dietaryTags: string[];
  primaryIngredients: string[];
  description: string;
  source: string;
  prepTime: number;
  requiresReheating: boolean;
  /** The declared tags in the shape a recipe's analysis has. */
  dietaryCompatibility: DietaryCompatibility;
  /** "declared" once a tag or main ingredient is entered, else "none". */
  dietarySource: DietarySource;
  /** Add a dietary tag (lowercased; repeats ignored). */
  addDietaryTag: Stream<{ tag: string }>;
}

/** The output must keep serving `PreparedFoodForMeal`; this fails to compile
 * if it drifts. */
export const asPreparedFoodForMeal = (
  food: PreparedFoodOutput,
): PreparedFoodForMeal => food;

const setList = handler<
  { detail?: { tags?: string[] } },
  { list: Writable<string[]> }
>(({ detail }, { list }) => {
  list.set(normalizedTags(detail?.tags ?? []));
});

const setNumber = handler<
  { detail?: { value?: string } },
  { cell: Writable<number>; min: number }
>(({ detail }, { cell, min }) => {
  const text = String(detail?.value ?? "").trim();
  const n = Number(text);
  if (text !== "" && Number.isFinite(n)) cell.set(Math.max(min, Math.round(n)));
});

const styles = {
  page: "padding: 12px; max-width: 700px;",
  title: { margin: "0 0 2px 0", fontSize: "20px", fontWeight: "700" },
  muted: { fontSize: "13px", color: "#666" },
  section: { margin: "0", fontSize: "14px", fontWeight: "600" },
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
  quick: { display: "flex", flexWrap: "wrap", gap: "4px" },
  check: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    fontSize: "14px",
  },
} as const;

const PreparedFood = pattern<PreparedFoodInput, PreparedFoodOutput>(
  ({
    name,
    servings,
    category,
    dietaryTags,
    primaryIngredients,
    description,
    source,
    prepTime,
    requiresReheating,
  }) => {
    const displayName = computed(() => name.get().trim() || "Untitled Item");
    const servingsText = computed(() => String(servings.get()));
    const prepText = computed(() => String(prepTime.get()));
    const unusedCommonTags = computed(() =>
      COMMON_DIETARY_TAGS.filter((t) => !dietaryTags.get().includes(t))
    );

    const dietaryCompatibility = computed((): DietaryCompatibility => ({
      compatible: [...dietaryTags.get()],
      incompatible: [],
      warnings: dietaryTags.get().length || primaryIngredients.get().length
        ? [DECLARED_WARNING]
        : [],
      primaryIngredients: [...primaryIngredients.get()],
    }));

    // Empty lists mean nobody has said anything yet, not "contains nothing".
    const dietarySource = computed((): DietarySource =>
      dietaryTags.get().length || primaryIngredients.get().length
        ? "declared"
        : "none"
    );

    const addDietaryTag = action(({ tag }: { tag: string }) => {
      dietaryTags.set(normalizedTags([...dietaryTags.get(), tag]));
    });

    const fsContent = computed(() =>
      [
        `# ${displayName}`,
        "",
        `Prepared food · ${category.get()} · serves ${servings.get()}`,
        source.get() ? `From: ${source.get()}` : "",
        description.get(),
        dietaryTags.get().length
          ? `Dietary: ${dietaryTags.get().join(", ")}`
          : "",
        primaryIngredients.get().length
          ? `Main ingredients: ${primaryIngredients.get().join(", ")}`
          : "",
        prepTime.get() ? `Prep: ${prepTime.get()} min` : "",
        requiresReheating.get() ? "Needs reheating" : "",
      ].filter(Boolean).join("\n")
    );

    return {
      [NAME]: computed(() => `🛒 ${displayName}`),
      [UI]: (
        <cf-screen>
          <cf-vstack gap="2" style={styles.page}>
            <div>
              <h1 style={styles.title}>{displayName}</h1>
              <div style={styles.muted}>
                Prepared food (store-bought, guest-brought, or takeout)
              </div>
            </div>

            <cf-card>
              <cf-vstack gap="2">
                <h3 style={styles.section}>Basic Info</h3>
                <div style={styles.grid}>
                  <label>
                    <span style={styles.label}>Name</span>
                    <cf-input
                      $value={name}
                      placeholder="e.g., Costco Rotisserie Chicken"
                    />
                  </label>
                  <label>
                    <span style={styles.label}>Source</span>
                    <cf-input
                      $value={source}
                      placeholder="e.g., Costco, Aunt Mary"
                    />
                  </label>
                  <label>
                    <span style={styles.label}>Servings</span>
                    <cf-input
                      type="number"
                      min="1"
                      value={servingsText}
                      oncf-change={setNumber({ cell: servings, min: 1 })}
                    />
                  </label>
                  <label>
                    <span style={styles.label}>Category</span>
                    <cf-select $value={category} items={CATEGORY_ITEMS} />
                  </label>
                </div>
                <label>
                  <span style={styles.label}>Description</span>
                  <cf-input
                    $value={description}
                    placeholder="e.g., Whole roasted chicken, ready to serve"
                  />
                </label>
              </cf-vstack>
            </cf-card>

            <cf-card>
              <cf-vstack gap="2">
                <h3 style={styles.section}>Dietary Compatibility</h3>
                <div style={styles.muted}>
                  Which diets it suits. Nothing analyzes it, so add what you
                  know.
                </div>
                <cf-tags
                  tags={dietaryTags}
                  oncf-change={setList({ list: dietaryTags })}
                />
                <div style={styles.quick}>
                  {unusedCommonTags.map((tag) => (
                    <cf-button
                      variant="ghost"
                      size="sm"
                      onClick={() => addDietaryTag.send({ tag })}
                    >
                      + {tag}
                    </cf-button>
                  ))}
                </div>
              </cf-vstack>
            </cf-card>

            <cf-card>
              <cf-vstack gap="2">
                <h3 style={styles.section}>Main Ingredients</h3>
                <div style={styles.muted}>
                  For "no-X" matching: chicken, mushrooms, cilantro...
                </div>
                <cf-tags
                  tags={primaryIngredients}
                  oncf-change={setList({ list: primaryIngredients })}
                />
              </cf-vstack>
            </cf-card>

            <cf-card>
              <cf-vstack gap="2">
                <h3 style={styles.section}>Prep</h3>
                <div style={styles.grid}>
                  <label>
                    <span style={styles.label}>Prep Time (min)</span>
                    <cf-input
                      type="number"
                      min="0"
                      value={prepText}
                      oncf-change={setNumber({ cell: prepTime, min: 0 })}
                    />
                  </label>
                  <label style={styles.check}>
                    <cf-checkbox $checked={requiresReheating} />
                    Requires reheating
                  </label>
                </div>
              </cf-vstack>
            </cf-card>
          </cf-vstack>
        </cf-screen>
      ),
      [FS]: {
        type: "text/markdown",
        frontmatter: { title: displayName },
        content: fsContent,
      },
      name,
      servings,
      category,
      dietaryTags,
      primaryIngredients,
      description,
      source,
      prepTime,
      requiresReheating,
      dietaryCompatibility,
      dietarySource,
      addDietaryTag,
    };
  },
);

export default PreparedFood;
