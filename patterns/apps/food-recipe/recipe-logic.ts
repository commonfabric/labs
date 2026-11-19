/**
 * Pure recipe logic, kept out of the pattern so the actions, the derived views
 * and the tests all run the same code: scaling amounts, oven needs, the
 * extraction and timing prompts and how their answers apply, the review diff,
 * and the markdown projection.
 */
import type {
  Difficulty,
  Ingredient,
  OvenNeed,
  OvenRequirements,
  RecipeCategory,
  StepGroup,
} from "./schemas.tsx";
import { DIFFICULTIES, RECIPE_CATEGORIES } from "./schemas.tsx";

// ---------------------------------------------------------------------------
// Scaling
// ---------------------------------------------------------------------------

const FRACTIONS: ReadonlyArray<[number, string]> = [
  [1 / 8, "1/8"],
  [1 / 4, "1/4"],
  [1 / 3, "1/3"],
  [3 / 8, "3/8"],
  [1 / 2, "1/2"],
  [5 / 8, "5/8"],
  [2 / 3, "2/3"],
  [3 / 4, "3/4"],
  [7 / 8, "7/8"],
];

/** The number a quantity token spells: "2", "1.5", "1/2", "1 1/2". */
const parseQuantity = (text: string): number | undefined => {
  const mixed = text.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) {
    const denominator = Number(mixed[3]);
    return denominator
      ? Number(mixed[1]) + Number(mixed[2]) / denominator
      : undefined;
  }
  const fraction = text.match(/^(\d+)\/(\d+)$/);
  if (fraction) {
    const denominator = Number(fraction[2]);
    return denominator ? Number(fraction[1]) / denominator : undefined;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
};

/** A quantity in kitchen notation: whole part plus the nearest common
 * fraction, or two decimals when no fraction is close. */
export const formatQuantity = (value: number): string => {
  const whole = Math.floor(value + 1e-9);
  const rest = value - whole;
  if (rest < 0.02) return String(whole);
  if (rest > 0.98) return String(whole + 1);
  const near = FRACTIONS.find(([f]) => Math.abs(f - rest) < 0.02);
  if (!near) return String(Math.round(value * 100) / 100);
  return whole ? `${whole} ${near[1]}` : near[1];
};

const QUANTITY = /^(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?)/;

/**
 * `amount` scaled by `factor`. The leading quantity is scaled and the rest of
 * the text kept, so "1 1/2" doubles to "3" and "2-3 large" to "4-6 large". Text
 * with no leading number ("to taste", "a handful") is left as it is.
 */
export const scaleAmount = (amount: string, factor: number): string => {
  const trimmed = amount.trim();
  const range = trimmed.match(/^([\d./ ]+?)\s*-\s*([\d./ ]+?)(\s.*)?$/);
  if (range) {
    const low = parseQuantity(range[1].trim());
    const high = parseQuantity(range[2].trim());
    if (low !== undefined && high !== undefined) {
      return `${formatQuantity(low * factor)}-${formatQuantity(high * factor)}${
        range[3] ?? ""
      }`;
    }
  }
  const match = trimmed.match(QUANTITY);
  if (!match) return amount;
  const value = parseQuantity(match[1]);
  if (value === undefined) return amount;
  return formatQuantity(value * factor) + trimmed.slice(match[0].length);
};

export const scaleIngredients = (
  ingredients: readonly Ingredient[],
  factor: number,
): Ingredient[] =>
  ingredients.map((ing) => ({
    ...ing,
    amount: scaleAmount(ing.amount, factor),
  }));

export const scaleServings = (servings: number, factor: number): number =>
  Math.max(1, Math.round(servings * factor));

// ---------------------------------------------------------------------------
// Step groups
// ---------------------------------------------------------------------------

export type GroupNumberField =
  | "nightsBeforeServing"
  | "minutesBeforeServing"
  | "duration"
  | "maxWaitMinutes";

export type OvenField = "temperature" | "duration" | "heightSlots" | "width";

