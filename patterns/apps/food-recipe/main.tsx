/**
 * Food Recipe — one recipe, with what a cook and a meal planner need from it.
 *
 * Ingredients; steps grouped into phases that happen at different times (the
 * night before, two hours out, at serving), each with a duration, how long its
 * result can wait, and what it needs from the oven; servings and scaling;
 * dietary analysis; and a cooking view with a checkbox per step.
 *
 * Paste a recipe into the notes or add photos of one, and "Extract Recipe
 * Data" has the model fill the fields. Nothing changes until you review the
 * changes it proposes (each field's old and new value, the notes as a word
 * diff, and the ingredients, step groups and tags it would add) and apply
 * them. "Suggest Timing" does the same for the step groups' timing.
 *
 * Ported from jkomoros/community-patterns (`food-recipe.tsx`). See
 * INDEX-ENTRY.md for the outputs a meal planner reads; `RecipeForMeal` in
 * `schemas.tsx` is the narrow contract.
 */
import {
  action,
  computed,
  Default,
  FS,
  generateObject,
  handler,
  type ImageData,
  NAME,
  navigateTo,
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
  type Difficulty,
  DIFFICULTY_ITEMS,
  type Ingredient,
  type OvenRequirements,
  type RecipeCategory,
  type RecipeForMeal,
  type StepGroup,
} from "./schemas.tsx";
import {
  applyTimingSuggestions,
  EXTRACTION_SYSTEM,
  extractionParts,
  extractionText,
  fromWire,
  type GroupNumberField,
  ingredientLine,
  inputText,
  moved,
  newIngredients,
  newStepGroups,
  newTags,
  notesChange,
  numberFromInput,
  type OvenField,
  ovenRequirements,
  type RecipeExtraction,
  type RecipeExtractionWire,
  recipeMarkdown,
  scalarChanges,
  scalarUpdates,
  scaleIngredients,
  scaleServings,
  TIMING_SYSTEM,
  timingPrompt,
  timingReview,
  type TimingSuggestions,
  updatedGroup,
  withGroupNumber,
  withOvenField,
  wordDiff,
} from "./recipe-logic.ts";
import RecipeAnalyzer from "./recipe-analyzer.tsx";
import Viewer, {
  progressAfterMove,
  progressAfterRemove,
  progressWithoutGroup,
} from "./viewer.tsx";

/**
 * Named rather than left to the default: the default generateObject model
 * rejects the schemas the runtime derives with HTTP 400 (top/3114). Haiku
 * 4.5 reads images, which extraction needs. Drop this once top/3114 is fixed.
 */
const STRUCTURED_MODEL = "anthropic:claude-haiku-4-5";

interface FoodRecipeInput {
  name?: PerSpace<Writable<string | Default<"">>>;
  cuisine?: PerSpace<Writable<string | Default<"">>>;
  servings?: PerSpace<Writable<number | Default<4>>>;
  /** What the recipe makes: "12 cookies", "1 loaf". */
  yield?: PerSpace<Writable<string | Default<"">>>;
  difficulty?: PerSpace<Writable<Difficulty | Default<"medium">>>;
  /** Minutes. */
  prepTime?: PerSpace<Writable<number | Default<0>>>;
  cookTime?: PerSpace<Writable<number | Default<0>>>;
  /** Minutes to rest after cooking, before serving. */
  restTime?: PerSpace<Writable<number | Default<0>>>;
  /** Minutes the finished dish can wait and stay good. */
  holdTime?: PerSpace<Writable<number | Default<0>>>;
  category?: PerSpace<Writable<RecipeCategory | Default<"other">>>;
  ingredients?: PerSpace<Writable<Ingredient[] | Default<[]>>>;
  stepGroups?: PerSpace<Writable<StepGroup[] | Default<[]>>>;
  tags?: PerSpace<Writable<string[] | Default<[]>>>;
  /** Free text: a pasted recipe to extract from, or the cook's own notes. */
  notes?: PerSpace<Writable<string | Default<"">>>;
  /** Where it came from: URL, book, person. */
  source?: PerSpace<Writable<string | Default<"">>>;
}

/** Food recipe with ingredients, timed step groups and dietary info. #recipe */
export interface FoodRecipeOutput {
  [NAME]: string;
  [UI]: VNode;
  [FS]: {
    type: "text/markdown";
    frontmatter: { title: string };
    content: string;
  };
  name: string;
  cuisine: string;
  servings: number;
  yield: string;
  difficulty: Difficulty;
  prepTime: number;
  cookTime: number;
  restTime: number;
  holdTime: number;
  category: RecipeCategory;
  ingredients: Ingredient[];
  stepGroups: StepGroup[];
  tags: string[];
  notes: string;
  source: string;
  /** prep + cook + rest, minutes. */
  totalTime: number;
  ovenRequirements: OvenRequirements;
  dietaryCompatibility: DietaryCompatibility;
  /** Whether `dietaryCompatibility` is a current analysis, a stale one, or
   * nothing yet ("none": empty lists mean unknown, not safe). */
  dietarySource: DietarySource;
  /** Run the dietary analysis on the recipe as it stands. */
  analyzeDiet: Stream<void>;
  /** The extraction under review, or null. */
  extraction: RecipeExtraction | null;
  /** The timing suggestions under review, or null. */
  timingSuggestions: TimingSuggestions | null;

