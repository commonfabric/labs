/**
 * Folksonomy Stress Test - Performance Testing at Scale
 *
 * Deployable pattern that pre-loads the aggregator with large event sets
 * and lets you feel the typing latency firsthand, while displaying
 * timing instrumentation.
 *
 * Deploy:
 *   deno task cf piece new \
 *     patterns/dev/experimental/folksonomy-stress-test.tsx
 *
 * HOW TO USE:
 * 1. Click a scale button (100, 500, 1K, 5K, 10K) to load synthetic events
 * 2. Observe the generation and load timing
 * 3. Type in the autocomplete below to feel suggestion latency
 * 4. Compare latency across scales to identify performance cliffs
 */
import {
  Cell,
  computed,
  handler,
  NAME,
  pattern,
  UI,
  Writable,
} from "commonfabric";
import AggregatorPattern from "./folksonomy-aggregator.tsx";
import { FolksonomyTags } from "./folksonomy-tags.tsx";

interface TagEvent {
  scope: string;
  tag: string;
  action: "add" | "use" | "remove";
  timestamp: number;
}

interface CommunityTagSuggestion {
  tag: string;
  count: number;
}

// Word pools for realistic synthetic data
const TAG_WORDS = [
  "vegetarian",
  "quick",
  "easy",
  "italian",
  "mexican",
  "breakfast",
  "dessert",
  "healthy",
  "spicy",
  "gluten-free",
  "vegan",
  "comfort-food",
  "budget",
  "meal-prep",
  "one-pot",
  "grilled",
  "baked",
  "seasonal",
  "holiday",
  "snack",
  "appetizer",
  "soup",
  "salad",
  "pasta",
  "seafood",
  "chicken",
  "beef",
  "pork",
  "tofu",
  "rice",
  "noodles",
  "curry",
  "stir-fry",
  "slow-cooker",
  "instant-pot",
  "fermented",
  "pickled",
  "smoked",
  "roasted",
  "steamed",
  "raw",
  "frozen",
  "organic",
  "local",
  "farm-to-table",
  "keto",
  "paleo",
  "mediterranean",
  "asian",
  "french",
  "indian",
  "thai",
  "japanese",
  "korean",
  "middle-eastern",
  "african",
  "caribbean",
  "southern",
  "tex-mex",
  "fusion",
  "street-food",
  "brunch",
  "lunch",
  "dinner",
  "party",
  "potluck",
  "date-night",
  "kids",
  "beginner",
  "advanced",
  "under-30-min",
  "under-15-min",
  "overnight",
  "no-cook",
  "five-ingredient",
  "dairy-free",
  "nut-free",
  "egg-free",
  "soy-free",
  "low-sodium",
  "high-protein",
  "low-carb",
  "high-fiber",
  "antioxidant",
  "probiotic",
  "immune-boost",
  "energy",
  "recovery",
  "chocolate",
  "vanilla",
  "cinnamon",
  "garlic",
  "lemon",
  "ginger",
  "basil",
  "cilantro",
  "mint",
  "rosemary",
  "thyme",
  "oregano",
  "cumin",
  "turmeric",
  "chili",
  "honey",
  "maple",
  "coconut",
  "avocado",
  "sweet-potato",
  "quinoa",
  "lentils",
  "chickpeas",
  "black-beans",
  "spinach",
  "kale",
  "broccoli",
  "mushroom",
  "tomato",
  "onion",
  "pepper",
  "eggplant",
  "zucchini",
  "squash",
  "cauliflower",
  "cabbage",
  "carrot",
  "beet",
  "corn",
  "peas",
  "artichoke",
  "asparagus",
  "celery",
  "cucumber",
  "radish",
  "turnip",
  "parsnip",
  "fennel",
  "leek",
  "shallot",
  "scallion",
  "watercress",
  "arugula",
  "endive",
  "radicchio",
  "chard",
  "collard",
  "mustard-greens",
  "bok-choy",
  "napa-cabbage",
  "daikon",
  "jicama",
  "plantain",
  "yuca",
  "taro",
  "breadfruit",
  "jackfruit",
  "tempeh",
  "seitan",
  "miso",
  "tahini",
  "harissa",
  "gochujang",
  "sriracha",
  "sambal",
  "chimichurri",
  "pesto",
  "salsa-verde",
  "romesco",
  "aioli",
  "tzatziki",
  "hummus",
  "guacamole",
  "chutney",
  "relish",
  "compote",
  "coulis",
  "gastrique",
  "demi-glace",
  "bechamel",
  "hollandaise",
  "veloute",
  "roux",
  "fond",
  "consomme",
  "bisque",
  "chowder",
  "gumbo",
  "stew",
  "tagine",
  "ragu",
  "bolognese",
  "carbonara",
  "puttanesca",
  "arrabiata",
  "alfredo",
  "primavera",
  "risotto",
  "polenta",
  "gnocchi",
  "ravioli",
  "lasagna",
  "macaroni",
  "penne",
];