/** A number typed into a field, or undefined when the field is blank. */
export const numberFromInput = (value: string): number | undefined => {
  const trimmed = String(value ?? "").trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

/** Shows an optional number in an input: blank when unset. */
export const inputText = (value: number | undefined): string =>
  value === undefined || value === null ? "" : String(value);

const withField = <T extends object>(
  object: T,
  field: keyof T,
  value: unknown,
): T => {
  const next = { ...object } as Record<string, unknown>;
  if (value === undefined) delete next[field as string];
  else next[field as string] = value;
  return next as T;
};

/**
 * `group` with one timing field set. Nights and minutes before serving are
 * alternatives, so setting one clears the other.
 */
export const withGroupNumber = (
  group: StepGroup,
  field: GroupNumberField,
  value: number | undefined,
): StepGroup => {
  const next = withField(group, field, value);
  if (value === undefined) return next;
  if (field === "nightsBeforeServing" && value > 0) {
    return withField(next, "minutesBeforeServing", undefined);
  }
  if (field === "minutesBeforeServing") {
    return withField(next, "nightsBeforeServing", undefined);
  }
  return next;
};

const DEFAULT_OVEN: OvenNeed = {
  temperature: 0,
  duration: 0,
  heightSlots: 1,
  width: "full",
};

/**
 * `group` with one oven field set. The temperature makes the oven need: set
 * above 0 it creates one (other fields from defaults), cleared to blank or 0
 * it removes it. Other fields edit an existing need only; on a group without
 * one they change nothing, and the editor disables them until a temperature
 * is set.
 */
export const withOvenField = (
  group: StepGroup,
  field: OvenField,
  value: string,
): StepGroup => {
  const oven: OvenNeed = { ...DEFAULT_OVEN, ...(group.oven ?? {}) };
  if (field === "width") {
    oven.width = value === "toggle"
      ? (oven.width === "half" ? "full" : "half")
      : value === "half"
      ? "half"
      : "full";
  } else {
    const n = numberFromInput(value) ?? 0;
    oven[field] = field === "heightSlots" ? Math.max(1, n) : n;
  }
  return oven.temperature > 0
    ? { ...group, oven }
    : withField(group, "oven", undefined);
};

/** `list` with the item at `index` moved by `delta`, or unchanged at an end. */
export const moved = <T>(list: readonly T[], index: number, delta: number) => {
  const target = index + delta;
  if (index < 0 || index >= list.length) return [...list];
  if (target < 0 || target >= list.length) return [...list];
  const next = [...list];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
};

export const ovenRequirements = (
  groups: readonly StepGroup[],
): OvenRequirements => {
  const temps = [
    ...new Set(
      groups
        .map((g) => g.oven?.temperature ?? 0)
        .filter((t) => t > 0),
    ),
  ].sort((a, b) => a - b);
  return {
    needsOven: temps.length > 0,
    temps,
    tempChanges: temps.length > 1,
  };
};

/** When a group happens, in words. */
export const formatTiming = (group: StepGroup): string => {
  const nights = group.nightsBeforeServing ?? 0;
  if (nights > 0) {
    return nights === 1
      ? "The night before"
      : `${nights} nights before serving`;
  }
  const minutes = group.minutesBeforeServing;
  if (minutes === undefined || minutes === null) return "Unscheduled";
  if (minutes === 0) return "At serving time";
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours > 0 && mins > 0) return `${hours}h ${mins}m before serving`;
  if (hours > 0) return `${hours}h before serving`;
  return `${mins}m before serving`;
};

// ---------------------------------------------------------------------------
// Extraction: notes and photos into recipe fields
// ---------------------------------------------------------------------------

export interface ExtractedStepGroup {
  name: string;
  nightsBeforeServing?: number;
  minutesBeforeServing?: number;
  duration?: number;
  maxWaitMinutes?: number;
  oven?: OvenNeed;
  steps: string[];
}

/** What the model reads out of the notes and photos. */
export interface RecipeExtraction {
  name?: string;
  cuisine?: string;
  servings?: number;
  yield?: string;
  difficulty?: Difficulty;
  prepTime?: number;
  cookTime?: number;
  restTime?: number;
  holdTime?: number;
  category?: RecipeCategory;
  source?: string;
  ingredients?: Ingredient[];
  stepGroups?: ExtractedStepGroup[];
  tags?: string[];
  /** The notes with everything extracted taken out. */
  remainingNotes?: string;
}