  /** Ask the model to extract fields from the notes and photos. */
  extract: Stream<void>;
  applyExtraction: Stream<void>;
  cancelExtraction: Stream<void>;
  /** Ask the model to suggest timing for the step groups. */
  suggestTiming: Stream<void>;
  applyTiming: Stream<void>;
  cancelTiming: Stream<void>;
  /** Multiply servings and every ingredient amount. */
  scale: Stream<{ factor: number }>;
  addIngredient: Stream<void>;
  removeIngredient: Stream<{ index: number }>;
  addStepGroup: Stream<void>;
  removeStepGroup: Stream<{ id: string }>;
  moveStepGroup: Stream<{ id: string; delta: number }>;
  addStep: Stream<{ id: string }>;
  removeStep: Stream<{ id: string; step: number }>;
  moveStep: Stream<{ id: string; step: number; delta: number }>;
  /** Set a group's timing field from input text; blank clears it. */
  setGroupNumber: Stream<
    { id: string; field: GroupNumberField; value: string }
  >;
  /** Set a group's oven field from input text; temperature 0 clears it. */
  setOven: Stream<{ id: string; field: OvenField; value: string }>;
  /** Open the cooking view. */
  cook: Stream<void>;
}

/** The output must keep serving `RecipeForMeal`; this fails to compile if it
 * drifts. */
export const asRecipeForMeal = (recipe: FoodRecipeOutput): RecipeForMeal =>
  recipe;

type ChangeEvent = { detail?: { value?: string } };

/** Writes a number typed into a field; blank or invalid input is ignored. */
const setNumber = handler<
  ChangeEvent,
  { cell: Writable<number>; min: number }
>(({ detail }, { cell, min }) => {
  const n = numberFromInput(detail?.value ?? "");
  if (n !== undefined) cell.set(Math.max(min, Math.round(n)));
});

const setTags = handler<
  { detail?: { tags?: string[] } },
  { tags: Writable<string[]> }
>(({ detail }, { tags }) => {
  const next = (detail?.tags ?? []).map((t) => t.trim()).filter(Boolean);
  tags.set([...new Set(next)]);
});

const syncImages = handler<
  { detail?: { images?: ImageData[]; allImages?: ImageData[] } },
  { images: Writable<ImageData[]> }
>(({ detail }, { images }) => {
  images.set(detail?.allImages ?? detail?.images ?? []);
});

const styles = {
  page: "padding: 12px; max-width: 820px;",
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "12px",
    flexWrap: "wrap",
  },
  title: { margin: "0", fontSize: "20px" },
  muted: { fontSize: "13px", color: "#666" },
  section: { margin: "0", fontSize: "14px" },
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
  smallLabel: {
    display: "block",
    marginBottom: "2px",
    fontSize: "12px",
    color: "#666",
  },
  ingredientRow: {
    display: "grid",
    gridTemplateColumns: "2fr 1fr 1fr auto",
    gap: "8px",
    alignItems: "center",
  },
  group: { background: "var(--cf-theme-color-surface, #f9fafb)" },
  groupHeader: { display: "flex", alignItems: "center", gap: "8px" },
  timing: {
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: "8px",
    padding: "8px",
    background: "var(--cf-theme-color-surface, #fff)",
    border: "1px solid #e5e7eb",
    borderRadius: "4px",
  },
  oven: {
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: "8px",
    padding: "8px",
    background: "#fff8e1",
    border: "1px solid #fcd34d",
    borderRadius: "4px",
    color: "#78350f",
  },
  ovenTitle: {
    gridColumn: "1 / -1",
    fontSize: "12px",
    fontWeight: "600",
    color: "#92400e",
  },
  stepRow: { display: "flex", gap: "6px", alignItems: "center" },
  stepNumber: { fontWeight: "bold", color: "#666", minWidth: "22px" },
  change: {
    padding: "6px 10px",
    background: "var(--cf-theme-color-surface, #f9fafb)",
    border: "1px solid #e5e7eb",
    borderRadius: "4px",
    fontSize: "13px",
  },
  from: {
    color: "#dc2626",
    textDecoration: "line-through",
    marginRight: "6px",
  },
  to: { color: "#16a34a" },
  added: { color: "#16a34a", backgroundColor: "#ecfdf5" },
  removed: {
    color: "#dc2626",
    textDecoration: "line-through",
    backgroundColor: "#fef2f2",
  },
  addBox: {
    padding: "6px 10px",
    background: "#f0fdf4",
    border: "1px solid #86efac",
    borderRadius: "4px",
    fontSize: "13px",
    color: "#166534",
  },
  error: { fontSize: "13px", color: "#dc2626" },
} as const;

