/**
 * Pure meal-planning logic, kept out of the pattern so the derived views, the
 * actions and the tests all run the same code: the day's oven plan and its
 * conflicts, the meal's balance, each guest's dietary fit, the prompts for
 * linking planning notes and for menu suggestions and how their answers apply,
 * and the markdown projection.
 *
 * Time is counted in minutes before serving, as the recipes count it: a step
 * group that starts 90 minutes out and roasts for 60 holds the oven from 90
 * down to 30.
 */
import {
  type DietaryCompatibility,
  type DietarySource,
  RECIPE_CATEGORIES,
  type RecipeCategory,
  type StepGroup,
} from "../food-recipe/schemas.tsx";

// ---------------------------------------------------------------------------
// Equipment and guests
// ---------------------------------------------------------------------------

export interface OvenConfig {
  /** Vertical rack positions the oven has, 3 to 7. */
  rackPositions: number;
  /** Racks actually owned, 1 to 3. */
  physicalRacks: number;
}

export const DEFAULT_OVEN: OvenConfig = { rackPositions: 5, physicalRacks: 2 };

export type OvenField = keyof OvenConfig;

export const OVEN_LIMITS: Record<OvenField, [number, number]> = {
  rackPositions: [3, 7],
  physicalRacks: [1, 3],
};

/** `oven` with `field` set from input text, clamped to its range; invalid
 * text leaves it unchanged. */
export const withOvenField = (
  oven: OvenConfig,
  field: OvenField,
  value: string,
): OvenConfig => {
  const text = value.trim();
  const n = Number(text);
  if (text === "" || !Number.isFinite(n)) return oven;
  const [lo, hi] = OVEN_LIMITS[field];
  return { ...oven, [field]: Math.min(hi, Math.max(lo, Math.round(n))) };
};

export interface GuestDietaryProfile {
  guestName: string;
  /** "vegan", "gluten-free", "no-mushrooms", ... */
  requirements: string[];
}

/** Two dishes in one oven whose temperatures differ by more than this
 * cannot share it. */
export const TEMP_TOLERANCE = 25;

// ---------------------------------------------------------------------------
// Oven timeline
// ---------------------------------------------------------------------------

/** What the planner reads of a recipe for the oven plan. */
export interface OvenRecipe {
  name: string;
  stepGroups?: readonly StepGroup[];
}

/** One step group's time in the oven. */
export interface OvenEvent {
  id: string;
  dish: string;
  step: string;
  /** Minutes before serving it goes in. */
  start: number;
  /** Minutes before serving it comes out; negative is after serving. */
  end: number;
  temperature: number;
  heightSlots: number;
  width: "full" | "half";
}

/** An oven step group the day's plan leaves out, and why. */
export interface OffTimeline {
  dish: string;
  step: string;
  reason: string;
}

const dishName = (name: string | undefined, fallback: string) =>
  (name ?? "").trim() || fallback;

/**
 * The oven events of `recipes`. A group occupies the oven from its
 * `minutesBeforeServing` for `oven.duration` minutes (the group's own
 * `duration` when the oven's is unset). Night-before groups, and groups with
 * no start or no oven time, are reported in `offTimeline` instead.
 */
export const ovenEvents = (
  recipes: readonly OvenRecipe[],
): { events: OvenEvent[]; offTimeline: OffTimeline[] } => {
  const events: OvenEvent[] = [];
  const offTimeline: OffTimeline[] = [];
  recipes.forEach((recipe, r) => {
    if (!recipe) return;
    const dish = dishName(recipe.name, "Untitled Recipe");
    (recipe.stepGroups ?? []).forEach((group, g) => {
      const oven = group?.oven;
      if (!oven || !(oven.temperature > 0)) return;
      const step = dishName(group.name, "Step");
      const nights = group.nightsBeforeServing ?? 0;
      const start = group.minutesBeforeServing;
      const minutes = oven.duration > 0 ? oven.duration : group.duration ?? 0;
      if (nights > 0) {
        offTimeline.push({
          dish,
          step,
          reason: nights === 1 ? "the night before" : `${nights} nights before`,
        });
      } else if (start === undefined || start === null) {
        offTimeline.push({
          dish,
          step,
          reason: "not scheduled (set its minutes before serving)",
        });
      } else if (!(minutes > 0)) {
        offTimeline.push({ dish, step, reason: "its oven time is not set" });
      } else {
        events.push({
          id: `${r}:${group.id || g}`,
          dish,
          step,
          start,
          end: start - minutes,
          temperature: oven.temperature,
          heightSlots: Math.max(1, oven.heightSlots || 1),
          width: oven.width === "half" ? "half" : "full",
        });
      }
    });
  });
  return { events, offTimeline };
};