/**
 * What the model is asked to fill: `RecipeExtraction` with every field
 * required. A structured-output schema may hold only so many optional fields
 * (Anthropic answers "Schema is too complex" past its limit), and the
 * optional version has about two dozen, so here "" and 0 mean "not in the
 * recipe" and `fromWire` turns them back into absent fields.
 */
export interface WireStepGroup {
  name: string;
  nightsBeforeServing: number;
  minutesBeforeServing: number;
  duration: number;
  maxWaitMinutes: number;
  /** temperature 0 when the phase does not use the oven. */
  oven: OvenNeed;
  steps: string[];
}

export interface RecipeExtractionWire {
  name: string;
  cuisine: string;
  servings: number;
  yield: string;
  difficulty: Difficulty | "";
  prepTime: number;
  cookTime: number;
  restTime: number;
  holdTime: number;
  category: RecipeCategory | "";
  source: string;
  ingredients: Ingredient[];
  stepGroups: WireStepGroup[];
  tags: string[];
  remainingNotes: string;
}

const present = <T>(value: T | "" | 0 | null | undefined): T | undefined =>
  value === "" || value === 0 || value === null ? undefined : value as T;

/** `value` without its undefined fields (optional fields must be absent). */
const compact = <T extends object>(
  value: { [K in keyof T]: T[K] | undefined },
): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as T;

/** The model's all-required answer as a `RecipeExtraction`: "" and 0 become
 * absent, and an oven at 0°F becomes no oven. */
export const fromWire = (
  wire: Partial<RecipeExtractionWire> | null | undefined,
): RecipeExtraction | null => {
  if (!wire) return null;
  const groups = (wire.stepGroups ?? []).map((g) =>
    compact<ExtractedStepGroup>({
      name: g?.name ?? "",
      nightsBeforeServing: present(g?.nightsBeforeServing),
      minutesBeforeServing: g?.nightsBeforeServing
        ? undefined
        : typeof g?.minutesBeforeServing === "number"
        ? g.minutesBeforeServing
        : undefined,
      duration: present(g?.duration),
      maxWaitMinutes: present(g?.maxWaitMinutes),
      oven: g?.oven && g.oven.temperature > 0 ? g.oven : undefined,
      steps: g?.steps ?? [],
    })
  );
  return compact<RecipeExtraction>({
    name: present(wire.name),
    cuisine: present(wire.cuisine),
    servings: present(wire.servings),
    yield: present(wire.yield),
    difficulty: present(wire.difficulty),
    prepTime: present(wire.prepTime),
    cookTime: present(wire.cookTime),
    restTime: present(wire.restTime),
    holdTime: present(wire.holdTime),
    category: present(wire.category),
    source: present(wire.source),
    ingredients: wire.ingredients?.length ? wire.ingredients : undefined,
    stepGroups: groups.length ? groups : undefined,
    tags: wire.tags?.length ? wire.tags : undefined,
    remainingNotes: typeof wire.remainingNotes === "string"
      ? wire.remainingNotes
      : undefined,
  });
};

export const EXTRACTION_SYSTEM =
  `You extract structured recipes from unstructured text and photos of recipes.

Fill only the fields you can read with confidence. Every field must be
present: use "" for unknown text, 0 for an unknown number, [] for no items, and
an oven with temperature 0 for a phase that does not use the oven.
- name, cuisine (e.g. "Italian"), servings (number), yield (e.g. "12 cookies")
- difficulty: "easy", "medium" or "hard"
- prepTime, cookTime, restTime (after cooking, before serving), holdTime (how long
  the finished dish can wait): minutes, as numbers
- category: appetizer, main, side, starch, vegetable, dessert, bread or other
- source: where the recipe came from (URL, book, person)
- ingredients: {item, amount, unit}; amount is text such as "1 1/2"
- stepGroups: the steps in 2-5 phases that happen at different times, such as
  "Night Before", "Prep", "Cook", "Finish". Each phase has name, steps (strings),
  duration (minutes), and EITHER nightsBeforeServing (overnight work) OR
  minutesBeforeServing (day-of: 240, 60, 30, 0), never both (0 for the unused one). Add oven when the
  phase uses it: temperature (°F), duration (minutes), heightSlots (1 sheet pan,
  2 casserole, 5 turkey) and width ("full" or "half").
- tags: e.g. "vegetarian", "quick"
- remainingNotes: whatever in the notes was not extracted into a field
  (personal comments, tips, variations); "" if everything was.`;