const SCOPE_WORDS = [
  "recipe-tracker",
  "meal-planner",
  "cookbook",
  "food-blog",
  "grocery-list",
  "restaurant-reviews",
  "wine-journal",
  "kitchen-inventory",
  "diet-log",
  "cooking-class",
  "garden-planner",
  "farmers-market",
  "food-photography",
  "nutrition-tracker",
  "baking-journal",
  "fermentation-log",
  "spice-rack",
  "tea-collection",
  "coffee-notes",
  "cocktail-recipes",
  "canning-tracker",
  "sourdough-log",
  "bbq-journal",
  "sushi-notes",
  "pizza-diary",
  "bread-baking",
  "pastry-notes",
  "cheese-journal",
  "chocolate-tasting",
  "olive-oil-notes",
  "herb-garden",
  "mushroom-foraging",
  "fish-market",
  "butcher-notes",
  "deli-tracker",
  "pantry-organizer",
  "freezer-inventory",
  "leftovers-log",
  "potluck-planner",
  "holiday-cooking",
  "camping-meals",
  "travel-eats",
  "street-food-log",
  "food-truck-finder",
  "tasting-menu",
  "supper-club",
  "cooking-challenge",
  "recipe-swap",
  "ingredient-sourcing",
  "kitchen-equipment",
  "cookbook-collection",
  "food-science",
  "flavor-pairing",
  "menu-planning",
  "catering-notes",
  "food-styling",
  "recipe-development",
  "taste-testing",
  "food-preservation",
  "dehydrator-log",
  "smoker-journal",
  "wok-cooking",
  "cast-iron-care",
  "knife-sharpening",
  "sous-vide-log",
  "pressure-cooking",
  "air-fryer-notes",
  "dutch-oven-recipes",
  "griddle-cooking",
  "plancha-notes",
  "tandoor-journal",
  "clay-pot-cooking",
  "bamboo-steamer",
  "mortar-pestle",
  "mandoline-cuts",
  "pasta-machine",
  "ice-cream-maker",
  "food-processor",
  "stand-mixer",
  "immersion-blender",
  "thermometer-log",
  "scale-measurements",
  "timer-presets",
  "oven-calibration",
  "grill-temps",
  "humidity-control",
  "altitude-adjustments",
  "water-quality",
  "flour-types",
  "sugar-varieties",
  "salt-selection",
  "oil-smoke-points",
  "vinegar-notes",
  "stock-making",
  "bone-broth",
  "dashi-notes",
  "court-bouillon",
  "fumet-log",
  "reduction-notes",
  "emulsion-tips",
  "gelatin-work",
  "agar-experiments",
];

/** Pick n items from a word pool, cycling if needed */
function pickWords(pool: string[], n: number): string[] {
  const result: string[] = [];
  for (let i = 0; i < n; i++) {
    result.push(pool[i % pool.length]);
  }
  return result;
}

/**
 * Generate synthetic tag events with Zipf-like tag popularity.
 * Lower-index tags are more popular (quadratic distribution).
 * Uses real words for tags and scopes.
 */