/** Whether `event` is in the oven at `t` minutes before serving. */
const inOvenAt = (event: OvenEvent, t: number) =>
  event.end < t && t <= event.start;

const overlap = (a: OvenEvent, b: OvenEvent) =>
  a.end < b.start && b.end < a.start;

export type LoadProblem =
  | { kind: "temperature"; temps: number[] }
  | { kind: "racks"; need: number; have: number }
  | { kind: "height"; need: number; have: number };

/**
 * Why `dishes` cannot share `oven` at one moment, or null when they can. They
 * need one temperature (within TEMP_TOLERANCE); a rack each, two half-width
 * dishes sharing one; and the rack positions their heights add up to, two
 * half-width dishes side by side taking the taller one's height.
 */
export const ovenLoadProblem = (
  dishes: readonly OvenEvent[],
  oven: OvenConfig,
): LoadProblem | null => {
  if (dishes.length === 0) return null;
  const temps = [...new Set(dishes.map((d) => d.temperature))].sort((a, b) =>
    a - b
  );
  if (temps[temps.length - 1] - temps[0] > TEMP_TOLERANCE) {
    return { kind: "temperature", temps };
  }
  const full = dishes.filter((d) => d.width === "full");
  const half = dishes
    .filter((d) => d.width === "half")
    .map((d) => d.heightSlots)
    .sort((a, b) => b - a);
  const racks = full.length + Math.ceil(half.length / 2);
  if (racks > oven.physicalRacks) {
    return { kind: "racks", need: racks, have: oven.physicalRacks };
  }
  const height = full.reduce((sum, d) => sum + d.heightSlots, 0) +
    half.reduce((sum, h, i) => sum + (i % 2 === 0 ? h : 0), 0);
  if (height > oven.rackPositions) {
    return { kind: "height", need: height, have: oven.rackPositions };
  }
  return null;
};

/** An oven event with the oven it was given: an index into the ovens, or
 * null when none could take it. */
export interface PlacedEvent extends OvenEvent {
  oven: number | null;
}

export interface OvenConflict {
  id: string;
  dish: string;
  step: string;
  /** Minutes before serving the dish has nowhere to go. */
  at: number;
  /** °F the dish wants. */
  temperature: number;
  /** Who else is involved: the dishes it collides with. */
  with: string[];
  reason: string;
}

export interface OvenPlan {
  events: PlacedEvent[];
  conflicts: OvenConflict[];
  offTimeline: OffTimeline[];
  /** Problems short of a conflict: a dish not out by serving time. */
  warnings: string[];
}

const problemText = (
  problem: LoadProblem,
  ovenLabel: string,
  others: readonly OvenEvent[],
): string => {
  const names = others.map((o) => o.dish).join(", ");
  if (problem.kind === "temperature") {
    return names
      ? `${ovenLabel} has ${names} at ${
        others.map((o) => `${o.temperature}°F`).filter((t, i, all) =>
          all.indexOf(t) === i
        ).join("/")
      }`
      : `${ovenLabel} cannot hold ${problem.temps.join("°F and ")}°F at once`;
  }
  const what = problem.kind === "racks" ? "racks" : "rack positions";
  return `${ovenLabel} would need ${problem.need} ${what}, has ${problem.have}${
    names ? ` (with ${names})` : ""
  }`;
};

/** Why `event` cannot join `placed` in oven `o`, or null when it can. The
 * load is checked at every moment something goes in while `event` is in. */
const placementProblem = (
  placed: readonly PlacedEvent[],
  event: OvenEvent,
  o: number,
  oven: OvenConfig,
): { text: string; involved: string[] } | null => {
  const sharing = placed.filter((p) => p.oven === o && overlap(p, event));
  const moments = [event.start].concat(
    sharing.map((p) => p.start).filter((t) => inOvenAt(event, t)),
  );
  for (const t of moments) {
    const there = sharing.filter((p) => inOvenAt(p, t));
    const load: OvenEvent[] = [...there, event];
    const problem = ovenLoadProblem(load, oven);
    if (problem) {
      return {
        text: problemText(problem, `Oven ${o + 1}`, there),
        involved: there.map((p) => p.dish),
      };
    }
  }
  return null;
};