/** The text sent for extraction: the notes, or a nudge to read the photos. */
export const extractionText = (notes: string, imageCount: number): string => {
  const trimmed = notes.trim();
  const photos = imageCount > 0
    ? `Read the recipe in the attached photo${imageCount > 1 ? "s" : ""}.`
    : "";
  return [
    "Extract the recipe.",
    photos,
    trimmed ? `Notes:\n${trimmed}` : "",
  ].filter(Boolean).join("\n\n");
};

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image: string };

/** The extraction prompt: the text, then each photo. */
export const extractionParts = (
  text: string,
  images: readonly string[],
): ContentPart[] => [
  { type: "text", text },
  ...images.filter(Boolean).map((image) => ({
    type: "image" as const,
    image,
  })),
];

/** The scalar fields an extraction can change, as they read in review. */
export interface RecipeScalars {
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
  source: string;
  notes: string;
}

const SCALAR_LABELS: ReadonlyArray<[keyof RecipeScalars, string]> = [
  ["name", "Recipe Name"],
  ["cuisine", "Cuisine"],
  ["servings", "Servings"],
  ["yield", "Yield"],
  ["difficulty", "Difficulty"],
  ["prepTime", "Prep Time (min)"],
  ["cookTime", "Cook Time (min)"],
  ["restTime", "Rest Time (min)"],
  ["holdTime", "Hold Time (min)"],
  ["category", "Category"],
  ["source", "Source"],
];

export interface FieldChange {
  field: string;
  from: string;
  to: string;
}

const isCategory = (value: unknown): value is RecipeCategory =>
  (RECIPE_CATEGORIES as readonly unknown[]).includes(value);

const isDifficulty = (value: unknown): value is Difficulty =>
  (DIFFICULTIES as readonly unknown[]).includes(value);

/** The extraction's scalar values that are usable, keyed by field. */
const usableScalars = (
  extraction: RecipeExtraction,
): Partial<RecipeScalars> => {
  const out: Partial<RecipeScalars> = {};
  const text = (v: unknown): v is string =>
    typeof v === "string" && v.trim() !== "";
  const positive = (v: unknown): v is number => typeof v === "number" && v > 0;
  if (text(extraction.name)) out.name = extraction.name.trim();
  if (text(extraction.cuisine)) out.cuisine = extraction.cuisine.trim();
  if (positive(extraction.servings)) {
    out.servings = Math.round(extraction.servings);
  }
  if (text(extraction.yield)) out.yield = extraction.yield.trim();
  if (isDifficulty(extraction.difficulty)) {
    out.difficulty = extraction.difficulty;
  }
  if (positive(extraction.prepTime)) out.prepTime = extraction.prepTime;
  if (positive(extraction.cookTime)) out.cookTime = extraction.cookTime;
  if (positive(extraction.restTime)) out.restTime = extraction.restTime;
  if (positive(extraction.holdTime)) out.holdTime = extraction.holdTime;
  if (isCategory(extraction.category)) out.category = extraction.category;
  if (text(extraction.source)) out.source = extraction.source.trim();
  if (typeof extraction.remainingNotes === "string") {
    out.notes = extraction.remainingNotes;
  }
  return out;
};

/** Each scalar field the extraction would change, current value first. */
export const scalarChanges = (
  current: RecipeScalars,
  extraction: RecipeExtraction | null | undefined,
): FieldChange[] => {
  if (!extraction) return [];
  const usable = usableScalars(extraction);
  return SCALAR_LABELS
    .filter(([key]) =>
      usable[key] !== undefined && String(usable[key]) !== String(current[key])
    )
    .map(([key, field]) => ({
      field,
      from: String(current[key]) || "(empty)",
      to: String(usable[key]),
    }));
};