function generateEvents(
  count: number,
  scopeCount: number,
  tagsPerScope: number,
): TagEvent[] {
  const events: TagEvent[] = [];
  const scopes = pickWords(SCOPE_WORDS, scopeCount);
  const tags = pickWords(TAG_WORDS, tagsPerScope);

  for (let i = 0; i < count; i++) {
    // Zipf-like: lower-index tags are much more likely
    const tagIndex = Math.floor(Math.pow(Math.random(), 2) * tagsPerScope);
    events.push({
      scope: scopes[i % scopeCount],
      tag: tags[tagIndex],
      action: Math.random() > 0.1 ? "add" : "remove", // 90% adds
      timestamp: Date.now() - (count - i) * 1000,
    });
  }
  return events;
}

// Handler to load events at a specific scale
const loadScale = handler<
  void,
  {
    eventsCell: Cell<TagEvent[]>;
    count: number;
    scopeCount: number;
    tagsPerScope: number;
    statusText: Writable<string>;
    genMs: Writable<number>;
    loadMs: Writable<number>;
    loadedCount: Writable<number>;
    loadedScopes: Writable<number>;
    loadedTags: Writable<number>;
  }
>(
  (
    _event,
    {
      eventsCell,
      count,
      scopeCount,
      tagsPerScope,
      statusText,
      genMs,
      loadMs,
      loadedCount,
      loadedScopes,
      loadedTags,
    },
  ) => {
    const t0 = Date.now();
    const generated = generateEvents(count, scopeCount, tagsPerScope);
    const t1 = Date.now();

    eventsCell.set(generated);
    const t2 = Date.now();

    statusText.set(
      `Loaded ${count.toLocaleString()} events (${scopeCount} scopes, ${tagsPerScope} tags/scope)`,
    );
    genMs.set(Math.round(t1 - t0));
    loadMs.set(Math.round(t2 - t1));
    loadedCount.set(count);
    loadedScopes.set(scopeCount);
    loadedTags.set(tagsPerScope);
  },
);

// Handler to clear all events
const clearAll = handler<
  void,
  {
    eventsCell: Cell<TagEvent[]>;
    statusText: Writable<string>;
    genMs: Writable<number>;
    loadMs: Writable<number>;
    loadedCount: Writable<number>;
  }
>((_event, { eventsCell, statusText, genMs, loadMs, loadedCount }) => {
  eventsCell.set([]);
  statusText.set("Cleared");
  genMs.set(0);
  loadMs.set(0);
  loadedCount.set(0);
});

