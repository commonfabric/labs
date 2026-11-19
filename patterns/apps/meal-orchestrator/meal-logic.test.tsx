/**
 * Meal logic tests: the oven plan and its conflicts, timeline layout, meal
 * balance, dietary fit, and how a notes analysis turns into steps.
 *
 * Run: deno task cf test patterns/apps/meal-orchestrator/meal-logic.test.tsx --verbose
 */
import { assert, pattern, TESTS } from "commonfabric";
import type { StepGroup } from "../food-recipe/schemas.tsx";
import {
  clockAt,
  dietaryChecks,
  type DietDish,
  formatBefore,
  mealBalance,
  mealMarkdown,
  type OvenEvent,
  ovenEvents,
  ovenLoadProblem,
  planLinking,
  planOvens,
  requirementFit,
  tagFor,
  timeline,
  withOvenField,
} from "./meal-logic.ts";

const ovenGroup = (
  id: string,
  start: number | undefined,
  temperature: number,
  duration: number,
  extra: Partial<StepGroup> = {},
  heightSlots = 1,
  width: "full" | "half" = "full",
): StepGroup => ({
  id,
  name: id,
  ...(start === undefined ? {} : { minutesBeforeServing: start }),
  oven: { temperature, duration, heightSlots, width },
  steps: [],
  ...extra,
});

const event = (
  temperature: number,
  heightSlots = 1,
  width: "full" | "half" = "full",
): OvenEvent => ({
  id: `${temperature}-${heightSlots}-${width}`,
  dish: "d",
  step: "s",
  start: 60,
  end: 0,
  temperature,
  heightSlots,
  width,
});

const dish = (
  name: string,
  category: DietDish["category"],
  compatible: string[],
  extra: Partial<DietDish["dietaryCompatibility"]> = {},
  source: DietDish["dietarySource"] = "analyzed",
): DietDish => ({
  name,
  category,
  dietarySource: source,
  dietaryCompatibility: {
    compatible,
    incompatible: [],
    warnings: [],
    primaryIngredients: [],
    ...extra,
  },
});

const OVEN = { rackPositions: 5, physicalRacks: 2 };