/** Whether the notes would change, and to what. */
export const notesChange = (
  current: string,
  extraction: RecipeExtraction | null | undefined,
): { changes: boolean; to: string } => {
  const to = extraction?.remainingNotes;
  return typeof to === "string" && to !== current
    ? { changes: true, to }
    : { changes: false, to: current };
};

const ingredientKey = (ing: Ingredient) =>
  [ing.amount, ing.unit, ing.item].map((s) => s.trim().toLowerCase()).join("|");

/**
 * The extracted ingredients not already in the recipe. An ingredient counts as
 * already there only when item, amount and unit all match, so re-extracting
 * the same notes adds nothing, while a recipe that lists butter twice (crust
 * and filling) keeps both.
 */
export const newIngredients = (
  current: readonly Ingredient[],
  extraction: RecipeExtraction | null | undefined,
): Ingredient[] => {
  const have = new Set(current.map(ingredientKey));
  return (extraction?.ingredients ?? [])
    .filter((ing) => ing && typeof ing.item === "string" && ing.item.trim())
    .map((ing) => ({
      item: ing.item.trim(),
      amount: String(ing.amount ?? "").trim(),
      unit: String(ing.unit ?? "").trim(),
    }))
    .filter((ing) => !have.has(ingredientKey(ing)));
};

const cleanNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

const cleanOven = (oven: unknown): OvenNeed | undefined => {
  if (!oven || typeof oven !== "object") return undefined;
  const o = oven as Partial<OvenNeed>;
  const temperature = cleanNumber(o.temperature) ?? 0;
  if (temperature <= 0) return undefined;
  return {
    temperature,
    duration: cleanNumber(o.duration) ?? 0,
    heightSlots: Math.max(1, cleanNumber(o.heightSlots) ?? 1),
    width: o.width === "half" ? "half" : "full",
  };
};

/** Timing fields cleaned of junk, with nights winning over minutes. */
const cleanTiming = (
  source: Partial<Omit<StepGroup, "id" | "name" | "steps">>,
): Partial<StepGroup> => {
  const out: Partial<StepGroup> = {};
  const nights = cleanNumber(source.nightsBeforeServing);
  const minutes = cleanNumber(source.minutesBeforeServing);
  if (nights !== undefined && nights > 0) out.nightsBeforeServing = nights;
  else if (minutes !== undefined) out.minutesBeforeServing = minutes;
  const duration = cleanNumber(source.duration);
  if (duration !== undefined) out.duration = duration;
  const wait = cleanNumber(source.maxWaitMinutes);
  if (wait !== undefined) out.maxWaitMinutes = wait;
  const oven = cleanOven(source.oven);
  if (oven) out.oven = oven;
  return out;
};

/** The extracted step groups as recipe step groups, ids `${idPrefix}-n`. */
export const newStepGroups = (
  extraction: RecipeExtraction | null | undefined,
  idPrefix: string,
): StepGroup[] =>
  (extraction?.stepGroups ?? [])
    .filter((g) => g && typeof g === "object")
    .map((g, i) => ({
      id: `${idPrefix}-${i}`,
      name: (typeof g.name === "string" && g.name.trim()) || `Group ${i + 1}`,
      ...cleanTiming(g),
      steps: (Array.isArray(g.steps) ? g.steps : [])
        .map((s) =>
          typeof s === "string"
            ? s
            : String((s as { description?: string })?.description ?? "")
        )
        .filter((s) => s.trim())
        .map((description) => ({ description: description.trim() })),
    }));

/** The extracted tags not already on the recipe. */
export const newTags = (
  current: readonly string[],
  extraction: RecipeExtraction | null | undefined,
): string[] => {
  const have = new Set(current.map((t) => t.toLowerCase()));
  return (extraction?.tags ?? [])
    .filter((t) => typeof t === "string" && t.trim())
    .map((t) => t.trim())
    .filter((t) => {
      if (have.has(t.toLowerCase())) return false;
      have.add(t.toLowerCase());
      return true;
    });
};

/** The scalar values an extraction sets, ready to write. */
export const scalarUpdates = (
  extraction: RecipeExtraction | null | undefined,
): Partial<RecipeScalars> => extraction ? usableScalars(extraction) : {};

// ---------------------------------------------------------------------------
// Word diff, for reviewing the notes change
// ---------------------------------------------------------------------------