/** Ovens to try for `event`, best first: one already at its temperature,
 * then the smallest. */
const ovenOrder = (
  placed: readonly PlacedEvent[],
  event: OvenEvent,
  ovens: readonly OvenConfig[],
): number[] => {
  const warm = (o: number) =>
    placed.some((p) =>
      p.oven === o && overlap(p, event) &&
      Math.abs(p.temperature - event.temperature) <= TEMP_TOLERANCE
    );
  return ovens.map((_, o) => o).sort((a, b) =>
    Number(warm(b)) - Number(warm(a)) ||
    ovens[a].rackPositions * ovens[a].physicalRacks -
      ovens[b].rackPositions * ovens[b].physicalRacks ||
    a - b
  );
};

/** How many placements the exact search may try before settling for the
 * greedy plan. A meal has a handful of oven steps, so this is rarely hit. */
const SEARCH_BUDGET = 20000;

/** An oven for every event with no conflict, found by backtracking, or null
 * when there is none (or the search ran out of budget). */
const searchPlan = (
  sorted: readonly OvenEvent[],
  ovens: readonly OvenConfig[],
): PlacedEvent[] | null => {
  const placed: PlacedEvent[] = [];
  const tries: number[][] = [];
  const next: number[] = [];
  let budget = SEARCH_BUDGET;
  let i = 0;
  while (i < sorted.length) {
    if (budget-- <= 0) return null;
    if (tries[i] === undefined) {
      tries[i] = ovenOrder(placed, sorted[i], ovens);
      next[i] = 0;
    }
    let chosen = -1;
    while (next[i] < tries[i].length && chosen < 0) {
      const o = tries[i][next[i]++];
      if (!placementProblem(placed, sorted[i], o, ovens[o])) chosen = o;
    }
    if (chosen >= 0) {
      placed.push({ ...sorted[i], oven: chosen });
      i++;
    } else {
      // Nothing fits here: undo the previous choice and try its next oven.
      tries.length = i;
      if (i === 0) return null;
      placed.pop();
      i--;
    }
  }
  return placed;
};

/**
 * Gives each oven event an oven so that every oven's load fits it at every
 * moment; a dish stays in one oven for its whole time. It looks for an
 * assignment with no conflict at all. When there is none, it places dishes
 * earliest first, each in the best oven that takes it, and reports each dish
 * no oven can take, naming what each oven holds then.
 *
 * It also warns of a dish still in the oven after serving time.
 */
export const planOvens = (
  recipes: readonly OvenRecipe[],
  ovens: readonly OvenConfig[],
): OvenPlan => {
  const { events, offTimeline } = ovenEvents(recipes);
  const sorted = [...events].sort((a, b) =>
    b.start - a.start || (b.start - b.end) - (a.start - a.end) ||
    a.id.localeCompare(b.id)
  );
  const warnings = sorted
    .filter((e) => e.end < 0)
    .map((e) =>
      `${e.dish} (${e.step}) comes out ${formatBefore(e.end)} serving.`
    );
  const exact = ovens.length > 0 ? searchPlan(sorted, ovens) : null;
  if (exact) return { events: exact, conflicts: [], offTimeline, warnings };
  const placed: PlacedEvent[] = [];
  const conflicts: OvenConflict[] = [];
  for (const event of sorted) {
    const reasons: string[] = [];
    const involved = new Set<string>();
    let chosen: number | null = null;
    for (const o of ovenOrder(placed, event, ovens)) {
      const problem = placementProblem(placed, event, o, ovens[o]);
      if (!problem) {
        chosen = o;
        break;
      }
      reasons.push(problem.text);
      problem.involved.forEach((d) => involved.add(d));
    }
    placed.push({ ...event, oven: chosen });
    if (chosen === null) {
      conflicts.push({
        id: event.id,
        dish: event.dish,
        step: event.step,
        at: event.start,
        temperature: event.temperature,
        with: [...involved],
        reason: ovens.length === 0
          ? "No oven is set up."
          : `${reasons.join("; ")}.`,
      });
    }
  }
  return { events: placed, conflicts, offTimeline, warnings };
};