const FoodRecipe = pattern<FoodRecipeInput, FoodRecipeOutput>(
  ({
    name,
    cuisine,
    servings,
    yield: recipeYield,
    difficulty,
    prepTime,
    cookTime,
    restTime,
    holdTime,
    category,
    ingredients,
    stepGroups,
    tags,
    notes,
    source,
  }) => {
    const displayName = computed(() => name.get().trim() || "Untitled Recipe");
    const totalTime = computed(() =>
      prepTime.get() + cookTime.get() + restTime.get()
    );
    const totalLabel = computed(() => `${totalTime} min total`);
    const oven = computed(() => ovenRequirements(stepGroups.get()));
    const ingredientCount = computed(() => ingredients.get().length);
    const groupCount = computed(() => stepGroups.get().length);
    const servingsText = computed(() => String(servings.get()));
    const prepText = computed(() => String(prepTime.get()));
    const cookText = computed(() => String(cookTime.get()));
    const restText = computed(() => String(restTime.get()));
    const holdText = computed(() => String(holdTime.get()));

    const analyzer = RecipeAnalyzer({
      recipeName: name,
      ingredients,
      category,
      tags,
    });

    // --- Extraction ---------------------------------------------------------
    // Photos and the pending request belong to the person extracting, so they
    // are per session; what they produce is reviewed and then written to the
    // shared recipe.

    const images = new Writable.perSession<ImageData[]>([]);
    const imageCount = computed(() => images.get().length);
    const extractRequest = new Writable.perSession<
      { text: string; images: string[] } | null
    >(null);

    const extractLlm = generateObject<RecipeExtractionWire>({
      model: STRUCTURED_MODEL,
      system: EXTRACTION_SYSTEM,
      prompt: computed(() => {
        const request = extractRequest.get();
        return request ? extractionParts(request.text, request.images) : [];
      }),
    });
    const extraction = computed((): RecipeExtraction | null =>
      extractRequest.get() && extractLlm.result
        ? fromWire(extractLlm.result as Partial<RecipeExtractionWire>)
        : null
    );
    const extracting = computed(() => !!extractLlm.pending);
    const extractError = computed(() =>
      extractRequest.get() && extractLlm.error ? String(extractLlm.error) : ""
    );
    const canExtract = computed(() =>
      !extracting && (notes.get().trim() !== "" || imageCount > 0)
    );
    const extractLabel = computed(() =>
      extracting ? "Extracting..." : "Extract Recipe Data"
    );

    const scalarChangeList = computed(() =>
      scalarChanges({
        name: name.get(),
        cuisine: cuisine.get(),
        servings: servings.get(),
        yield: recipeYield.get(),
        difficulty: difficulty.get(),
        prepTime: prepTime.get(),
        cookTime: cookTime.get(),
        restTime: restTime.get(),
        holdTime: holdTime.get(),
        category: category.get(),
        source: source.get(),
        notes: notes.get(),
      }, extraction)
    );
    const notesReview = computed(() => notesChange(notes.get(), extraction));
    const notesDiff = computed(() =>
      notesReview.changes ? wordDiff(notes.get(), notesReview.to) : []
    );
    const notesCleared = computed(() =>
      notesReview.changes && notesReview.to.trim() === ""
    );
    const addedIngredients = computed(() =>
      newIngredients(ingredients.get(), extraction).map(ingredientLine)
    );
    const addedGroups = computed(() =>
      newStepGroups(extraction, "preview").map((g) => ({
        name: g.name,
        steps: g.steps.map((s) => s.description),
      }))
    );
    const addedTags = computed(() =>
      newTags(tags.get(), extraction).join(", ")
    );
    const extractionEmpty = computed(() =>
      scalarChangeList.length === 0 && !notesReview.changes &&
      addedIngredients.length === 0 && addedGroups.length === 0 &&
      addedTags === ""
    );

    const extract = action(() => {
      const shots = images.get().map((i) => i.data || i.url).filter(Boolean);
      if (!notes.get().trim() && shots.length === 0) return;
      // After a failure the same request would count as already made, so a
      // retry carries a marker the model can ignore.
      const retry = extractError ? `\n\n(retry ${Date.now()})` : "";
      extractRequest.set({
        text: extractionText(notes.get(), shots.length) + retry,
        images: shots,
      });
    });

    const cancelExtraction = action(() => extractRequest.set(null));

    const applyExtraction = action(() => {
      const data = extraction;
      if (!data) return;
      const u = scalarUpdates(data);
      if (u.name !== undefined) name.set(u.name);
      if (u.cuisine !== undefined) cuisine.set(u.cuisine);
      if (u.servings !== undefined) servings.set(u.servings);
      if (u.yield !== undefined) recipeYield.set(u.yield);
      if (u.difficulty !== undefined) difficulty.set(u.difficulty);
      if (u.prepTime !== undefined) prepTime.set(u.prepTime);
      if (u.cookTime !== undefined) cookTime.set(u.cookTime);
      if (u.restTime !== undefined) restTime.set(u.restTime);
      if (u.holdTime !== undefined) holdTime.set(u.holdTime);
      if (u.category !== undefined) category.set(u.category);
      if (u.source !== undefined) source.set(u.source);
      if (u.notes !== undefined) notes.set(u.notes);
      const prefix = `g${Date.now().toString(36)}${
        Math.random().toString(36).slice(2, 6)
      }`;
      ingredients.set([
        ...ingredients.get(),
        ...newIngredients(ingredients.get(), data),
      ]);
      stepGroups.set([...stepGroups.get(), ...newStepGroups(data, prefix)]);
      tags.set([...tags.get(), ...newTags(tags.get(), data)]);
      // The photos stay: cf-image-input keeps its own list, and clearing ours
      // would desync it from what is on screen.
      extractRequest.set(null);
    });

    // --- Timing suggestions -------------------------------------------------

    const timingRequest = new Writable.perSession<string>("");
    const timingLlm = generateObject<TimingSuggestions>({
      model: STRUCTURED_MODEL,
      system: TIMING_SYSTEM,
      prompt: timingRequest,
    });
    const timingSuggestions = computed((): TimingSuggestions | null =>
      timingRequest.get() && timingLlm.result ? timingLlm.result : null
    );
    const suggestingTiming = computed(() => !!timingLlm.pending);
    const timingError = computed(() =>
      timingRequest.get() && timingLlm.error ? String(timingLlm.error) : ""
    );
    const timingChanges = computed(() =>
      timingReview(stepGroups.get(), timingSuggestions)
    );
    const timingLabel = computed(() =>
      suggestingTiming ? "Suggesting..." : "Suggest Timing"
    );

    const suggestTiming = action(() => {
      const retry = timingError ? `\n\n(retry ${Date.now()})` : "";
      timingRequest.set(timingPrompt(name.get(), stepGroups.get()) + retry);
    });
    const cancelTiming = action(() => timingRequest.set(""));
    const applyTiming = action(() => {
      const suggestions = timingSuggestions;
      if (!suggestions) return;
      stepGroups.set(applyTimingSuggestions(stepGroups.get(), suggestions));
      timingRequest.set("");
    });

    // --- Editing ------------------------------------------------------------

    // The cooking view's checked steps, "groupId#index". They live here, so
    // progress survives going back to edit and cooking again, and the step
    // edits below keep them on the same steps.
    const cookProgress = new Writable.perSpace<string[]>([]);

    const scale = action(({ factor }: { factor: number }) => {
      if (!(factor > 0)) return;
      servings.set(scaleServings(servings.get(), factor));
      ingredients.set(scaleIngredients(ingredients.get(), factor));
    });

    const addIngredient = action(() => {
      ingredients.push({ item: "", amount: "", unit: "" });
    });
    const removeIngredient = action(({ index }: { index: number }) => {
      ingredients.set(ingredients.get().filter((_, i) => i !== index));
    });

    const addStepGroup = action(() => {
      stepGroups.push({
        id: `g${Date.now().toString(36)}${
          Math.random().toString(36).slice(2, 6)
        }`,
        name: "New Step Group",
        steps: [{ description: "" }],
      });
    });
    const removeStepGroup = action(({ id }: { id: string }) => {
      stepGroups.set(stepGroups.get().filter((g) => g.id !== id));
      cookProgress.set(progressWithoutGroup(cookProgress.get(), id));
    });
    const moveStepGroup = action(
      ({ id, delta }: { id: string; delta: number }) => {
        const list = stepGroups.get();
        stepGroups.set(moved(list, list.findIndex((g) => g.id === id), delta));
      },
    );
    const addStep = action(({ id }: { id: string }) => {
      stepGroups.set(updatedGroup(stepGroups.get(), id, (g) => ({
        ...g,
        steps: [...g.steps, { description: "" }],
      })));
    });
    const removeStep = action(({ id, step }: { id: string; step: number }) => {
      stepGroups.set(updatedGroup(stepGroups.get(), id, (g) => ({
        ...g,
        steps: g.steps.filter((_, i) => i !== step),
      })));
      cookProgress.set(progressAfterRemove(cookProgress.get(), id, step));
    });
    const moveStep = action(
      ({ id, step, delta }: { id: string; step: number; delta: number }) => {
        const count = stepGroups.get().find((g) => g.id === id)?.steps.length ??
          0;
        stepGroups.set(
          updatedGroup(
            stepGroups.get(),
            id,
            (g) => ({ ...g, steps: moved(g.steps, step, delta) }),
          ),
        );
        cookProgress.set(
          progressAfterMove(cookProgress.get(), id, step, delta, count),
        );
      },
    );
    const setGroupNumber = action(
      ({ id, field, value }: {
        id: string;
        field: GroupNumberField;
        value: string;
      }) => {
        stepGroups.set(
          updatedGroup(
            stepGroups.get(),
            id,
            (g) => withGroupNumber(g, field, numberFromInput(value)),
          ),
        );
      },
    );
    const setOven = action(
      (
        { id, field, value }: { id: string; field: OvenField; value: string },
      ) => {
        stepGroups.set(
          updatedGroup(
            stepGroups.get(),
            id,
            (g) => withOvenField(g, field, value),
          ),
        );
      },
    );

    // The cooking view is made when Cook is pressed, as navigateTo expects
    // (docs/common/patterns/navigation.md): a view made in the pattern body
    // and navigated to from an action did nothing live. Its checked steps
    // are `cookProgress`, above.
    const cook = action(() =>
      navigateTo(
        Viewer({
          recipeName: name,
          servings,
          ingredients,
          stepGroups,
          done: cookProgress,
        }),
      )
    );

    const fsContent = computed(() =>
      recipeMarkdown({
        name: name.get(),
        servings: servings.get(),
        category: category.get(),
        prepTime: prepTime.get(),
        cookTime: cookTime.get(),
        ingredients: ingredients.get(),
        stepGroups: stepGroups.get(),
        tags: tags.get(),
        notes: notes.get(),
        source: source.get(),
      })
    );

    // --- View ---------------------------------------------------------------

    // The modals open from derived state, which they must not write: with
    // dismissible={false} cf-modal never writes $open, and Cancel/Apply close
    // them by clearing the request. (cf-modal types offer no one-way `open`.)
    const extractionReview = (
      <cf-modal
        $open={computed(() => extraction !== null)}
        dismissible={false}
        size="lg"
      >
        <div slot="header">
          <h3 style={styles.section}>Review Extracted Changes</h3>
        </div>
        <cf-vstack gap="2">
          {extractionEmpty
            ? <div style={styles.muted}>Nothing new was found.</div>
            : null}
          {scalarChangeList.map((change) => (
            <div style={styles.change}>
              <strong>{change.field}</strong>
              <div>
                <span style={styles.from}>{change.from}</span>
                <span style={styles.to}>{change.to}</span>
              </div>
            </div>
          ))}
          {notesReview.changes
            ? (
              <div style={styles.change}>
                <strong>Notes</strong>
                {notesCleared
                  ? <div style={styles.from}>Notes will be cleared</div>
                  : (
                    <div style={{ whiteSpace: "pre-wrap" }}>
                      {notesDiff.map((part) => (
                        <span
                          style={part.type === "added"
                            ? styles.added
                            : part.type === "removed"
                            ? styles.removed
                            : {}}
                        >
                          {part.word}
                        </span>
                      ))}
                    </div>
                  )}
              </div>
            )
            : null}
          {addedIngredients.length > 0
            ? (
              <div style={styles.addBox}>
                <strong>
                  + {computed(() => addedIngredients.length)} ingredient(s)
                </strong>
                <ul style={{ margin: "4px 0 0 0", paddingLeft: "20px" }}>
                  {addedIngredients.map((line) => <li>{line}</li>)}
                </ul>
              </div>
            )
            : null}
          {addedGroups.length > 0
            ? (
              <div style={styles.addBox}>
                <strong>
                  + {computed(() => addedGroups.length)} step group(s)
                </strong>
                {addedGroups.map((group) => (
                  <div style={{ marginTop: "4px" }}>
                    <div style={{ fontWeight: "600" }}>{group.name}</div>
                    <ol style={{ margin: "0", paddingLeft: "20px" }}>
                      {group.steps.map((step) => <li>{step}</li>)}
                    </ol>
                  </div>
                ))}
              </div>
            )
            : null}
          {addedTags
            ? <div style={styles.addBox}>+ Tags: {addedTags}</div>
            : null}
        </cf-vstack>
        <div slot="footer">
          <cf-hstack gap="2" justify="end">
            <cf-button variant="secondary" onClick={cancelExtraction}>
              Cancel
            </cf-button>
            <cf-button variant="primary" onClick={applyExtraction}>
              Apply
            </cf-button>
          </cf-hstack>
        </div>
      </cf-modal>
    );

    const timingModal = (
      <cf-modal
        $open={computed(() => timingSuggestions !== null)}
        dismissible={false}
        size="lg"
      >
        <div slot="header">
          <h3 style={styles.section}>Review Timing Suggestions</h3>
        </div>
        <cf-vstack gap="2">
          {timingChanges.length === 0
            ? <div style={styles.muted}>No timing changes suggested.</div>
            : null}
          {timingChanges.map((group) => (
            <div style={styles.change}>
              <strong>{group.name}</strong>
              {group.changes.map((change) => (
                <div>
                  <span style={{ color: "#666" }}>{change.field}:</span>{" "}
                  <span style={styles.from}>{change.from}</span>
                  <span style={styles.to}>{change.to}</span>
                </div>
              ))}
            </div>
          ))}
        </cf-vstack>
        <div slot="footer">
          <cf-hstack gap="2" justify="end">
            <cf-button variant="secondary" onClick={cancelTiming}>
              Cancel
            </cf-button>
            <cf-button variant="primary" onClick={applyTiming}>
              Apply
            </cf-button>
          </cf-hstack>
        </div>
      </cf-modal>
    );

    return {
      [NAME]: computed(() => `🍳 ${displayName}`),
      [UI]: (
        <cf-screen>
          <cf-vstack gap="2" style={styles.page}>
            <div style={styles.header}>
              <h1 style={styles.title}>{displayName}</h1>
              <cf-hstack gap="2" align="center">
                <span style={styles.muted}>{totalLabel}</span>
                <cf-button variant="secondary" onClick={cook}>
                  👨‍🍳 Cook
                </cf-button>
              </cf-hstack>
            </div>

            {/* Recipe input: notes and photos to extract from */}
            <cf-card>
              <cf-vstack gap="2">
                <div style={styles.sectionHeader}>
                  <h3 style={styles.section}>Recipe Notes</h3>
                  <cf-button
                    disabled={computed(() => !canExtract)}
                    onClick={extract}
                  >
                    {extractLabel}
                  </cf-button>
                </div>
                <cf-textarea
                  $value={notes}
                  rows={6}
                  autoResize
                  placeholder="Paste a recipe or jot notes, add photos, then Extract Recipe Data to fill in the fields."
                />
                <cf-image-input
                  multiple
                  maxImages={4}
                  includeData
                  showPreview
                  previewSize="sm"
                  removable
                  maxSizeBytes={3932160}
                  oncf-change={syncImages({ images })}
                  oncf-remove={syncImages({ images })}
                >
                  📷 Add Photo
                </cf-image-input>
                {extractError
                  ? <div style={styles.error}>Error: {extractError}</div>
                  : null}
              </cf-vstack>
            </cf-card>

            {/* Basic info */}
            <cf-card>
              <cf-vstack gap="2">
                <h3 style={styles.section}>Basic Info</h3>
                <div style={styles.grid}>
                  <label>
                    <span style={styles.label}>Recipe Name</span>
                    <cf-input
                      $value={name}
                      placeholder="e.g., Chocolate Chip Cookies"
                    />
                  </label>
                  <label>
                    <span style={styles.label}>Cuisine</span>
                    <cf-input $value={cuisine} placeholder="e.g., Italian" />
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
                    <span style={styles.label}>Yield</span>
                    <cf-input
                      $value={recipeYield}
                      placeholder="e.g., 12 cookies"
                    />
                  </label>
                  <label>
                    <span style={styles.label}>Category</span>
                    <cf-select $value={category} items={CATEGORY_ITEMS} />
                  </label>
                  <label>
                    <span style={styles.label}>Difficulty</span>
                    <cf-select $value={difficulty} items={DIFFICULTY_ITEMS} />
                  </label>
                  <label>
                    <span style={styles.label}>Prep Time (min)</span>
                    <cf-input
                      type="number"
                      min="0"
                      value={prepText}
                      oncf-change={setNumber({ cell: prepTime, min: 0 })}
                    />
                  </label>
                  <label>
                    <span style={styles.label}>Cook Time (min)</span>
                    <cf-input
                      type="number"
                      min="0"
                      value={cookText}
                      oncf-change={setNumber({ cell: cookTime, min: 0 })}
                    />
                  </label>
                  <label>
                    <span style={styles.label}>Rest Time (min)</span>
                    <cf-input
                      type="number"
                      min="0"
                      value={restText}
                      oncf-change={setNumber({ cell: restTime, min: 0 })}
                    />
                  </label>
                  <label>
                    <span style={styles.label}>Hold Time (min)</span>
                    <cf-input
                      type="number"
                      min="0"
                      value={holdText}
                      oncf-change={setNumber({ cell: holdTime, min: 0 })}
                    />
                  </label>
                </div>
                <label>
                  <span style={styles.label}>Source</span>
                  <cf-input
                    $value={source}
                    placeholder="Where did this recipe come from? (URL, book, person)"
                  />
                </label>
                <div>
                  <span style={styles.label}>Tags</span>
                  <cf-tags tags={tags} oncf-change={setTags({ tags })} />
                </div>
              </cf-vstack>
            </cf-card>

            {/* Ingredients */}
            <cf-card>
              <cf-vstack gap="2">
                <div style={styles.sectionHeader}>
                  <h3 style={styles.section}>
                    Ingredients ({ingredientCount})
                  </h3>
                  <cf-hstack gap="1">
                    <cf-button
                      variant="secondary"
                      onClick={() => scale.send({ factor: 0.5 })}
                    >
                      ÷2
                    </cf-button>
                    <cf-button
                      variant="secondary"
                      onClick={() => scale.send({ factor: 1.5 })}
                    >
                      ×1.5
                    </cf-button>
                    <cf-button
                      variant="secondary"
                      onClick={() => scale.send({ factor: 2 })}
                    >
                      ×2
                    </cf-button>
                    <cf-button onClick={addIngredient}>
                      + Add Ingredient
                    </cf-button>
                  </cf-hstack>
                </div>
                {ingredients.map((ingredient, index) => (
                  <div style={styles.ingredientRow}>
                    <cf-input
                      $value={ingredient.item}
                      placeholder="Ingredient"
                    />
                    <cf-input $value={ingredient.amount} placeholder="Amount" />
                    <cf-input $value={ingredient.unit} placeholder="Unit" />
                    <cf-button
                      variant="ghost"
                      aria-label="Remove ingredient"
                      onClick={() =>
                        removeIngredient.send({ index })}
                    >
                      ×
                    </cf-button>
                  </div>
                ))}
              </cf-vstack>
            </cf-card>

            <cf-card>{analyzer[UI]}</cf-card>

            {/* Step groups */}
            <cf-card>
              <cf-vstack gap="2">
                <div style={styles.sectionHeader}>
                  <h3 style={styles.section}>Step Groups ({groupCount})</h3>
                  <cf-hstack gap="1">
                    <cf-button
                      variant="secondary"
                      disabled={computed(() =>
                        groupCount === 0 || suggestingTiming
                      )}
                      onClick={suggestTiming}
                    >
                      {timingLabel}
                    </cf-button>
                    <cf-button onClick={addStepGroup}>+ Add Group</cf-button>
                  </cf-hstack>
                </div>
                {timingError
                  ? <div style={styles.error}>Error: {timingError}</div>
                  : null}
                {stepGroups.map((group) => (
                  <cf-card style={styles.group}>
                    <cf-vstack gap="2">
                      <div style={styles.groupHeader}>
                        <cf-button
                          variant="ghost"
                          aria-label="Move group up"
                          onClick={() =>
                            moveStepGroup.send({ id: group.id, delta: -1 })}
                        >
                          ↑
                        </cf-button>
                        <cf-button
                          variant="ghost"
                          aria-label="Move group down"
                          onClick={() =>
                            moveStepGroup.send({ id: group.id, delta: 1 })}
                        >
                          ↓
                        </cf-button>
                        <cf-input
                          $value={group.name}
                          placeholder="Group name (e.g., Prep, Roast)"
                          style="flex: 1;"
                        />
                        <cf-button
                          variant="ghost"
                          onClick={() => removeStepGroup.send({ id: group.id })}
                        >
                          Remove Group
                        </cf-button>
                      </div>

                      <div style={styles.timing}>
                        <label>
                          <span style={styles.smallLabel}>Nights before</span>
                          <cf-input
                            type="number"
                            min="0"
                            placeholder="—"
                            value={computed(() =>
                              inputText(group.nightsBeforeServing)
                            )}
                            oncf-change={(e: ChangeEvent) =>
                              setGroupNumber.send({
                                id: group.id,
                                field: "nightsBeforeServing",
                                value: e?.detail?.value ?? "",
                              })}
                          />
                        </label>
                        <label>
                          <span style={styles.smallLabel}>
                            or min before serving
                          </span>
                          <cf-input
                            type="number"
                            min="0"
                            placeholder="—"
                            value={computed(() =>
                              inputText(group.minutesBeforeServing)
                            )}
                            oncf-change={(e: ChangeEvent) =>
                              setGroupNumber.send({
                                id: group.id,
                                field: "minutesBeforeServing",
                                value: e?.detail?.value ?? "",
                              })}
                          />
                        </label>
                        <label>
                          <span style={styles.smallLabel}>Takes (min)</span>
                          <cf-input
                            type="number"
                            min="0"
                            placeholder="—"
                            value={computed(() => inputText(group.duration))}
                            oncf-change={(e: ChangeEvent) =>
                              setGroupNumber.send({
                                id: group.id,
                                field: "duration",
                                value: e?.detail?.value ?? "",
                              })}
                          />
                        </label>
                        <label>
                          <span style={styles.smallLabel}>Can wait (min)</span>
                          <cf-input
                            type="number"
                            min="0"
                            placeholder="—"
                            value={computed(() =>
                              inputText(group.maxWaitMinutes)
                            )}
                            oncf-change={(e: ChangeEvent) =>
                              setGroupNumber.send({
                                id: group.id,
                                field: "maxWaitMinutes",
                                value: e?.detail?.value ?? "",
                              })}
                          />
                        </label>
                      </div>

                      <div style={styles.oven}>
                        <div style={styles.ovenTitle}>
                          🔥 Oven (set a temperature to use it)
                        </div>
                        <label>
                          <span style={styles.smallLabel}>Temp (°F)</span>
                          <cf-input
                            type="number"
                            min="0"
                            placeholder="350"
                            value={computed(() =>
                              inputText(group.oven?.temperature)
                            )}
                            oncf-change={(e: ChangeEvent) =>
                              setOven.send({
                                id: group.id,
                                field: "temperature",
                                value: e?.detail?.value ?? "",
                              })}
                          />
                        </label>
                        <label>
                          <span style={styles.smallLabel}>In oven (min)</span>
                          <cf-input
                            type="number"
                            min="0"
                            placeholder="30"
                            disabled={computed(() => !group.oven)}
                            value={computed(() =>
                              inputText(group.oven?.duration)
                            )}
                            oncf-change={(e: ChangeEvent) =>
                              setOven.send({
                                id: group.id,
                                field: "duration",
                                value: e?.detail?.value ?? "",
                              })}
                          />
                        </label>
                        <label>
                          <span style={styles.smallLabel}>Rack height</span>
                          <cf-input
                            type="number"
                            min="1"
                            placeholder="1-5"
                            disabled={computed(() => !group.oven)}
                            value={computed(() =>
                              inputText(group.oven?.heightSlots)
                            )}
                            oncf-change={(e: ChangeEvent) =>
                              setOven.send({
                                id: group.id,
                                field: "heightSlots",
                                value: e?.detail?.value ?? "",
                              })}
                          />
                        </label>
                        <label>
                          <span style={styles.smallLabel}>Rack width</span>
                          <cf-button
                            variant="secondary"
                            disabled={computed(() => !group.oven)}
                            onClick={() =>
                              setOven.send({
                                id: group.id,
                                field: "width",
                                value: "toggle",
                              })}
                          >
                            {computed(() =>
                              group.oven?.width === "half" ? "Half" : "Full"
                            )}
                          </cf-button>
                        </label>
                      </div>

                      {group.steps.map((step, stepIndex) => (
                        <div style={styles.stepRow}>
                          <span style={styles.stepNumber}>
                            {computed(() =>
                              `${stepIndex + 1}.`
                            )}
                          </span>
                          <cf-input
                            $value={step.description}
                            placeholder="Step..."
                            style="flex: 1;"
                          />
                          <cf-button
                            variant="ghost"
                            aria-label="Move step up"
                            onClick={() =>
                              moveStep.send({
                                id: group.id,
                                step: stepIndex,
                                delta: -1,
                              })}
                          >
                            ↑
                          </cf-button>
                          <cf-button
                            variant="ghost"
                            aria-label="Move step down"
                            onClick={() =>
                              moveStep.send({
                                id: group.id,
                                step: stepIndex,
                                delta: 1,
                              })}
                          >
                            ↓
                          </cf-button>
                          <cf-button
                            variant="ghost"
                            aria-label="Remove step"
                            onClick={() =>
                              removeStep.send({
                                id: group.id,
                                step: stepIndex,
                              })}
                          >
                            ×
                          </cf-button>
                        </div>
                      ))}
                      <cf-button
                        variant="secondary"
                        onClick={() => addStep.send({ id: group.id })}
                      >
                        + Add Step
                      </cf-button>
                    </cf-vstack>
                  </cf-card>
                ))}
              </cf-vstack>
            </cf-card>

            {extractionReview}
            {timingModal}
          </cf-vstack>
        </cf-screen>
      ),
      [FS]: {
        type: "text/markdown",
        frontmatter: { title: displayName },
        content: fsContent,
      },
      name,
      cuisine,
      servings,
      yield: recipeYield,
      difficulty,
      prepTime,
      cookTime,
      restTime,
      holdTime,
      category,
      ingredients,
      stepGroups,
      tags,
      notes,
      source,
      totalTime,
      ovenRequirements: oven,
      dietaryCompatibility: analyzer.dietaryCompatibility,
      dietarySource: analyzer.dietarySource,
      analyzeDiet: analyzer.analyze,
      extraction,
      timingSuggestions,
      extract,
      applyExtraction,
      cancelExtraction,
      suggestTiming,
      applyTiming,
      cancelTiming,
      scale,
      addIngredient,
      removeIngredient,
      addStepGroup,
      removeStepGroup,
      moveStepGroup,
      addStep,
      removeStep,
      moveStep,
      setGroupNumber,
      setOven,
      cook,
    };
  },
);

export default FoodRecipe;