export default pattern(() => {
  const assert_events_and_off_timeline = assert(() => {
    const { events, offTimeline } = ovenEvents([{
      name: "Pie",
      stepGroups: [
        ovenGroup("bake", 120, 400, 50),
        ovenGroup("crust", undefined, 375, 15, { nightsBeforeServing: 1 }),
        ovenGroup("glaze", undefined, 350, 10),
        ovenGroup("warm", 30, 300, 0, { duration: 20 }),
        { id: "chill", name: "Chill", minutesBeforeServing: 60, steps: [] },
      ],
    }]);
    return events.length === 2 &&
      events[0].start === 120 && events[0].end === 70 &&
      // The group's own duration stands in for an unset oven time.
      events[1].end === 10 &&
      offTimeline.map((o) => o.reason).join("|") ===
        "the night before|not scheduled (set its minutes before serving)";
  });

  const assert_load_rules = assert(() =>
    ovenLoadProblem([event(350), event(375)], OVEN) === null &&
    ovenLoadProblem([event(325), event(425)], OVEN)?.kind === "temperature" &&
    ovenLoadProblem([event(350), event(350), event(350)], OVEN)?.kind ===
      "racks" &&
    // Two half-width dishes share one rack.
    ovenLoadProblem(
        [event(350, 1, "half"), event(350, 1, "half"), event(350)],
        OVEN,
      ) === null &&
    ovenLoadProblem([event(325, 5), event(325)], OVEN)?.kind === "height" &&
    ovenLoadProblem([event(325, 6)], OVEN)?.kind === "height"
  );

  const turkey = {
    name: "Turkey",
    stepGroups: [ovenGroup("roast", 300, 325, 240, {}, 3)],
  };
  const pie = { name: "Pie", stepGroups: [ovenGroup("bake", 120, 425, 50)] };
  const rolls = { name: "Rolls", stepGroups: [ovenGroup("bake", 20, 350, 15)] };

  const assert_one_oven_conflict = assert(() => {
    const plan = planOvens([turkey, pie, rolls], [OVEN]);
    const c = plan.conflicts[0];
    return plan.conflicts.length === 1 && c.dish === "Pie" &&
      c.with.join() === "Turkey" &&
      c.reason === "Oven 1 has Turkey at 325°F." &&
      plan.events.find((e) => e.dish === "Pie")?.oven === null &&
      // Rolls go in after the turkey is out at 60 minutes.
      plan.events.find((e) => e.dish === "Rolls")?.oven === 0;
  });

  const assert_second_oven_resolves = assert(() => {
    const plan = planOvens([turkey, pie, rolls], [OVEN, OVEN]);
    return plan.conflicts.length === 0 &&
      plan.events.find((e) => e.dish === "Pie")?.oven === 1;
  });

  // A first-come plan would put the rolls in the big oven and strand the
  // turkey; the search finds the plan with no conflict.
  const assert_search_beats_greedy = assert(() => {
    const big = { rackPositions: 5, physicalRacks: 2 };
    const small = { rackPositions: 3, physicalRacks: 1 };
    const rollsFirst = {
      name: "Rolls",
      stepGroups: [ovenGroup("bake", 300, 325, 30)],
    };
    const bird = {
      name: "Turkey",
      stepGroups: [ovenGroup("roast", 290, 325, 200, {}, 5)],
    };
    const a = planOvens([rollsFirst, bird], [big, small]);
    const one = { rackPositions: 5, physicalRacks: 1 };
    const two = { rackPositions: 5, physicalRacks: 2 };
    const b = planOvens([
      { name: "Pie", stepGroups: [ovenGroup("p", 120, 425, 60)] },
      { name: "Casserole", stepGroups: [ovenGroup("c", 110, 350, 60)] },
      { name: "Bread", stepGroups: [ovenGroup("b", 100, 425, 60)] },
    ], [one, two]);
    return a.conflicts.length === 0 &&
      a.events.find((e) => e.dish === "Turkey")?.oven === 0 &&
      b.conflicts.length === 0;
  });

  const assert_late_warning = assert(() =>
    planOvens([{ name: "Gravy", stepGroups: [ovenGroup("g", 10, 350, 50)] }], [
      OVEN,
    ]).warnings.join() === "Gravy (g) comes out 40m after serving."
  );

  // The export keeps every oven problem the panel shows: a late dish, and a
  // group off the day's timeline.
  const assert_markdown_keeps_oven_problems = assert(() => {
    const md = mealMarkdown({
      name: "Dinner",
      date: "",
      time: "18:00",
      guestCount: 4,
      recipes: [],
      preparedFoods: [],
      guests: [],
      ovenPlan: planOvens([
        { name: "Gravy", stepGroups: [ovenGroup("g", 10, 350, 50)] },
        { name: "Bread", stepGroups: [ovenGroup("dough", undefined, 400, 30)] },
      ], [OVEN]),
      notes: "",
    });
    return md.includes(
      "- Warning: Gravy (g) comes out 40m after serving.",
    ) &&
      md.includes(
        "- Not on the timeline: Bread (dough) is not scheduled (set its minutes before serving)",
      );
  });

  const assert_touching_is_not_overlap = assert(() => {
    // The first comes out at 60 exactly as the second goes in.
    const a = { name: "A", stepGroups: [ovenGroup("a", 120, 325, 60)] };
    const b = { name: "B", stepGroups: [ovenGroup("b", 60, 450, 30)] };
    return planOvens([a, b], [OVEN]).conflicts.length === 0;
  });

  const assert_no_oven = assert(() =>
    planOvens([pie], [])
      .conflicts[0]?.reason === "No oven is set up."
  );

  const assert_timeline_layout = assert(() => {
    const t = timeline(planOvens([turkey, pie], [OVEN]), "17:00");
    const t0 = t.rows.find((r) => r.dish === "Turkey");
    const p = t.rows.find((r) => r.dish === "Pie");
    return t.axis.join("|") === "12:00 PM|2:30 PM|5:00 PM" &&
      t0?.left === 0 && t0.width === 80 && !t0.conflict &&
      p?.left === 60 && p.conflict && p.ovenLabel === "No oven" &&
      p.when === "3:00 PM – 3:50 PM";
  });

  const assert_time_words = assert(() =>
    formatBefore(150) === "2h 30m before" &&
    formatBefore(0) === "serving" &&
    formatBefore(-15) === "15m after" &&
    clockAt("18:00", 90) === "4:30 PM" &&
    clockAt("01:00", 120) === "11:00 PM (day before)" &&
    clockAt("", 30) === ""
  );

  const assert_oven_field_clamped = assert(() =>
    withOvenField(OVEN, "rackPositions", "9").rackPositions === 7 &&
    withOvenField(OVEN, "physicalRacks", "0").physicalRacks === 1 &&
    withOvenField(OVEN, "physicalRacks", "abc").physicalRacks === 2
  );

  const assert_balance = assert(() => {
    const b = mealBalance([
      { name: "Turkey", servings: 10, category: "main" },
      { name: "Stuffing", servings: 4, category: "side" },
      { name: "Beans", servings: 4, category: "side" },
      { name: "Pie", servings: 6, category: "dessert" },
      { name: "Odd", servings: 2, category: "nonsense" as never },
    ], 8);
    return b.categories.map((c) => `${c.category}:${c.dishes}:${c.servings}`)
          .join() === "main:1:10,side:2:8,dessert:1:6,other:1:2" &&
      b.totalServings === 26 &&
      b.warnings.join("|") === "Desserts serve 6 for 8 guests." &&
      mealBalance([{ name: "Pie", servings: 8, category: "dessert" }], 8)
          .warnings.join() === "No main dish yet.";
  });

  const assert_requirement_fit = assert(() => {
    const salad = {
      ...dish("Salad", "side", ["vegan"], {
        primaryIngredients: ["lettuce", "mushrooms"],
        warnings: ["Contains walnuts"],
      }),
      ingredients: ["romaine lettuce", "mushrooms", "olive oil", "eggplant"],
    };
    return requirementFit(salad, "Vegetarian") === "fits" &&
      requirementFit(salad, "no mushroom") === "conflicts" &&
      requirementFit(salad, "no-walnuts") === "conflicts" &&
      // One ingredient, and the full list is known: absent means it fits.
      requirementFit(salad, "no-cilantro") === "fits" &&
      // Whole words: eggplant is not egg, and egg is a class anyway.
      requirementFit(salad, "no-eggs") === "fits" &&
      requirementFit({
          ...salad,
          dietaryCompatibility: {
            ...salad.dietaryCompatibility,
            compatible: [],
          },
        }, "no-eggs") === "unknown" &&
      requirementFit(salad, "gluten-free") === "unknown" &&
      requirementFit(
          dish("Bread", "bread", [], { incompatible: ["gluten-free"] }),
          "gluten free",
        ) === "conflicts" &&
      // Declared "no-x" tags and "x-free" are the same need.
      requirementFit(dish("Rolls", "bread", ["dairy-free"]), "no-dairy") ===
        "fits" &&
      // Not analyzed: unknown, whatever its lists say.
      requirementFit(dish("Stew", "main", ["vegan"], {}, "none"), "vegan") ===
        "unknown" &&
      // No ingredient list: "no-x" stays unknown.
      requirementFit(dish("Cake", "dessert", []), "no-cilantro") ===
        "unknown";
  });

  // Each of these once read as "fits": unknown must never read as safe.
  const assert_no_false_fits = assert(() => {
    const custard = {
      ...dish("Custard", "dessert", [], {
        incompatible: ["egg-free"],
        primaryIngredients: ["custard", "milk"],
      }),
      ingredients: ["milk", "sugar", "vanilla"],
    };
    const pecanPie = {
      ...dish("Pecan Pie", "dessert", [], {
        primaryIngredients: ["pecans", "butter", "corn syrup"],
      }),
      ingredients: ["pecans", "butter", "corn syrup", "flour"],
    };
    const cheesy = {
      ...dish("Gratin", "side", [], { primaryIngredients: ["cheeses"] }),
      ingredients: ["potatoes", "cheeses"],
    };
    const rolls = dish("Rolls", "bread", [], {
      primaryIngredients: ["rolls"],
    }, "declared");
    return requirementFit(custard, "no-eggs") === "conflicts" &&
      requirementFit(custard, "no eggs") === "conflicts" &&
      requirementFit(pecanPie, "no-nuts") === "unknown" &&
      requirementFit(pecanPie, "no-dairy") === "unknown" &&
      requirementFit(cheesy, "no-cheese") === "conflicts" &&
      // A prepared food lists no ingredients in full.
      requirementFit(rolls, "no-mushrooms") === "unknown" &&
      // Not "pea" in "peanut".
      requirementFit(pecanPie, "no-peas") === "fits" &&
      tagFor("no nuts") === "nut-free" &&
      tagFor("no-mushrooms") === "no-mushrooms" &&
      tagFor("Vegan") === "vegan";
  });

  const assert_dietary_checks = assert(() => {
    const checks = dietaryChecks([
      dish("Turkey", "main", [], { incompatible: ["vegan"] }),
      dish("Pie", "dessert", ["vegan"], {}, "stale"),
      dish("Rolls", "bread", [], {}, "declared"),
    ], [
      { guestName: "Sam", requirements: ["Vegan", "vegan"] },
      { guestName: "", requirements: ["no-lamb"] },
    ]);
    const [sam, other] = checks;
    return checks.length === 2 &&
      sam.fits.join() === "Pie (out of date)" &&
      sam.conflicts.join() === "Turkey" &&
      sam.unknown.join() === "Rolls" &&
      // The only fit is out of date, so it does not clear the warning.
      sam.warning ===
        "Only out-of-date analyses say something suits Sam (vegan): re-analyze." &&
      other.guest === "Guest 2" &&
      other.warning ===
        "Nothing on the menu is known to suit Guest 2 (no-lamb).";
  });

  const assert_plan_linking = assert(() => {
    const steps = planLinking({
      items: [
        // Matched, case aside, among the prepared foods though called a
        // recipe.
        {
          name: "Rotisserie chicken",
          type: "recipe",
          existingName: "costco rotisserie chicken",
          quote: "chicken",
        },
        {
          name: "Green Beans",
          type: "recipe",
          existingName: "",
          quote: "beans",
          category: "veg",
          servings: 0,
        },
        { name: "Turkey", type: "recipe", existingName: "", quote: "turkey" },
        { name: "Rolls", type: "prepared", existingName: "", quote: "rolls" },
        { name: "rolls", type: "prepared", existingName: "", quote: "Rolls" },
      ],
      unchecked: [3],
      libraryRecipes: ["Mashed Potatoes", "Green Beans"],
      libraryPrepared: ["Costco Rotisserie Chicken"],
      inMeal: ["Turkey"],
    });
    const [chicken, beans, turkeyStep, rollsStep, again] = steps;
    return chicken.kind === "link" && chicken.type === "prepared" &&
      chicken.index === 0 && chicken.name === "Costco Rotisserie Chicken" &&
      // No match named, but a recipe has exactly its name: linked, not
      // created again.
      beans.kind === "link" && beans.type === "recipe" && beans.index === 1 &&
      turkeyStep.kind === "skip" &&
      turkeyStep.reason === "already in the meal" &&
      rollsStep.kind === "skip" && rollsStep.reason === "unchecked" &&
      // The unchecked one does not block a repeat from being created.
      again.kind === "create" && again.type === "prepared";
  });

  const assert_create_clamps = assert(() => {
    const [made] = planLinking({
      items: [{
        name: "Succotash",
        type: "recipe",
        existingName: "",
        quote: "succotash",
        category: "veg",
        servings: 0,
      }],
      unchecked: [],
      libraryRecipes: [],
      libraryPrepared: [],
      inMeal: [],
    });
    return made.kind === "create" && made.category === "other" &&
      made.servings === 4;
  });

  return {
    [TESTS]: [
      { assertion: assert_events_and_off_timeline },
      { assertion: assert_markdown_keeps_oven_problems },
      { assertion: assert_load_rules },
      { assertion: assert_one_oven_conflict },
      { assertion: assert_second_oven_resolves },
      { assertion: assert_search_beats_greedy },
      { assertion: assert_late_warning },
      { assertion: assert_touching_is_not_overlap },
      { assertion: assert_no_oven },
      { assertion: assert_timeline_layout },
      { assertion: assert_time_words },
      { assertion: assert_oven_field_clamped },
      { assertion: assert_balance },
      { assertion: assert_requirement_fit },
      { assertion: assert_no_false_fits },
      { assertion: assert_dietary_checks },
      { assertion: assert_plan_linking },
      { assertion: assert_create_clamps },
    ],
  };
});