export interface DiffChunk {
  type: "removed" | "added" | "unchanged";
  word: string;
}

/** Most cells the LCS table may hold (about 8 MB); past it the differing
 * middle is shown as one removal and one addition. */
const MAX_DIFF_CELLS = 1_000_000;

/**
 * A word-level diff from `from` to `to`, by longest common subsequence over
 * words and the whitespace between them. The common start and end are matched
 * first, so an edit to long notes only compares the part that changed; a
 * changed part too large to compare is shown removed and added whole.
 */
export const wordDiff = (from: string, to: string): DiffChunk[] => {
  const a = (from || "").split(/(\s+)/).filter((w) => w !== "");
  const b = (to || "").split(/(\s+)/).filter((w) => w !== "");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head && tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) tail++;
  const unchanged = (words: string[]) =>
    words.map((word): DiffChunk => ({ type: "unchanged", word }));
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  return [
    ...unchanged(a.slice(0, head)),
    ...((midA.length + 1) * (midB.length + 1) > MAX_DIFF_CELLS
      ? [
        ...midA.map((word): DiffChunk => ({ type: "removed", word })),
        ...midB.map((word): DiffChunk => ({ type: "added", word })),
      ]
      : lcsDiff(midA, midB)),
    ...unchanged(a.slice(a.length - tail)),
  ];
};

const lcsDiff = (a: string[], b: string[]): DiffChunk[] => {
  // Longest-common-subsequence lengths, suffix-indexed.
  const lcs: number[][] = Array.from(
    { length: a.length + 1 },
    () => new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffChunk[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: "unchanged", word: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ type: "removed", word: a[i++] });
    } else {
      out.push({ type: "added", word: b[j++] });
    }
  }
  while (i < a.length) out.push({ type: "removed", word: a[i++] });
  while (j < b.length) out.push({ type: "added", word: b[j++] });
  return out;
};

// ---------------------------------------------------------------------------
// Timing suggestions
// ---------------------------------------------------------------------------

export interface TimingSuggestion {
  id: string;
  nightsBeforeServing?: number;
  minutesBeforeServing?: number;
  duration?: number;
  maxWaitMinutes?: number;
  oven?: OvenNeed;
}

export interface TimingSuggestions {
  stepGroups: TimingSuggestion[];
}

export const TIMING_SYSTEM =
  `You plan when each phase of a recipe happens relative to serving.

For every step group, keeping its id, suggest:
- EITHER nightsBeforeServing (1, 2: marinades, overnight rises, curing, long
  chilling) OR minutesBeforeServing (day-of: 240-120 main prep, 60-30 final
  cooking or reheating, 0 plating and garnish), never both
- duration: minutes the group takes, active plus passive
- maxWaitMinutes: how long its result can wait before the next step without
  losing quality (cooked pasta 5-10, roast vegetables 30-60, cold salads
  120-240, a marinade 0 since it moves straight on)
- oven, only if the group uses one: temperature (°F), duration (minutes),
  heightSlots (1 sheet pan, 2 casserole, 5 turkey), width ("full" or "half")

Think about the natural flow prep → cook → finish, food safety, and texture.`;

/** The timing prompt: the recipe's step groups, as the model should read
 * them. */
export const timingPrompt = (
  recipeName: string,
  groups: readonly StepGroup[],
): string =>
  groups.length === 0 ? "" : [
    `Recipe: ${recipeName || "Untitled"}`,
    "Step groups:",
    JSON.stringify(
      groups.map((g) => ({
        id: g.id,
        name: g.name,
        steps: g.steps.map((s) => s.description),
        nightsBeforeServing: g.nightsBeforeServing,
        minutesBeforeServing: g.minutesBeforeServing,
        duration: g.duration,
        maxWaitMinutes: g.maxWaitMinutes,
        oven: g.oven,
      })),
      null,
      2,
    ),
  ].join("\n");

const showMinutes = (n: number | undefined) =>
  n === undefined ? "(none)" : `${n} min`;

/** Every oven field, so a review never hides a change Apply would make. */
const showOven = (oven: OvenNeed | undefined) =>
  oven
    ? `${oven.temperature}°F for ${oven.duration} min, rack height ${oven.heightSlots}, ${oven.width} width`
    : "(none)";

