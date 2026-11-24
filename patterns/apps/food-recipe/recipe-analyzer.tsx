/**
 * Recipe Analyzer — which diets a recipe suits, read from its ingredients.
 *
 * The model checks the ingredients against allergy, lifestyle and health tags
 * (nut-free, vegan, gluten-free, low-sodium, ...), writes readable warnings, and
 * names the handful of primary ingredients a planner matches "no-X" requests
 * against. `food-recipe.tsx` embeds it; a planner reads `dietaryCompatibility`.
 *
 * Ported from jkomoros/community-patterns (`recipe-analyzer.tsx`). The original
 * re-ran the model on every ingredient edit, keystroke by keystroke. Here the
 * analysis runs when asked (`analyze`), is stored with the recipe it was asked
 * for, and is flagged as out of date once the recipe changes. While a new
 * analysis runs, and if it fails, there is no result: `dietarySource` says
 * which case a reader is looking at.
 */
import {
  action,
  computed,
  Default,
  generateObject,
  hasError,
  isObsolete,
  isPending,
  isSyncing,
  pattern,
  resultOf,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import {
  type DietaryCompatibility,
  type DietarySource,
  EMPTY_DIETARY,
  type Ingredient,
} from "./schemas.tsx";

/**
 * Named rather than left to the default: the default generateObject model
 * rejects the schemas the runtime derives with HTTP 400 (top/3114). Drop
 * this once top/3114 is fixed.
 */
const STRUCTURED_MODEL = "anthropic:claude-haiku-4-5";

export const DIETARY_SYSTEM = `You analyze recipes for dietary compatibility.

Check every one of these tags and list each as compatible or incompatible:
Allergies: nut-free, peanut-free, tree-nut-free, shellfish-free, fish-free,
  dairy-free, lactose-free, egg-free, soy-free, gluten-free, nightshade-free
Lifestyle: vegan, vegetarian, pescatarian, kosher, halal, pork-free, beef-free,
  lamb-free
Health: diabetic-friendly, low-sugar, low-sodium, heart-healthy,
  kidney-friendly, low-FODMAP, keto, low-carb

Rules:
- vegan is stricter than vegetarian: no animal products at all
- gluten-free means no wheat, barley, rye or their derivatives (soy sauce too)
- nut-free covers tree nuts and peanuts
- nightshade-free means no tomatoes, peppers, potatoes or eggplant
- kosher and halal depend on preparation; be conservative
- check derivatives (butter is dairy); when unsure, mark incompatible and warn

warnings: short readable caveats, e.g. "Contains dairy (butter) - not vegan".
primaryIngredients: the 5-10 ingredients that define the dish (proteins, main
vegetables and starches, key flavors), used to match requests like
"no mushrooms".`;

const RETRY = /\n\n\(retry \d+\)$/;

/** The recipe prompt a request was made for, without any retry marker. */
export const requestedRecipe = (request: string): string =>
  request.replace(RETRY, "");

/** The analysis prompt for a recipe, or "" when it has no ingredients. */
export const dietaryPrompt = (
  recipeName: string,
  category: string,
  tags: readonly string[],
  ingredients: readonly Ingredient[],
): string => {
  const lines = ingredients
    .filter((i) => i.item.trim())
    .map((i) =>
      `- ${
        [i.amount, i.unit, i.item].map((s) => s.trim()).filter(Boolean).join(
          " ",
        )
      }`
    );
  if (lines.length === 0) return "";
  return [
    "Analyze this recipe for dietary compatibility:",
    "",
    `Recipe: ${recipeName.trim() || "Untitled"}`,
    `Category: ${category || "other"}`,
    `Tags: ${tags.join(", ") || "none"}`,
    "",
    "Ingredients:",
    ...lines,
  ].join("\n");
};

interface RecipeAnalyzerInput {
  recipeName?: string | Default<"">;
  ingredients?: Ingredient[] | Default<[]>;
  category?: string | Default<"other">;
  tags?: string[] | Default<[]>;
}

export interface RecipeAnalyzerOutput {
  [UI]: VNode;
  /** The last analysis, or empty lists before the first. */
  dietaryCompatibility: DietaryCompatibility;
  /** A result is on hand. */
  analyzed: boolean;
  /** The recipe changed since it was analyzed. */
  stale: boolean;
  /** "analyzed", "stale", or "none" when there is no result. */
  dietarySource: DietarySource;
  pending: boolean;
  /** The model's error for the last request, or "". */
  error: string;
  /** Analyze the recipe as it stands now. */
  analyze: Stream<void>;
}

const styles = {
  heading: { margin: "0 0 8px 0", fontSize: "14px" },
  muted: { fontStyle: "italic", color: "#666", fontSize: "13px" },
  label: { fontWeight: "600", marginBottom: "4px", fontSize: "13px" },
  chips: { display: "flex", flexWrap: "wrap", gap: "4px" },
  good: {
    padding: "2px 8px",
    background: "var(--cf-theme-color-success-light, #d1fae5)",
    borderRadius: "12px",
    fontSize: "12px",
    color: "var(--cf-theme-color-success, #065f46)",
  },
  bad: {
    padding: "2px 8px",
    background: "var(--cf-theme-color-error-light, #fee2e2)",
    borderRadius: "12px",
    fontSize: "12px",
    color: "var(--cf-theme-color-error, #991b1b)",
  },
  warnings: { margin: "0", paddingLeft: "20px", fontSize: "13px" },
  stale: {
    fontSize: "12px",
    color: "#92400e",
    background: "#fef3c7",
    padding: "4px 8px",
    borderRadius: "4px",
  },
} as const;

const RecipeAnalyzer = pattern<RecipeAnalyzerInput, RecipeAnalyzerOutput>(
  ({ recipeName, ingredients, category, tags }) => {
    // The prompt last analyzed. Shared with everyone in the space, so one
    // person's analysis serves all.
    const requested = new Writable<string>("");

    const currentPrompt = computed(() =>
      dietaryPrompt(recipeName, category, tags, ingredients)
    );

    const llm = generateObject<DietaryCompatibility>({
      model: STRUCTURED_MODEL,
      system: DIETARY_SYSTEM,
      prompt: requested,
    });

    const analysis = computed(
      (): {
        dietary: DietaryCompatibility | null;
        pending: boolean;
        error: string;
      } => {
        if (!requested.get()) {
          return { dietary: null, pending: false, error: "" };
        }
        if (isPending(llm) || isSyncing(llm)) {
          return {
            dietary: null,
            pending: true,
            error: "",
          };
        }
        if (hasError(llm) || isObsolete(llm)) {
          return {
            dietary: null,
            pending: false,
            error: llm.message || "The dietary analysis output was retired.",
          };
        }
        return { dietary: resultOf(llm), pending: false, error: "" };
      },
    );
    const dietaryCompatibility = computed(() =>
      analysis.dietary ?? EMPTY_DIETARY
    );
    const analyzed = computed(() => analysis.dietary !== null);
    const pending = analysis.pending;
    const error = analysis.error;
    const stale = computed(() =>
      requested.get() !== "" &&
      requestedRecipe(requested.get()) !== currentPrompt
    );
    const dietarySource = computed((): DietarySource =>
      !analyzed ? "none" : stale ? "stale" : "analyzed"
    );
    // Asking again for the same recipe after a failure needs a different
    // request, or the builtin treats it as the one already made; a retry
    // marker the model can ignore makes it one.
    const analyze = action(() => {
      if (currentPrompt === "") return;
      requested.set(
        error && requestedRecipe(requested.get()) === currentPrompt
          ? `${currentPrompt}\n\n(retry ${Date.now()})`
          : currentPrompt,
      );
    });
    const canAnalyze = computed(() =>
      currentPrompt !== "" && !pending &&
      (!!error || requestedRecipe(requested.get()) !== currentPrompt)
    );
    const buttonLabel = computed(() =>
      pending ? "Analyzing..." : analyzed ? "Re-analyze" : "Analyze"
    );
    const compatible = computed(() => dietaryCompatibility.compatible);
    const incompatible = computed(() => dietaryCompatibility.incompatible);
    const warnings = computed(() => dietaryCompatibility.warnings);
    const primary = computed(() =>
      dietaryCompatibility.primaryIngredients.join(", ")
    );
    const hint = computed(() =>
      currentPrompt === ""
        ? "Add ingredients to analyze dietary fit."
        : "Not analyzed yet."
    );

    return {
      [UI]: (
        <cf-vstack gap="1">
          <cf-hstack justify="between" align="center">
            <h3 style={styles.heading}>Dietary Analysis</h3>
            <cf-button
              variant="secondary"
              disabled={computed(() => !canAnalyze)}
              onClick={analyze}
            >
              {buttonLabel}
            </cf-button>
          </cf-hstack>
          {stale
            ? (
              <div style={styles.stale}>
                The recipe changed since this analysis.
              </div>
            )
            : null}
          {error ? <div style={styles.muted}>Error: {error}</div> : null}
          {analyzed
            ? (
              <cf-vstack gap="1">
                <div style={styles.label}>✓ Compatible</div>
                <div style={styles.chips}>
                  {compatible.map((tag) => (
                    <span style={styles.good}>{tag}</span>
                  ))}
                </div>
                <div style={styles.label}>✗ Not compatible</div>
                <div style={styles.chips}>
                  {incompatible.map((tag) => (
                    <span style={styles.bad}>{tag}</span>
                  ))}
                </div>
                <div style={styles.label}>⚠️ Warnings</div>
                <ul style={styles.warnings}>
                  {warnings.map((w) => <li>{w}</li>)}
                </ul>
                <div style={styles.label}>Main ingredients</div>
                <div style={{ fontSize: "13px", color: "#666" }}>
                  {primary}
                </div>
              </cf-vstack>
            )
            : <div style={styles.muted}>{hint}</div>}
        </cf-vstack>
      ),
      dietaryCompatibility,
      analyzed,
      stale,
      dietarySource,
      pending,
      error,
      analyze,
    };
  },
);

export default RecipeAnalyzer;