/** "2h 30m before", "serving", "15m after". */
export const formatBefore = (minutes: number): string => {
  const rounded = Math.round(minutes);
  if (rounded === 0) return "serving";
  const abs = Math.abs(rounded);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  const span = h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`;
  return rounded > 0 ? `${span} before` : `${span} after`;
};

/** The clock time `minutesBefore` a serving time of "HH:MM", as "4:30 PM",
 * or "" when the serving time is not set. */
export const clockAt = (mealTime: string, minutesBefore: number): string => {
  const match = (mealTime ?? "").match(/^(\d{1,2}):(\d{2})/);
  if (!match) return "";
  const total = Number(match[1]) * 60 + Number(match[2]) -
    Math.round(minutesBefore);
  const day = 24 * 60;
  const inDay = ((total % day) + day) % day;
  const h = Math.floor(inDay / 60);
  const m = inDay % 60;
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  const clock = `${hour12}:${String(m).padStart(2, "0")} ${
    h < 12 ? "AM" : "PM"
  }`;
  return total < 0
    ? `${clock} (day before)`
    : total >= day
    ? `${clock} (next day)`
    : clock;
};

/** A time on the timeline in words: the clock time when the serving time is
 * set, then how long before serving. */
export const timeLabel = (mealTime: string, minutesBefore: number): string => {
  const clock = clockAt(mealTime, minutesBefore);
  const rel = formatBefore(minutesBefore);
  return clock ? `${clock} (${rel})` : rel;
};

/** One row of the drawn timeline. */
export interface TimelineRow {
  id: string;
  dish: string;
  step: string;
  ovenLabel: string;
  temperature: number;
  /** Percent of the timeline's width. */
  left: number;
  width: number;
  conflict: boolean;
  when: string;
}

export interface Timeline {
  rows: TimelineRow[];
  /** Labels for the left edge, middle and right edge (serving or later). */
  axis: [string, string, string];
}

/** `plan` laid out for drawing, from the earliest oven start to serving (or
 * the last dish out, if that is later). */
export const timeline = (plan: OvenPlan, mealTime: string): Timeline => {
  const events = plan.events;
  if (events.length === 0) return { rows: [], axis: ["", "", ""] };
  const from = events.reduce((max, e) => Math.max(max, e.start), 0);
  const to = events.reduce((min, e) => Math.min(min, e.end), 0);
  const span = from - to || 1;
  const pct = (n: number) => Math.round(n * 10) / 10;
  const conflicted = new Set(plan.conflicts.map((c) => c.id));
  const short = (m: number) => clockAt(mealTime, m) || formatBefore(m);
  return {
    rows: events.map((e) => ({
      id: e.id,
      dish: e.dish,
      step: e.step,
      ovenLabel: e.oven === null ? "No oven" : `Oven ${e.oven + 1}`,
      temperature: e.temperature,
      left: pct(((from - e.start) / span) * 100),
      width: pct(((e.start - e.end) / span) * 100),
      conflict: conflicted.has(e.id),
      when: `${short(e.start)} – ${short(e.end)}`,
    })),
    axis: [short(from), short(Math.round((from + to) / 2)), short(to)],
  };
};

// ---------------------------------------------------------------------------
// Meal balance
// ---------------------------------------------------------------------------

export const clampCategory = (category: unknown): RecipeCategory =>
  (RECIPE_CATEGORIES as readonly unknown[]).includes(category)
    ? category as RecipeCategory
    : "other";

const PLURAL: Record<RecipeCategory, string> = {
  appetizer: "Appetizers",
  main: "Mains",
  side: "Sides",
  starch: "Starches",
  vegetable: "Vegetables",
  dessert: "Desserts",
  bread: "Breads",
  other: "Other dishes",
};

export interface BalanceDish {
  name: string;
  servings: number;
  category: RecipeCategory;
}

export interface CategoryLine {
  category: RecipeCategory;
  label: string;
  dishes: number;
  servings: number;
}

export interface MealBalance {
  categories: CategoryLine[];
  dishCount: number;
  totalServings: number;
  warnings: string[];
}

/**
 * Dishes and servings per category, in menu order, and what looks short: no
 * main, or a course whose dishes together serve fewer than the guests.
 */
export const mealBalance = (
  dishes: readonly BalanceDish[],
  guestCount: number,
): MealBalance => {
  const present = dishes.filter(Boolean);
  const categories = RECIPE_CATEGORIES.map((category) => {
    const these = present.filter((d) => clampCategory(d.category) === category);
    return {
      category,
      label: PLURAL[category],
      dishes: these.length,
      servings: these.reduce((sum, d) => sum + (Number(d.servings) || 0), 0),
    };
  }).filter((line) => line.dishes > 0);
  const warnings: string[] = [];
  if (present.length > 0 && !categories.some((c) => c.category === "main")) {
    warnings.push("No main dish yet.");
  }
  categories
    .filter((c) => c.category !== "other" && c.servings < guestCount)
    .forEach((c) =>
      warnings.push(
        `${c.label} serve ${c.servings} for ${guestCount} guests.`,
      )
    );
  return {
    categories,
    dishCount: present.length,
    totalServings: categories.reduce((sum, c) => sum + c.servings, 0),
    warnings,
  };
};

// ---------------------------------------------------------------------------
// Dietary fit
// ---------------------------------------------------------------------------

export interface DietDish {
  name: string;
  category: RecipeCategory;
  dietaryCompatibility: DietaryCompatibility;
  dietarySource: DietarySource;
  /** Every ingredient, for a cooked recipe. Absent for a prepared food,
   * whose ingredients nobody has listed in full. */
  ingredients?: readonly string[];
}

export type Fit = "fits" | "conflicts" | "unknown";

/** "Gluten free" → "gluten-free"; "no mushrooms" → "no-mushrooms". */
export const normalizeRequirement = (requirement: string): string =>
  requirement.trim().toLowerCase().replace(/\s+/g, "-");

/** Tags that a stricter tag implies. */
const IMPLIED: Record<string, string[]> = {
  vegan: [
    "vegetarian",
    "pescatarian",
    "dairy-free",
    "lactose-free",
    "egg-free",
  ],
  vegetarian: ["pescatarian"],
  "dairy-free": ["lactose-free"],
  "nut-free": ["peanut-free", "tree-nut-free"],
};

/** A word's singular form, roughly: "tomatoes" → "tomato", "cheeses" →
 * "cheese", "berries" → "berry". */
export const stem = (word: string): string => {
  const w = word.trim().toLowerCase();
  if (w.endsWith("ies") && w.length > 4) return `${w.slice(0, -3)}y`;
  if (/(oes|ches|shes|xes|sses)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) {
    return w.slice(0, -1);
  }
  return w;
};

/**
 * Words that name a whole class of food rather than one ingredient. Whether a
 * dish is free of one cannot be read from its ingredient names (pecans are
 * nuts, butter is dairy), so only a dietary tag says it fits.
 */
const FOOD_CLASSES = new Set([
  "nut",
  "peanut",
  "tree-nut",
  "dairy",
  "lactose",
  "milk",
  "gluten",
  "wheat",
  "grain",
  "meat",
  "pork",
  "beef",
  "lamb",
  "poultry",
  "shellfish",
  "seafood",
  "fish",
  "egg",
  "soy",
  "sesame",
  "alcohol",
  "sugar",
  "animal-product",
  "nightshade",
]);

/** Whether `text` names `x` (a stemmed word or phrase): as one of its words,
 * so "peanut" is not "pea" and "eggplant" is not "egg". */
const mentions = (text: string, x: string): boolean => {
  const words = text.toLowerCase().split(/[^a-z]+/).filter(Boolean).map(stem);
  const parts = x.split(" ");
  return words.some((_, i) => parts.every((p, k) => words[i + k] === p));
};

/**
 * Whether `dish` suits one requirement. Unknown is never read as safe:
 *
 * - A dish nobody has analyzed or declared is unknown.
 * - A dietary tag the dish lists decides, including a stricter tag that
 *   implies it (vegan implies vegetarian); "no-X" and "X-free" are one need.
 * - For "no-X" / "X-free", X among the dish's ingredients, main ingredients
 *   or warnings is a conflict.
 * - Otherwise "no-X" fits only when X is one ingredient (not a class like
 *   nuts or dairy) and the dish is a recipe whose full ingredient list is
 *   known and does not name it.
 */
export const requirementFit = (dish: DietDish, requirement: string): Fit => {
  const req = normalizeRequirement(requirement);
  if (!req || dish.dietarySource === "none") return "unknown";
  const diet = dish.dietaryCompatibility ?? {
    compatible: [],
    incompatible: [],
    warnings: [],
    primaryIngredients: [],
  };
  const avoided = req.startsWith("no-")
    ? req.slice(3)
    : req.endsWith("-free")
    ? req.slice(0, -5)
    : "";
  const s = stem(avoided);
  const names = avoided
    ? [req, `no-${s}`, `no-${s}s`, `${s}-free`, `${s}s-free`]
    : [req];
  const tags = (list: readonly string[] | undefined) =>
    (list ?? []).map(normalizeRequirement);
  const compatible = tags(diet.compatible);
  const incompatible = tags(diet.incompatible);
  if (names.some((n) => incompatible.includes(n))) return "conflicts";
  const implied = compatible.flatMap((t) => [t, ...(IMPLIED[t] ?? [])]);
  if (names.some((n) => implied.includes(n))) return "fits";
  if (!avoided) return "unknown";
  const x = avoided.split("-").map(stem).join(" ");
  const named = (list: readonly string[] | undefined) =>
    (list ?? []).some((text) => mentions(text, x));
  if (
    named(dish.ingredients) || named(diet.primaryIngredients) ||
    named(diet.warnings)
  ) {
    return "conflicts";
  }
  const fullList = (dish.ingredients ?? []).length > 0;
  return req.startsWith("no-") && fullList && !FOOD_CLASSES.has(s)
    ? "fits"
    : "unknown";
};

/** The tag to record when someone checks that a dish meets `requirement`:
 * "no-nuts" is recorded as "nut-free", the tag an analysis uses. */
export const tagFor = (requirement: string): string => {
  const req = normalizeRequirement(requirement);
  if (!req.startsWith("no-")) return req;
  const s = stem(req.slice(3));
  return FOOD_CLASSES.has(s) ? `${s}-free` : req;
};

export interface RequirementCheck {
  guest: string;
  requirement: string;
  fits: string[];
  conflicts: string[];
  unknown: string[];
  /** Empty when something on the menu is known to suit the guest. */
  warning: string;
}

/**
 * For each guest's requirement, which dishes are known to suit it, known not
 * to, or unknown, and a warning when nothing (or no main) is known to suit
 * it. A dish whose analysis is out of date is listed as such and does not
 * count toward clearing the warning.
 */
export const dietaryChecks = (
  dishes: readonly DietDish[],
  profiles: readonly GuestDietaryProfile[],
): RequirementCheck[] => {
  const present = dishes.filter(Boolean);
  const hasMain = present.some((d) => d.category === "main");
  return profiles.flatMap((profile, p) => {
    if (!profile) return [];
    const guest = (profile.guestName ?? "").trim() || `Guest ${p + 1}`;
    const requirements = [
      ...new Set(
        (profile.requirements ?? []).map(normalizeRequirement).filter(Boolean),
      ),
    ];
    return requirements.map((requirement) => {
      const fit = present.map((d) => requirementFit(d, requirement));
      const label = (d: DietDish) =>
        d.dietarySource === "stale" ? `${d.name} (out of date)` : d.name;
      const pick = (want: Fit) =>
        present.filter((_, i) => fit[i] === want).map(label);
      const current = (d: DietDish, i: number) =>
        fit[i] === "fits" && d.dietarySource !== "stale";
      const fits = pick("fits");
      const anyCurrent = present.some(current);
      const currentMain = present.some((d, i) =>
        current(d, i) && d.category === "main"
      );
      const who = `${guest} (${requirement})`;
      return {
        guest,
        requirement,
        fits,
        conflicts: pick("conflicts"),
        unknown: pick("unknown"),
        warning: present.length === 0
          ? ""
          : !anyCurrent && fits.length > 0
          ? `Only out-of-date analyses say something suits ${who}: re-analyze.`
          : !anyCurrent
          ? `Nothing on the menu is known to suit ${who}.`
          : hasMain && !currentMain
          ? `No main is known to suit ${who}.`
          : "",
      };
    });
  });
};

// ---------------------------------------------------------------------------
// Linking planning notes to dishes
// ---------------------------------------------------------------------------

export type DishKind = "recipe" | "prepared";

/** One food the model found in the planning notes. */
export interface LinkItem {
  /** A clean name for the dish. */
  name: string;
  /** "recipe" when cooked at home; "prepared" when bought, brought or
   * ordered. */
  type: DishKind;
  /** The existing dish's exact name when one matches, else "". */
  existingName: string;
  /** The words in the notes it came from. */
  quote: string;
  servings?: number;
  category?: string;
  description?: string;
  /** Where a prepared dish comes from: a store, a person, takeout. */
  source?: string;
}

export interface LinkAnalysis {
  items: LinkItem[];
}

export const LINKING_SYSTEM =
  `You help plan a meal. Read the planning notes and list every food item they
mention.

For each item:
- name: a clean dish name ("Mashed Potatoes", "Costco Rotisserie Chicken")
- type: "recipe" if someone will cook it, "prepared" if it is bought, brought
  by a guest, or ordered in
- existingName: when the item is one of the existing dishes listed, that dish's
  name exactly as listed; otherwise "". Match by meaning ("rotisserie chicken"
  matches "Costco Rotisserie Chicken"), but only when you are fairly sure.
- quote: the words in the notes it came from
- servings: if the notes say how many it serves ("serves 8", "for 12")
- category: one of appetizer, main, side, starch, vegetable, dessert, bread,
  other
- description: a few words from the notes, if any
- source: for prepared items, the store, person or restaurant, if named

Leave out items already in the meal. List each food once.`;

/** The prompt for one linking request. */
export const linkingPrompt = (input: {
  notes: string;
  libraryRecipes: readonly string[];
  libraryPrepared: readonly string[];
  inMeal: readonly string[];
}): string => {
  const list = (names: readonly string[]) =>
    names.length ? names.map((n) => `- ${n}`).join("\n") : "(none)";
  return `Planning notes:
${input.notes.trim()}

Existing recipes:
${list(input.libraryRecipes)}

Existing prepared foods:
${list(input.libraryPrepared)}

Already in this meal:
${list(input.inMeal)}`;
};

/** What applying one found item does. */
export type LinkStep =
  | { kind: "link"; type: DishKind; index: number; name: string }
  | {
    kind: "create";
    type: DishKind;
    name: string;
    servings: number;
    category: RecipeCategory;
    notes: string;
    source: string;
  }
  | { kind: "skip"; name: string; reason: string };

const sameName = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * One step per found item, in order: link an existing dish (by its index in
 * that kind's library), create a new one, or skip it, because it was
 * unchecked, is already in the meal, or repeats an earlier item. A match
 * named under the other kind is linked as that kind, since the model can
 * misjudge whether something is cooked or bought.
 */
export const planLinking = (input: {
  items: readonly LinkItem[];
  unchecked: readonly number[];
  libraryRecipes: readonly string[];
  libraryPrepared: readonly string[];
  inMeal: readonly string[];
}): LinkStep[] => {
  const seen = new Set(input.inMeal.map((n) => n.trim().toLowerCase()));
  return input.items.map((item, i): LinkStep => {
    const name = (item?.name ?? "").trim();
    if (!name) return { kind: "skip", name: "(unnamed)", reason: "no name" };
    if (input.unchecked.includes(i)) {
      return { kind: "skip", name, reason: "unchecked" };
    }
    // The model's match, or failing that a dish named exactly as the item.
    const wanted = (item.existingName ?? "").trim();
    const find = (lib: readonly string[]) => {
      const byMatch = wanted ? lib.findIndex((n) => sameName(n, wanted)) : -1;
      return byMatch >= 0 ? byMatch : lib.findIndex((n) => sameName(n, name));
    };
    const asRecipe = find(input.libraryRecipes);
    const asPrepared = find(input.libraryPrepared);
    const preferPrepared = item.type === "prepared";
    const match = preferPrepared
      ? asPrepared >= 0
        ? { type: "prepared" as const, index: asPrepared }
        : asRecipe >= 0
        ? { type: "recipe" as const, index: asRecipe }
        : null
      : asRecipe >= 0
      ? { type: "recipe" as const, index: asRecipe }
      : asPrepared >= 0
      ? { type: "prepared" as const, index: asPrepared }
      : null;
    const finalName = match
      ? (match.type === "recipe"
        ? input.libraryRecipes
        : input.libraryPrepared)[match.index]
      : name;
    const key = finalName.trim().toLowerCase();
    if (seen.has(key)) {
      return { kind: "skip", name: finalName, reason: "already in the meal" };
    }
    seen.add(key);
    if (match) return { kind: "link", ...match, name: finalName };
    const servings = Math.round(Number(item.servings));
    return {
      kind: "create",
      type: item.type === "prepared" ? "prepared" : "recipe",
      name,
      servings: servings > 0 ? servings : 4,
      category: clampCategory(item.category),
      notes: (item.description ?? "").trim(),
      source: (item.source ?? "").trim(),
    };
  });
};

/** A step in words, for the review. */
export const stepSummary = (step: LinkStep): string =>
  step.kind === "link"
    ? `Add existing ${step.type === "recipe" ? "recipe" : "prepared food"}`
    : step.kind === "create"
    ? `Create new ${step.type === "recipe" ? "recipe" : "prepared food"}`
    : `Skip: ${step.reason}`;

// ---------------------------------------------------------------------------
// Menu suggestions
// ---------------------------------------------------------------------------

export interface MenuSuggestions {
  suggestions: string[];
}

export const SUGGESTIONS_SYSTEM =
  `You are a practical meal-planning expert. Given a menu, the guest count and
the guests' dietary needs, suggest at most five concrete improvements: missing
courses, too much or too little of something, dishes a guest with a dietary
need could eat, and variety. One short sentence each. Do not repeat problems
the planner has already found unless you have a fix for them.`;

export const suggestionsPrompt = (input: {
  mealName: string;
  guestCount: number;
  dishes: readonly (BalanceDish & { kind: DishKind })[];
  requirements: readonly string[];
  knownProblems: readonly string[];
}): string =>
  `Meal: ${input.mealName.trim() || "Untitled Meal"}
Guests: ${input.guestCount}
Dietary needs: ${input.requirements.join(", ") || "none"}

Menu:
${
    input.dishes.map((d) =>
      `- ${d.name} (${d.category}, serves ${d.servings}${
        d.kind === "prepared" ? ", bought or brought" : ""
      })`
    ).join("\n") || "(empty)"
  }

Problems already found:
${input.knownProblems.map((p) => `- ${p}`).join("\n") || "(none)"}`;

// ---------------------------------------------------------------------------
// Markdown projection
// ---------------------------------------------------------------------------

/** The meal as markdown, for the pattern's file projection. */
export const mealMarkdown = (m: {
  name: string;
  date: string;
  time: string;
  guestCount: number;
  recipes: readonly BalanceDish[];
  preparedFoods: readonly BalanceDish[];
  guests: readonly GuestDietaryProfile[];
  ovenPlan: OvenPlan;
  notes: string;
}): string => {
  const when = [m.date, m.time].filter(Boolean).join(" at ");
  const dish = (d: BalanceDish) =>
    `- ${d.name} (${d.category}, serves ${d.servings})`;
  const section = (title: string, lines: readonly string[]) =>
    lines.length ? ["", `## ${title}`].concat(lines) : [];
  const needs = m.guests
    .map((g, i) => ({
      name: (g?.guestName ?? "").trim() || `Guest ${i + 1}`,
      requirements: g?.requirements ?? [],
    }))
    .filter((g) => g.requirements.length)
    .map((g) => `- ${g.name}: ${g.requirements.join(", ")}`);
  const oven = m.ovenPlan.events.length
    ? [...m.ovenPlan.events]
      .sort((a, b) => b.start - a.start)
      .map((e) =>
        `- ${
          timeLabel(m.time, e.start)
        }: ${e.dish} (${e.step}) at ${e.temperature}°F for ${
          e.start - e.end
        } min, ${e.oven === null ? "no oven free" : `oven ${e.oven + 1}`}`
      )
    : [];
  // The problems the oven panel shows, so the export loses none of them.
  const ovenNotes = m.ovenPlan.conflicts
    .map((c) => `- Conflict: ${c.dish}: ${c.reason}`)
    .concat(m.ovenPlan.warnings.map((w) => `- Warning: ${w}`))
    .concat(
      m.ovenPlan.offTimeline.map((o) =>
        `- Not on the timeline: ${o.dish} (${o.step}) is ${o.reason}`
      ),
    );
  return [
    `# ${m.name}`,
    "",
    [when, `${m.guestCount} guests`].filter(Boolean).join(" · "),
  ]
    .concat(section("Recipes", m.recipes.map(dish)))
    .concat(section("Prepared foods", m.preparedFoods.map(dish)))
    .concat(section("Dietary needs", needs))
    .concat(section("Oven plan", oven.concat(ovenNotes)))
    .concat(section("Notes", m.notes.trim() ? [m.notes.trim()] : []))
    .join("\n");
};