export interface TimingReview {
  id: string;
  name: string;
  changes: FieldChange[];
}

/** For each group a suggestion would change, the changes it would make. */
export const timingReview = (
  groups: readonly StepGroup[],
  suggestions: TimingSuggestions | null | undefined,
): TimingReview[] =>
  groups
    .map((group) => {
      const next = applyTimingTo(group, suggestions);
      const changes: FieldChange[] = [];
      const when = [formatTiming(group), formatTiming(next)];
      if (when[0] !== when[1]) {
        changes.push({ field: "When", from: when[0], to: when[1] });
      }
      if (next.duration !== group.duration) {
        changes.push({
          field: "Duration",
          from: showMinutes(group.duration),
          to: showMinutes(next.duration),
        });
      }
      if (next.maxWaitMinutes !== group.maxWaitMinutes) {
        changes.push({
          field: "Can wait",
          from: showMinutes(group.maxWaitMinutes),
          to: showMinutes(next.maxWaitMinutes),
        });
      }
      if (showOven(next.oven) !== showOven(group.oven)) {
        changes.push({
          field: "Oven",
          from: showOven(group.oven),
          to: showOven(next.oven),
        });
      }
      return { id: group.id, name: group.name, changes };
    })
    .filter((r) => r.changes.length > 0);

/** `group` with its suggestion applied: a suggested field replaces the
 * current one; timing replaces timing as a whole. */
const applyTimingTo = (
  group: StepGroup,
  suggestions: TimingSuggestions | null | undefined,
): StepGroup => {
  const suggestion = (suggestions?.stepGroups ?? []).find((s) =>
    s?.id === group.id
  );
  if (!suggestion) return group;
  const clean = cleanTiming(suggestion);
  const hasTiming = clean.nightsBeforeServing !== undefined ||
    clean.minutesBeforeServing !== undefined;
  const base: StepGroup = hasTiming
    ? withField(
      withField(group, "nightsBeforeServing", undefined),
      "minutesBeforeServing",
      undefined,
    )
    : group;
  return { ...base, ...clean };
};

export const applyTimingSuggestions = (
  groups: readonly StepGroup[],
  suggestions: TimingSuggestions | null | undefined,
): StepGroup[] => groups.map((g) => applyTimingTo(g, suggestions));

// ---------------------------------------------------------------------------
// Markdown projection
// ---------------------------------------------------------------------------

export interface RecipeMarkdownInput {
  name: string;
  servings: number;
  category: string;
  prepTime: number;
  cookTime: number;
  ingredients: readonly Ingredient[];
  stepGroups: readonly StepGroup[];
  tags: readonly string[];
  notes: string;
  source: string;
}

export const ingredientLine = (ing: Ingredient): string =>
  [ing.amount, ing.unit, ing.item].map((s) => s.trim()).filter(Boolean).join(
    " ",
  );

export const recipeMarkdown = (r: RecipeMarkdownInput): string => {
  const groups = r.stepGroups.flatMap((g) => [
    "",
    `### ${g.name} (${formatTiming(g)}${
      g.oven ? `, oven ${g.oven.temperature}°F ${g.oven.duration} min` : ""
    })`,
    ...g.steps.map((s, i) => `${i + 1}. ${s.description}`),
  ]);
  return [
    `# ${r.name || "Untitled Recipe"}`,
    "",
    `Serves ${r.servings} · ${r.category} · prep ${r.prepTime} min · cook ${r.cookTime} min`,
    r.tags.length ? `Tags: ${r.tags.join(", ")}` : "",
    r.source ? `Source: ${r.source}` : "",
    "",
    "## Ingredients",
    ...r.ingredients.map((ing) => `- ${ingredientLine(ing)}`),
    "",
    "## Steps",
    ...groups,
    ...(r.notes.trim() ? ["", "## Notes", r.notes.trim()] : []),
  ].join("\n");
};

/** `groups` with the group `id` replaced by `update` of it. */
export const updatedGroup = (
  groups: readonly StepGroup[],
  id: string,
  update: (group: StepGroup) => StepGroup,
): StepGroup[] => groups.map((g) => (g.id === id ? update(g) : g));