export default pattern(() => {
  // Core state
  const eventsCell = new Cell<TagEvent[]>([]);
  const aggregator = AggregatorPattern({ events: eventsCell });

  // Timing state
  const statusText = new Writable(
    "Ready - click a scale button to load events",
  );
  const genMs = new Writable(0);
  const loadMs = new Writable(0);
  const loadedCount = new Writable(0);
  const loadedScopes = new Writable(0);
  const loadedTags = new Writable(0);

  // Suggestion statistics derived from aggregator output
  const scopesWithSuggestions = computed(() => {
    const suggs = (aggregator.suggestions || {}) as Record<
      string,
      CommunityTagSuggestion[]
    >;
    return Object.keys(suggs).length;
  });

  const totalSuggestions = computed(() => {
    const suggs = (aggregator.suggestions || {}) as Record<
      string,
      CommunityTagSuggestion[]
    >;
    let total = 0;
    for (const scopeSuggs of Object.values(suggs)) {
      total += scopeSuggs.length;
    }
    return total;
  });

  const uniqueTagCount = computed(() => {
    const suggs = (aggregator.suggestions || {}) as Record<
      string,
      CommunityTagSuggestion[]
    >;
    const tags = new Set<string>();
    for (const scopeSuggs of Object.values(suggs)) {
      for (const s of scopeSuggs) tags.add(s.tag);
    }
    return tags.size;
  });

  const maxSuggestionsPerScope = computed(() => {
    const suggs = (aggregator.suggestions || {}) as Record<
      string,
      CommunityTagSuggestion[]
    >;
    let max = 0;
    for (const scopeSuggs of Object.values(suggs)) {
      if (scopeSuggs.length > max) max = scopeSuggs.length;
    }
    return max;
  });

  const avgSuggestionsPerScope = computed(() => {
    const suggs = (aggregator.suggestions || {}) as Record<
      string,
      CommunityTagSuggestion[]
    >;
    const scopes = Object.keys(suggs);
    if (scopes.length === 0) return 0;
    let total = 0;
    for (const scopeSuggs of Object.values(suggs)) {
      total += scopeSuggs.length;
    }
    return Math.round(total / scopes.length);
  });

  // Interactive typing test - uses first scope which gets events in all scales
  const testScope = new Writable("recipe-tracker");
  const testTags = new Writable<string[]>([]);
  const tagsInstance = FolksonomyTags({
    scope: testScope,
    tags: testTags,
    aggregator,
  });

  // Scale configurations
  const scales = [
    { count: 100, scopeCount: 10, tagsPerScope: 20, label: "100" },
    { count: 500, scopeCount: 10, tagsPerScope: 50, label: "500" },
    { count: 1000, scopeCount: 20, tagsPerScope: 50, label: "1K" },
    { count: 5000, scopeCount: 50, tagsPerScope: 100, label: "5K" },
    { count: 10000, scopeCount: 100, tagsPerScope: 200, label: "10K" },
  ];

  // Create handler bindings for each scale
  const loadActions = scales.map((s) =>
    loadScale({
      eventsCell,
      count: s.count,
      scopeCount: s.scopeCount,
      tagsPerScope: s.tagsPerScope,
      statusText,
      genMs,
      loadMs,
      loadedCount,
      loadedScopes,
      loadedTags,
    })
  );

  const clearAction = clearAll({
    eventsCell,
    statusText,
    genMs,
    loadMs,
    loadedCount,
  });

  const metricStyle = {
    padding: "12px",
    background: "#f9fafb",
    borderRadius: "8px",
    flex: "1",
    minWidth: "100px",
  };
  const metricValue = { fontSize: "20px", fontWeight: "bold" };
  const metricLabel = { fontSize: "11px", color: "#6b7280" };

  return {
    [NAME]: "Folksonomy Stress Test",
    [UI]: (
      <cf-vstack gap="4" style={{ padding: "16px", maxWidth: "800px" }}>
        <cf-vstack gap="1">
          <h2 style={{ margin: "0" }}>Folksonomy Performance Test</h2>
          <p style={{ color: "#6b7280", margin: "0", fontSize: "13px" }}>
            Load synthetic events at scale and test typing latency in the
            autocomplete below.
          </p>
        </cf-vstack>

        {/* Scale buttons */}
        <cf-vstack gap="2">
          <span
            style={{
              fontWeight: "600",
              fontSize: "13px",
              textTransform: "uppercase",
              color: "#6b7280",
            }}
          >
            Load Scale
          </span>
          <cf-hstack gap="2" wrap>
            {scales.map((s, i) => (
              <button
                key={i}
                type="button"
                onClick={loadActions[i]}
                style={{
                  padding: "8px 16px",
                  borderRadius: "6px",
                  border: "1px solid #d1d5db",
                  background: "#f9fafb",
                  cursor: "pointer",
                  fontSize: "13px",
                  fontWeight: "500",
                }}
              >
                {s.label}
              </button>
            ))}
            <button
              type="button"
              onClick={clearAction}
              style={{
                padding: "8px 16px",
                borderRadius: "6px",
                border: "1px solid #fca5a5",
                background: "#fef2f2",
                cursor: "pointer",
                fontSize: "13px",
                color: "#991b1b",
              }}
            >
              Clear
            </button>
          </cf-hstack>
        </cf-vstack>

        {/* Status + timing */}
        <cf-vstack
          gap="2"
          style={{
            padding: "12px",
            background: "#f0f9ff",
            borderRadius: "8px",
          }}
        >
          <span style={{ fontWeight: "600", fontSize: "14px" }}>
            {statusText}
          </span>
          <cf-hstack gap="3" wrap>
            <cf-vstack style={metricStyle}>
              <span style={metricValue}>
                {genMs}
                <span style={{ fontSize: "12px", fontWeight: "normal" }}>
                  ms
                </span>
              </span>
              <span style={metricLabel}>Event generation</span>
            </cf-vstack>
            <cf-vstack style={metricStyle}>
              <span style={metricValue}>
                {loadMs}
                <span style={{ fontSize: "12px", fontWeight: "normal" }}>
                  ms
                </span>
              </span>
              <span style={metricLabel}>Cell set (load)</span>
            </cf-vstack>
            <cf-vstack style={metricStyle}>
              <span style={metricValue}>{loadedCount}</span>
              <span style={metricLabel}>Events loaded</span>
            </cf-vstack>
          </cf-hstack>
        </cf-vstack>

        {/* Aggregator output stats */}
        <cf-vstack
          gap="2"
          style={{
            padding: "12px",
            background: "#f0fdf4",
            borderRadius: "8px",
          }}
        >
          <span
            style={{
              fontWeight: "600",
              fontSize: "13px",
              textTransform: "uppercase",
              color: "#6b7280",
            }}
          >
            Aggregator Output
          </span>
          <cf-hstack gap="3" wrap>
            <cf-vstack style={metricStyle}>
              <span style={metricValue}>{scopesWithSuggestions}</span>
              <span style={metricLabel}>Scopes</span>
            </cf-vstack>
            <cf-vstack style={metricStyle}>
              <span style={metricValue}>{totalSuggestions}</span>
              <span style={metricLabel}>Total suggestions</span>
            </cf-vstack>
            <cf-vstack style={metricStyle}>
              <span style={metricValue}>{uniqueTagCount}</span>
              <span style={metricLabel}>Unique tags</span>
            </cf-vstack>
            <cf-vstack style={metricStyle}>
              <span style={metricValue}>{maxSuggestionsPerScope}</span>
              <span style={metricLabel}>Max / scope</span>
            </cf-vstack>
            <cf-vstack style={metricStyle}>
              <span style={metricValue}>{avgSuggestionsPerScope}</span>
              <span style={metricLabel}>Avg / scope</span>
            </cf-vstack>
          </cf-hstack>
        </cf-vstack>

        {/* Interactive typing test */}
        <cf-vstack
          gap="2"
          style={{
            padding: "12px",
            background: "#faf5ff",
            borderRadius: "8px",
            border: "1px solid #e9d5ff",
          }}
        >
          <span
            style={{
              fontWeight: "600",
              fontSize: "13px",
              textTransform: "uppercase",
              color: "#6b7280",
            }}
          >
            Try typing below (scope: recipe-tracker)
          </span>
          <p style={{ margin: "0", fontSize: "12px", color: "#9ca3af" }}>
            Load events above, then type here to feel the autocomplete latency.
            Community suggestions from the aggregator appear as you type.
          </p>
          <cf-render $cell={tagsInstance} />
        </cf-vstack>

        {/* Explanation */}
        <div
          style={{
            padding: "12px",
            background: "#fffbeb",
            border: "1px solid #fef08a",
            borderRadius: "8px",
            fontSize: "12px",
            color: "#92400e",
          }}
        >
          <strong>What to look for:</strong>{" "}
          Event generation and cell set times measure data loading overhead. The
          real bottleneck is the O(n) suggestion recomputation in the
          aggregator, which runs when events change. At 5K+ events, you may
          notice lag when the autocomplete items list updates. The autocomplete
          typing itself is purely internal Lit state and should remain fast.
        </div>
      </cf-vstack>
    ),
    loadedCount,
    genMs,
    loadMs,
  };
});
