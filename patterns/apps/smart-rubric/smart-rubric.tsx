/**
 * Smart Rubric — weigh options against a weighted rubric.
 *
 * Define dimensions (categorical, with a scored scale, or numeric, with a
 * range) and give each a weight. Add the options you are choosing between,
 * set each option's value on every dimension, and the options rank themselves
 * by weighted score. Nudge an option up or down to override the ranking by
 * hand; "Reset Manual Ranks" goes back to pure score order. Quick Add asks an
 * LLM to read a free-text description ("2br in the Mission, $2100/mo") and
 * propose the option's name and dimension values, which you review before
 * adding.
 *
 * Ported from jkomoros/community-patterns (`smart-rubric.tsx`). Changes from
 * the original:
 * - The "Ranked Options" list now actually ranks by score. The original kept
 *   insertion order and only computed the score beside each option.
 * - Numeric values are normalized onto the same 0–10 scale as the default
 *   categorical scale, so a 0–100 dimension no longer outweighs every
 *   categorical one by ten times.
 * - Real "add option" and "add dimension" forms with names, and remove
 *   buttons, replace the prototype's "Add Test Option/Dimension" buttons.
 *   Names are kept unique, since values and selection are keyed by name.
 * - Quick Add values are checked against the rubric before they are added:
 *   unknown dimensions are dropped, category labels matched exactly, numbers
 *   clamped to range.
 * - Numeric dimensions can be "lower is better" (rent, commute), which the
 *   original could not express, and their range is editable: the original
 *   fixed every UI-made numeric dimension at 0–100, so a rent of $2,100
 *   clamped to 100.
 * - A ▲/▼ nudge pins only the option moved, at its new slot; the rest keep
 *   ranking by score around it. The original's manual rank froze the order.
 * - Quick Add can be cancelled while it runs and its error dismissed while
 *   keeping the description, and the description is not re-sent when
 *   dimensions change while a proposal is shown.
 * - Weights step by 0.5 between 0 and 10 (0 ignores a dimension); the
 *   original's 0.1 floor made the sequence 1 → 0.5 → 0.1 → 0.6.
 * - The selection, the quick-add prompt and the form drafts are per-session UI
 *   state rather than stored inputs.
 */
import {
  action,
  computed,
  Default,
  FS,
  generateObject,
  NAME,
  pattern,
  type PerSpace,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CategoryOption {
  /** "Downtown", "Excellent". */
  label: string;
  /** Points this label earns before weighting. */
  score: number;
}

export type DimensionType = "categorical" | "numeric";

export interface Dimension {
  /** Unique within the rubric; option values refer to it by name. */
  name: string;
  type: DimensionType;
  /** The weight the dimension's score is multiplied by. */
  multiplier: number;
  /** The scale of a categorical dimension. */
  categories: CategoryOption[];
  numericMin: number;
  numericMax: number;
  /** For a numeric dimension: whether a larger number is better (the
   * default) or worse, as with price. */
  higherIsBetter?: boolean;
}

export interface OptionValue {
  dimensionName: string;
  /** A category label, or a number within the dimension's range. */
  value: string | number;
}

export interface RubricOption {
  /** Unique within the rubric. */
  name: string;
  values: OptionValue[];
  /** Position set by hand (1 = top), or null to rank by score. */
  manualRank: number | null;
}

/** What the LLM is asked to return for a Quick Add description. */
export interface QuickAddResponse {
  optionName: string;
  extractedValues: Array<{
    dimensionName: string;
    value: string | number;
    confidence: "high" | "medium" | "low";
  }>;
  reasoning: string;
}

export interface RankedOption {
  name: string;
  score: number;
  /** The score as shown, one decimal. */
  scoreLabel: string;
  /** 1-based place in the displayed ranking. */
  position: number;
  isFirst: boolean;
  isLast: boolean;
  /** Placed by hand somewhere other than where its score would put it. */
  movedByHand: boolean;
}

export interface QuickAddValue {
  dimensionName: string;
  value: string | number;
  confidence: string;
  /** The confidence's colour in the preview. */
  color: string;
}

/** The option Quick Add proposes, after checking it against the rubric. */
export interface QuickAddPreview {
  /** False until a usable answer has arrived. */
  ready: boolean;
  name: string;
  reasoning: string;
  values: QuickAddValue[];
}

export type QuickAddStatus = "idle" | "pending" | "error" | "ready";

// ---------------------------------------------------------------------------
// Rubric rules. Pure functions, so the derived views, the actions and the
// tests all agree.
// ---------------------------------------------------------------------------

/** Every dimension scores on 0..TOP_SCORE before weighting. */
const TOP_SCORE = 10;

export const DEFAULT_CATEGORIES: CategoryOption[] = [
  { label: "Excellent", score: 10 },
  { label: "Good", score: 7 },
  { label: "Fair", score: 4 },
  { label: "Poor", score: 1 },
];

const WEIGHT_STEP = 0.5;
const MAX_WEIGHT = 10;

const clamp = (n: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, n));

const valueFor = (
  option: RubricOption,
  dimensionName: string,
): string | number | undefined =>
  option.values.find((v) => v.dimensionName === dimensionName)?.value;

/** A dimension's unweighted score for a value: the category's points, or a
 * number's place in its range mapped onto 0..10. Missing values score 0. */
export const dimensionScore = (
  dim: Dimension,
  value: string | number | undefined,
): number => {
  if (value === undefined || value === "") return 0;
  if (dim.type === "categorical") {
    return dim.categories.find((c) => c.label === value)?.score ?? 0;
  }
  const n = Number(value);
  const span = dim.numericMax - dim.numericMin;
  if (!Number.isFinite(n) || span <= 0) return 0;
  const fraction = clamp((n - dim.numericMin) / span, 0, 1);
  return (dim.higherIsBetter === false ? 1 - fraction : fraction) * TOP_SCORE;
};

/** An option's total: each dimension's score times its weight. */
export const scoreOption = (
  option: RubricOption,
  dims: readonly Dimension[],
): number =>
  dims.reduce(
    (total, dim) =>
      total + dimensionScore(dim, valueFor(option, dim.name)) * dim.multiplier,
    0,
  );

/** Score order: highest first, ties in the order the options were added. */
const byScore = (
  options: readonly RubricOption[],
  dims: readonly Dimension[],
): RubricOption[] =>
  options
    .map((option, index) => ({
      option,
      index,
      score: scoreOption(option, dims),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.option);

/** The displayed order. An option placed by hand holds the slot it was put
 * in (or the nearest free one, if the list has shrunk or two claim the same
 * slot); every other option fills the remaining slots in score order, so
 * adding or rescoring options still reorders everything not pinned. */
const displayOrder = (
  options: readonly RubricOption[],
  dims: readonly Dimension[],
): RubricOption[] => {
  const n = options.length;
  const slots: (RubricOption | undefined)[] = Array.from({ length: n });
  const pinned = options
    .filter((o) => o.manualRank != null)
    .sort((a, b) => (a.manualRank ?? 0) - (b.manualRank ?? 0));
  for (const option of pinned) {
    const want = clamp((option.manualRank ?? 1) - 1, 0, n - 1);
    let slot = want;
    while (slot < n && slots[slot]) slot++;
    if (slot >= n) {
      slot = want;
      while (slot >= 0 && slots[slot]) slot--;
    }
    slots[slot] = option;
  }
  const rest = byScore(options.filter((o) => o.manualRank == null), dims);
  return slots.map((slot) => slot ?? rest.shift()!);
};

export const rankOptions = (
  options: readonly RubricOption[],
  dims: readonly Dimension[],
): RankedOption[] => {
  const ordered = displayOrder(options, dims);
  return ordered.map((option, i) => {
    const score = scoreOption(option, dims);
    return {
      name: option.name,
      score,
      scoreLabel: score.toFixed(1),
      position: i + 1,
      isFirst: i === 0,
      isLast: i === ordered.length - 1,
      movedByHand: option.manualRank != null,
    };
  });
};

/** The options after moving `name` one place up (delta -1) or down (+1) in
 * the displayed ranking. The moved option is pinned at its new slot; the
 * option it swapped with keeps a pin only if it already had one (at the slot
 * just vacated). Everything else stays ranked by score. */
export const withOptionMoved = (
  options: readonly RubricOption[],
  dims: readonly Dimension[],
  name: string,
  delta: number,
): RubricOption[] => {
  const order = displayOrder(options, dims).map((o) => o.name);
  const from = order.indexOf(name);
  const to = from + Math.sign(delta);
  if (from < 0 || to < 0 || to >= order.length) return [...options];
  const partner = order[to];
  return options.map((o) =>
    o.name === name
      ? { ...o, manualRank: to + 1 }
      : o.name === partner && o.manualRank != null
      ? { ...o, manualRank: from + 1 }
      : o
  );
};

export const withManualRanksCleared = (
  options: readonly RubricOption[],
): RubricOption[] => options.map((o) => ({ ...o, manualRank: null }));

/** The options with `optionName`'s value on `dimensionName` set. */
export const withValue = (
  options: readonly RubricOption[],
  optionName: string,
  dimensionName: string,
  value: string | number,
): RubricOption[] =>
  options.map((o) =>
    o.name !== optionName ? o : {
      ...o,
      values: [
        ...o.values.filter((v) => v.dimensionName !== dimensionName),
        { dimensionName, value },
      ],
    }
  );

/** A tenth of a numeric dimension's range: one click of − or +. */
export const numericStep = (dim: Dimension): number =>
  (dim.numericMax - dim.numericMin) / 10;

/** A numeric value after one step; an unset value starts from the minimum. */
export const steppedValue = (
  dim: Dimension,
  current: string | number | undefined,
  direction: number,
): number => {
  const n = Number(current);
  const base = current === undefined || current === "" || !Number.isFinite(n)
    ? dim.numericMin
    : n;
  return clamp(
    base + Math.sign(direction) * numericStep(dim),
    dim.numericMin,
    dim.numericMax,
  );
};

export const withWeightChanged = (
  dims: readonly Dimension[],
  name: string,
  delta: number,
): Dimension[] =>
  dims.map((d) =>
    d.name !== name ? d : {
      ...d,
      multiplier: clamp(
        Math.round((d.multiplier + delta) / WEIGHT_STEP) * WEIGHT_STEP,
        0,
        MAX_WEIGHT,
      ),
    }
  );

/** Sets a numeric dimension's range. A bound left out (or not a number)
 * keeps its current value; a range that would not run from low to high is
 * refused, leaving the dimension as it was. Option values are kept as
 * entered: one outside the new range scores as its nearer end. */
export const withRange = (
  dims: readonly Dimension[],
  name: string,
  bounds: {
    min?: number | string | undefined;
    max?: number | string | undefined;
  },
): Dimension[] =>
  dims.map((d) => {
    if (d.name !== name || d.type !== "numeric") return d;
    const read = (v: number | string | undefined, fallback: number) => {
      const n = v === undefined || v === "" ? NaN : Number(v);
      return Number.isFinite(n) ? n : fallback;
    };
    const numericMin = read(bounds.min, d.numericMin);
    const numericMax = read(bounds.max, d.numericMax);
    return numericMin < numericMax ? { ...d, numericMin, numericMax } : d;
  });

/** `base`, or `base (2)`, `base (3)`… whichever is not yet taken. */
export const uniqueName = (base: string, taken: readonly string[]): string => {
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base} (${n})`)) n++;
  return `${base} (${n})`;
};

export const newDimension = (name: string, type: DimensionType): Dimension =>
  type === "categorical"
    ? {
      name,
      type,
      multiplier: 1,
      categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
      numericMin: 0,
      numericMax: 10,
    }
    : {
      name,
      type,
      multiplier: 1,
      categories: [],
      numericMin: 0,
      numericMax: 100,
    };

// ---------------------------------------------------------------------------
// Quick Add: the prompt and the check of the answer, as pure functions. The
// LLM call itself is the only part that needs a model.
// ---------------------------------------------------------------------------

export const buildQuickAddSystemPrompt = (
  dims: readonly Dimension[],
): string => {
  if (dims.length === 0) {
    return `You are helping fill in a decision rubric that has no dimensions yet.
Given a description of an option, give it a short, suitable name, return an
empty extractedValues list, and explain your reading in one sentence.`;
  }
  const lines = dims.map((dim) =>
    dim.type === "categorical"
      ? `- ${dim.name} (categorical): one of ${
        dim.categories.map((c) => `"${c.label}" (${c.score} pts)`).join(", ")
      }`
      : `- ${dim.name} (numeric): a number from ${dim.numericMin} to ${dim.numericMax}`
  );
  return `You are helping fill in a decision rubric.

Dimensions:
${lines.join("\n")}

Given a description of an option, return:
1. optionName: a short, suitable name for the option
2. extractedValues: a value for each dimension the description supports. Use
   the dimension names exactly; for a categorical dimension use one of its
   labels exactly; for a numeric one a number within its range. Leave out any
   dimension the description says nothing about.
3. A confidence (high, medium, low) for each value
4. reasoning: one or two sentences on how you read the description`;
};

/** The value to store for an LLM answer on `dim`, or undefined when it does
 * not fit: a categorical answer must name a label (case aside), a numeric one
 * must parse as a number and is clamped to the range. */
export const fitValue = (
  dim: Dimension,
  raw: string | number | undefined,
): string | number | undefined => {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (dim.type === "categorical") {
    const wanted = String(raw).trim().toLowerCase();
    return dim.categories.find((c) => c.label.toLowerCase() === wanted)?.label;
  }
  const digits = String(raw).replace(/[^0-9.\-]/g, "");
  const n = typeof raw === "number"
    ? raw
    : /[0-9]/.test(digits)
    ? Number(digits)
    : NaN;
  if (!Number.isFinite(n)) return undefined;
  return clamp(n, dim.numericMin, dim.numericMax);
};

const CONFIDENCE_COLORS: Record<string, string> = {
  high: "var(--cf-theme-color-success, #15803d)",
  medium: "var(--cf-theme-color-warning, #b45309)",
  low: "var(--cf-theme-color-error, #b91c1c)",
};
const UNKNOWN_CONFIDENCE_COLOR = "var(--cf-colors-gray-500, #6b7280)";

export const EMPTY_PREVIEW: QuickAddPreview = {
  ready: false,
  name: "",
  reasoning: "",
  values: [],
};

/** The LLM's answer checked against the rubric: only values for dimensions
 * that exist, and only ones that fit them. */
export const previewFromResponse = (
  response: QuickAddResponse | undefined | null,
  dims: readonly Dimension[],
): QuickAddPreview => {
  if (!response || !response.optionName) return EMPTY_PREVIEW;
  const values = (response.extractedValues ?? []).flatMap((ev) => {
    const dim = dims.find((d) => d.name === ev?.dimensionName);
    const value = dim ? fitValue(dim, ev.value) : undefined;
    const confidence = ev.confidence ?? "unknown";
    return dim && value !== undefined
      ? [{
        dimensionName: dim.name,
        value,
        confidence,
        color: CONFIDENCE_COLORS[confidence] ?? UNKNOWN_CONFIDENCE_COLOR,
      }]
      : [];
  });
  return {
    ready: true,
    name: response.optionName.trim(),
    reasoning: response.reasoning ?? "",
    values,
  };
};

export const optionFromPreview = (
  preview: QuickAddPreview,
  taken: readonly string[],
): RubricOption => ({
  name: uniqueName(preview.name || "Option", taken),
  values: preview.values.map(({ dimensionName, value }) => ({
    dimensionName,
    value,
  })),
  manualRank: null,
});

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

interface CategoryChip {
  option: string;
  dimension: string;
  label: string;
  text: string;
  active: boolean;
}

interface DetailRow {
  option: string;
  dimension: string;
  heading: string;
  isCategorical: boolean;
  categories: CategoryChip[];
  valueLabel: string;
  rangeLabel: string;
}

interface DimensionView {
  name: string;
  kind: string;
  weightLabel: string;
  scaleLabel: string;
  isNumeric: boolean;
  directionLabel: string;
  minText: string;
  maxText: string;
}

const formatValue = (value: string | number): string =>
  typeof value === "number" ? String(Math.round(value * 100) / 100) : value;

const detailRows = (
  option: RubricOption,
  dims: readonly Dimension[],
): DetailRow[] =>
  dims.map((dim) => {
    const current = valueFor(option, dim.name);
    return {
      option: option.name,
      dimension: dim.name,
      heading: `${dim.name} [${dim.type}]`,
      isCategorical: dim.type === "categorical",
      categories: dim.categories.map((c) => ({
        option: option.name,
        dimension: dim.name,
        label: c.label,
        text: `${c.label} (${c.score} pts)`,
        active: current === c.label,
      })),
      valueLabel: current === undefined || current === ""
        ? "—"
        : formatValue(current),
      rangeLabel: `(${dim.numericMin}–${dim.numericMax})`,
    };
  });

const dimensionView = (dim: Dimension): DimensionView => ({
  name: dim.name,
  kind: `[${dim.type}]`,
  weightLabel: `Weight: ${dim.multiplier.toFixed(1)}×`,
  scaleLabel: dim.type === "categorical"
    ? `Categories: ${
      dim.categories.map((c) => `${c.label}=${c.score}`).join(", ")
    }`
    : `Range: ${dim.numericMin} – ${dim.numericMax}`,
  isNumeric: dim.type === "numeric",
  directionLabel: dim.higherIsBetter === false
    ? "Lower is better"
    : "Higher is better",
  minText: String(dim.numericMin),
  maxText: String(dim.numericMax),
});

/** The rubric as markdown, for the filesystem projection. */
export const rubricMarkdown = (
  title: string,
  options: readonly RubricOption[],
  dims: readonly Dimension[],
): string => {
  const byName = new Map(options.map((o) => [o.name, o]));
  const ranking = rankOptions(options, dims).map((r) => {
    const option = byName.get(r.name);
    const values = dims
      .map((d) => {
        const v = option ? valueFor(option, d.name) : undefined;
        return v === undefined || v === ""
          ? ""
          : `${d.name}: ${formatValue(v)}`;
      })
      .filter((s) => s !== "");
    return `${r.position}. ${r.name} — ${r.scoreLabel}${
      r.movedByHand ? " (placed by hand)" : ""
    }${values.length ? ` (${values.join("; ")})` : ""}`;
  });
  const dimensionLines = dims.map((d) => {
    const view = dimensionView(d);
    return `- ${d.name} ${view.kind}, weight ${
      d.multiplier.toFixed(1)
    }× — ${view.scaleLabel}${
      view.isNumeric ? ` (${view.directionLabel.toLowerCase()})` : ""
    }`;
  });
  return [
    `# ${title}`,
    "",
    "## Ranking",
    ...(ranking.length ? ranking : ["(no options yet)"]),
    "",
    "## Dimensions",
    ...(dimensionLines.length ? dimensionLines : ["(no dimensions yet)"]),
  ].join("\n");
};

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

// Colours come from the shell's theme, with light fallbacks, so the panels
// stay readable in dark mode: a fixed light background under the theme's
// light text left the selected option's name and the Quick Add heading
// unreadable.
const BORDER = "1px solid var(--cf-theme-color-border, #e5e7eb)";
const MUTED = "var(--cf-colors-gray-500, #6b7280)";
const ACCENT = "var(--cf-theme-color-primary, #2563eb)";
const ACCENT_SURFACE = "var(--cf-theme-color-primary-light, #eff6ff)";

const styles = {
  page: {
    padding: "1rem",
    maxWidth: "1100px",
    margin: "0 auto",
    display: "flex",
    flexDirection: "column",
    gap: "1rem",
  },
  panel: {
    padding: "1rem",
    border: BORDER,
    borderRadius: "8px",
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
  },
  quickAdd: {
    padding: "1rem",
    border: `1px solid ${ACCENT}`,
    background: ACCENT_SURFACE,
    borderRadius: "8px",
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
  },
  heading: { margin: "0", fontSize: "1.05rem" },
  hint: { color: MUTED, fontSize: "0.9em", fontStyle: "italic" },
  row: { display: "flex", gap: "0.5rem", alignItems: "center" },
  grow: { flex: "1" },
  panes: {
    display: "flex",
    gap: "1rem",
    alignItems: "stretch",
    flexWrap: "wrap",
  },
  pane: {
    flex: "1 1 320px",
    padding: "1rem",
    border: BORDER,
    borderRadius: "8px",
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
  },
  optionCard: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    padding: "0.5rem 0.75rem",
    borderRadius: "6px",
  },
  arrows: { display: "flex", flexDirection: "column", gap: "2px" },
  optionName: {
    flex: "1",
    textAlign: "left",
    fontWeight: "bold",
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: "0",
    font: "inherit",
    color: "inherit",
  },
  score: { fontSize: "1.2em", fontWeight: "bold", color: ACCENT },
  card: {
    padding: "0.75rem",
    border: BORDER,
    borderRadius: "6px",
    display: "flex",
    flexDirection: "column",
    gap: "0.4rem",
  },
  cardHeading: { fontSize: "0.85em", fontWeight: "500", color: MUTED },
  chips: { display: "flex", flexWrap: "wrap", gap: "0.4rem" },
  numericValue: {
    flex: "1",
    textAlign: "center",
    fontSize: "1.1em",
    fontWeight: "bold",
  },
  small: { color: MUTED, fontSize: "0.85em" },
  preview: {
    background: "var(--cf-theme-color-surface, white)",
    padding: "0.75rem",
    borderRadius: "6px",
    border: BORDER,
    display: "flex",
    flexDirection: "column",
    gap: "0.4rem",
  },
  error: {
    color: "var(--cf-theme-color-error, #991b1b)",
    background: "var(--cf-theme-color-error-light, #fee2e2)",
    padding: "0.5rem",
    borderRadius: "6px",
  },
} as const;

// ---------------------------------------------------------------------------
// Pattern
// ---------------------------------------------------------------------------

interface RubricInput {
  title?: PerSpace<Writable<string | Default<"Decision Rubric">>>;
  options?: PerSpace<Writable<RubricOption[] | Default<[]>>>;
  dimensions?: PerSpace<Writable<Dimension[] | Default<[]>>>;
}

export interface RubricOutput {
  [NAME]: string;
  [UI]: VNode;
  [FS]: {
    type: "text/markdown";
    frontmatter: { title: string };
    content: string;
  };
  title: string;
  options: RubricOption[];
  dimensions: Dimension[];
  /** The options in displayed order, with scores. */
  ranked: RankedOption[];
  /** The selected option's name, or "". */
  selected: string;
  quickAddStatus: QuickAddStatus;
  quickAddPreview: QuickAddPreview;
  /** Add an option; an empty name falls back to the draft, then "Option N". */
  addOption: Stream<{ name?: string }>;
  removeOption: Stream<{ name: string }>;
  /** Add a dimension; an empty name falls back to the draft, then a default. */
  addDimension: Stream<{ name?: string; type: DimensionType }>;
  removeDimension: Stream<{ name: string }>;
  /** Change a dimension's weight by `delta` (steps of 0.5, 0..10). */
  changeWeight: Stream<{ name: string; delta: number }>;
  selectOption: Stream<{ name: string }>;
  /** Set an option's value on a dimension. */
  setValue: Stream<
    { option: string; dimension: string; value: string | number }
  >;
  /** Step an option's numeric value by a tenth of the range (sign of delta). */
  stepValue: Stream<{ option: string; dimension: string; delta: number }>;
  /** Move an option one place up (-1) or down (+1) in the ranking. */
  moveOption: Stream<{ name: string; delta: number }>;
  resetManualRanks: Stream<void>;
  /** Send the Quick Add description to the LLM. */
  analyzeQuickAdd: Stream<void>;
  /** Add the option Quick Add proposed. */
  acceptQuickAdd: Stream<void>;
  clearQuickAdd: Stream<void>;
  /** Cancel a pending call or dismiss its error, keeping the description. */
  dismissQuickAdd: Stream<void>;
  /** Flip a numeric dimension between higher-is-better and lower-is-better. */
  toggleDirection: Stream<{ name: string }>;
  /** Set a numeric dimension's range; a bound left out stays, and a range
   * whose minimum is not below its maximum is refused. */
  setRange: Stream<
    { name: string; min?: number | string; max?: number | string }
  >;
}

const QUICK_ADD_MODEL = "anthropic:claude-haiku-4-5";

const SmartRubric = pattern<RubricInput, RubricOutput>(
  ({ title, options, dimensions }) => {
    const selected = new Writable.perSession<string>("");
    const newOptionName = new Writable.perSession<string>("");
    const newDimensionName = new Writable.perSession<string>("");
    const quickAddPrompt = new Writable.perSession<string>("");
    const quickAddSubmitted = new Writable.perSession<string>("");
    const quickAddSubmittedSystem = new Writable.perSession<string>("");

    // --- Quick Add ---------------------------------------------------------

    // Runs only once a description is submitted: an empty prompt sends
    // nothing, so typing in the box costs no calls. The system prompt is
    // captured at submission too, so editing dimensions while a proposal is
    // on screen does not send the description again.
    const extraction = generateObject<QuickAddResponse>({
      // Name the model. The default (`gateway:gpt-5.4-mini`) runs in OpenAI's
      // strict structured-output mode, which rejects the schema the runtime
      // derives from QuickAddResponse: it leaves out `additionalProperties:
      // false`, and toolshed's `normalizeSchemaForProvider` does not add it,
      // so every Quick Add failed with HTTP 400. Drop this once toolshed makes
      // derived schemas strict-compatible.
      model: QUICK_ADD_MODEL,
      system: quickAddSubmittedSystem,
      prompt: quickAddSubmitted,
    });
    const quickAddPreview = computed(() =>
      quickAddSubmitted.get().trim() === ""
        ? EMPTY_PREVIEW
        : previewFromResponse(extraction.result, dimensions.get())
    );
    const quickAddStatus = computed((): QuickAddStatus =>
      quickAddSubmitted.get().trim() === ""
        ? "idle"
        : extraction.pending
        ? "pending"
        : extraction.error
        ? "error"
        : quickAddPreview.ready
        ? "ready"
        // An answer that arrived but names no option is a failure too, so
        // the spinner never waits on it.
        : extraction.result
        ? "error"
        : "pending"
    );
    const quickAddError = computed(() =>
      extraction.error
        ? String(extraction.error)
        : "The answer did not name an option."
    );

    const analyzeQuickAdd = action(() => {
      const description = quickAddPrompt.get().trim();
      if (description === "") return;
      quickAddSubmittedSystem.set(buildQuickAddSystemPrompt(dimensions.get()));
      quickAddSubmitted.set(description);
    });
    // Cancel a call or dismiss its error, keeping the description to edit or
    // resend. Emptying the prompt also lets the same text be sent again.
    const dismissQuickAdd = action(() => quickAddSubmitted.set(""));
    const clearQuickAdd = action(() => {
      quickAddPrompt.set("");
      quickAddSubmitted.set("");
    });
    const acceptQuickAdd = action(() => {
      const preview = quickAddPreview;
      if (!preview.ready) return;
      const option = optionFromPreview(
        preview,
        options.get().map((o) => o.name),
      );
      options.push(option);
      selected.set(option.name);
      quickAddPrompt.set("");
      quickAddSubmitted.set("");
    });

    // --- Options and dimensions --------------------------------------------

    const addOption = action((event: { name?: string }) => {
      const given = typeof event?.name === "string" ? event.name.trim() : "";
      const draft = newOptionName.get().trim();
      const taken = options.get().map((o) => o.name);
      const name = uniqueName(
        given || draft || `Option ${taken.length + 1}`,
        taken,
      );
      options.push({ name, values: [], manualRank: null });
      newOptionName.set("");
    });
    const removeOption = action(({ name }: { name: string }) => {
      options.set(options.get().filter((o) => o.name !== name));
      if (selected.get() === name) selected.set("");
    });

    const addDimension = action(
      (event: { name?: string; type: DimensionType }) => {
        const type: DimensionType = event?.type === "numeric"
          ? "numeric"
          : "categorical";
        const given = typeof event?.name === "string" ? event.name.trim() : "";
        const draft = newDimensionName.get().trim();
        const taken = dimensions.get().map((d) => d.name);
        const fallback = `${type === "numeric" ? "Number" : "Category"} ${
          taken.length + 1
        }`;
        dimensions.push(
          newDimension(uniqueName(given || draft || fallback, taken), type),
        );
        newDimensionName.set("");
      },
    );
    const toggleDirection = action(({ name }: { name: string }) =>
      dimensions.set(
        dimensions.get().map((d) =>
          d.name === name
            ? { ...d, higherIsBetter: d.higherIsBetter === false }
            : d
        ),
      )
    );

    const setRange = action(
      ({ name, min, max }: {
        name: string;
        min?: number | string;
        max?: number | string;
      }) => dimensions.set(withRange(dimensions.get(), name, { min, max })),
    );

    const removeDimension = action(({ name }: { name: string }) => {
      dimensions.set(dimensions.get().filter((d) => d.name !== name));
      options.set(
        options.get().map((o) => ({
          ...o,
          values: o.values.filter((v) => v.dimensionName !== name),
        })),
      );
    });

    const changeWeight = action(
      ({ name, delta }: { name: string; delta: number }) =>
        dimensions.set(withWeightChanged(dimensions.get(), name, delta)),
    );

    const selectOption = action(({ name }: { name: string }) =>
      selected.set(name)
    );

    const setValue = action(
      (
        { option, dimension, value }: {
          option: string;
          dimension: string;
          value: string | number;
        },
      ) => {
        const dim = dimensions.get().find((d) => d.name === dimension);
        const fitted = dim ? fitValue(dim, value) : undefined;
        if (fitted === undefined) return;
        options.set(withValue(options.get(), option, dimension, fitted));
      },
    );

    const stepValue = action(
      ({ option, dimension, delta }: {
        option: string;
        dimension: string;
        delta: number;
      }) => {
        const dim = dimensions.get().find((d) => d.name === dimension);
        const current = options.get().find((o) => o.name === option);
        if (!dim || dim.type !== "numeric" || !current) return;
        const next = steppedValue(dim, valueFor(current, dimension), delta);
        options.set(withValue(options.get(), option, dimension, next));
      },
    );

    const moveOption = action(
      ({ name, delta }: { name: string; delta: number }) =>
        options.set(
          withOptionMoved(options.get(), dimensions.get(), name, delta),
        ),
    );
    const resetManualRanks = action(() =>
      options.set(withManualRanksCleared(options.get()))
    );

    // --- Derived views -----------------------------------------------------

    const ranked = computed(() => rankOptions(options.get(), dimensions.get()));
    const hasOptions = computed(() => options.get().length > 0);
    const dimensionViews = computed(() => dimensions.get().map(dimensionView));
    const hasDimensions = computed(() => dimensions.get().length > 0);
    const selectedName = computed(() => {
      const name = selected.get();
      return options.get().some((o) => o.name === name) ? name : "";
    });
    const detail = computed((): DetailRow[] => {
      const option = options.get().find((o) => o.name === selected.get());
      return option ? detailRows(option, dimensions.get()) : [];
    });
    const editingLabel = computed(() => `Editing: ${selectedName}`);
    const fsContent = computed(() =>
      rubricMarkdown(title.get(), options.get(), dimensions.get())
    );

    const quickAddPanel = (
      <div style={styles.quickAdd}>
        <h3 style={styles.heading}>Quick Add</h3>
        <div style={styles.row}>
          <cf-input
            $value={quickAddPrompt}
            placeholder="Describe an option, e.g. 'Apartment A: 2br in the Mission, $2100/mo'"
            style="flex: 1;"
          />
          <cf-button onClick={analyzeQuickAdd}>Analyze</cf-button>
        </div>
        {quickAddStatus === "pending"
          ? (
            <div style={styles.row}>
              <cf-loader size="sm" showElapsed />
              <span style={styles.grow}>Analyzing description...</span>
              <cf-button variant="outline" onClick={dismissQuickAdd}>
                Cancel
              </cf-button>
            </div>
          )
          : quickAddStatus === "error"
          ? (
            <div style={styles.row}>
              <div style={{ ...styles.error, ...styles.grow }}>
                Error: {quickAddError}
              </div>
              <cf-button variant="outline" onClick={dismissQuickAdd}>
                Dismiss
              </cf-button>
            </div>
          )
          : quickAddStatus === "ready"
          ? (
            <div style={styles.preview}>
              <div>
                <strong>Proposed option:</strong> {quickAddPreview.name}
              </div>
              {quickAddPreview.values.length > 0
                ? (
                  <ul style={{ margin: "0", paddingLeft: "1.25rem" }}>
                    {quickAddPreview.values.map((v) => (
                      <li>
                        {v.dimensionName}: <strong>{v.value}</strong>{" "}
                        <span
                          style={{
                            fontSize: "0.8em",
                            color: v.color,
                          }}
                        >
                          ({v.confidence})
                        </span>
                      </li>
                    ))}
                  </ul>
                )
                : (
                  <div style={styles.hint}>
                    No values matched the rubric's dimensions.
                  </div>
                )}
              <div style={styles.small}>
                <em>{quickAddPreview.reasoning}</em>
              </div>
              <div style={styles.row}>
                <cf-button onClick={acceptQuickAdd}>Accept & Add</cf-button>
                <cf-button variant="outline" onClick={clearQuickAdd}>
                  Clear
                </cf-button>
              </div>
            </div>
          )
          : (
            <div style={styles.hint}>
              Describe an option and click Analyze to have AI fill in its
              dimension values. You review them before anything is added.
            </div>
          )}
      </div>
    );

    const rankingPane = (
      <div style={styles.pane}>
        <h3 style={styles.heading}>Ranked Options</h3>
        <div style={styles.row}>
          <cf-input
            $value={newOptionName}
            placeholder="New option name"
            style="flex: 1;"
          />
          <cf-button onClick={addOption}>+ Add Option</cf-button>
        </div>
        {hasOptions
          ? (
            <div
              style={{ display: "flex", flexDirection: "column", gap: "4px" }}
            >
              {ranked.map((row) => (
                <div
                  style={{
                    ...styles.optionCard,
                    border: row.name === selectedName
                      ? `2px solid ${ACCENT}`
                      : BORDER,
                    background: row.name === selectedName
                      ? ACCENT_SURFACE
                      : "transparent",
                  }}
                >
                  <div style={styles.arrows}>
                    <cf-button
                      size="sm"
                      variant="ghost"
                      aria-label={`Move ${row.name} up`}
                      disabled={row.isFirst}
                      onClick={() =>
                        moveOption.send({ name: row.name, delta: -1 })}
                    >
                      ▲
                    </cf-button>
                    <cf-button
                      size="sm"
                      variant="ghost"
                      aria-label={`Move ${row.name} down`}
                      disabled={row.isLast}
                      onClick={() =>
                        moveOption.send({ name: row.name, delta: 1 })}
                    >
                      ▼
                    </cf-button>
                  </div>
                  <button
                    type="button"
                    style={styles.optionName}
                    onClick={() => selectOption.send({ name: row.name })}
                  >
                    {row.position}. {row.name}
                  </button>
                  <span style={styles.score}>{row.scoreLabel}</span>
                  {row.movedByHand
                    ? <span title="Placed by hand">✋</span>
                    : null}
                  <cf-button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${row.name}`}
                    onClick={() => removeOption.send({ name: row.name })}
                  >
                    ✕
                  </cf-button>
                </div>
              ))}
              <div>
                <cf-button
                  size="sm"
                  variant="outline"
                  onClick={resetManualRanks}
                >
                  Reset Manual Ranks
                </cf-button>
              </div>
            </div>
          )
          : (
            <div style={styles.hint}>
              No options yet. Add one by name, or describe one in Quick Add.
            </div>
          )}
      </div>
    );

    const detailPane = (
      <div style={styles.pane}>
        {selectedName !== ""
          ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.5rem",
              }}
            >
              <h3 style={styles.heading}>{editingLabel}</h3>
              {hasDimensions
                ? (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.5rem",
                    }}
                  >
                    {detail.map((row) => (
                      <div style={styles.card}>
                        <div style={styles.cardHeading}>{row.heading}</div>
                        {row.isCategorical
                          ? (
                            <div style={styles.chips}>
                              {row.categories.map((chip) => (
                                <cf-button
                                  size="sm"
                                  variant={chip.active ? "solid" : "outline"}
                                  onClick={() =>
                                    setValue.send({
                                      option: chip.option,
                                      dimension: chip.dimension,
                                      value: chip.label,
                                    })}
                                >
                                  {chip.text}
                                </cf-button>
                              ))}
                            </div>
                          )
                          : (
                            <div style={styles.row}>
                              <cf-button
                                variant="outline"
                                aria-label={`Decrease ${row.dimension}`}
                                onClick={() =>
                                  stepValue.send({
                                    option: row.option,
                                    dimension: row.dimension,
                                    delta: -1,
                                  })}
                              >
                                −
                              </cf-button>
                              <span style={styles.numericValue}>
                                {row.valueLabel}
                              </span>
                              <cf-button
                                variant="outline"
                                aria-label={`Increase ${row.dimension}`}
                                onClick={() =>
                                  stepValue.send({
                                    option: row.option,
                                    dimension: row.dimension,
                                    delta: 1,
                                  })}
                              >
                                +
                              </cf-button>
                              <span style={styles.small}>{row.rangeLabel}</span>
                            </div>
                          )}
                      </div>
                    ))}
                  </div>
                )
                : (
                  <div style={styles.hint}>
                    No dimensions yet. Add dimensions below to score options.
                  </div>
                )}
            </div>
          )
          : (
            <div style={{ fontSize: "0.9em", lineHeight: "1.6" }}>
              <h3 style={styles.heading}>How it works</h3>
              <ol>
                <li>
                  Add the dimensions you care about, below, and weight them.
                </li>
                <li>Add the options you are choosing between.</li>
                <li>
                  <strong>Click an option</strong>{" "}
                  to set its value on each dimension.
                </li>
                <li>
                  Options rank by weighted score. Use ▲ ▼ to override the order
                  by hand.
                </li>
              </ol>
            </div>
          )}
      </div>
    );

    const dimensionsPanel = (
      <div style={styles.panel}>
        <h3 style={styles.heading}>Dimensions</h3>
        <div style={styles.row}>
          <cf-input
            $value={newDimensionName}
            placeholder="New dimension name"
            style="flex: 1;"
          />
          <cf-button
            onClick={() => addDimension.send({ type: "categorical" })}
          >
            + Categorical
          </cf-button>
          <cf-button onClick={() => addDimension.send({ type: "numeric" })}>
            + Numeric
          </cf-button>
        </div>
        {hasDimensions
          ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.5rem",
              }}
            >
              {dimensionViews.map((dim) => (
                <div style={styles.card}>
                  <div style={styles.row}>
                    <div style={styles.grow}>
                      <strong>{dim.name}</strong>{" "}
                      <span style={styles.small}>{dim.kind}</span>
                    </div>
                    {dim.isNumeric
                      ? (
                        <cf-button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            toggleDirection.send({ name: dim.name })}
                        >
                          {dim.directionLabel}
                        </cf-button>
                      )
                      : null}
                    <span>{dim.weightLabel}</span>
                    <cf-button
                      size="sm"
                      variant="outline"
                      aria-label={`Lower the weight of ${dim.name}`}
                      onClick={() =>
                        changeWeight.send({ name: dim.name, delta: -0.5 })}
                    >
                      −
                    </cf-button>
                    <cf-button
                      size="sm"
                      variant="outline"
                      aria-label={`Raise the weight of ${dim.name}`}
                      onClick={() =>
                        changeWeight.send({ name: dim.name, delta: 0.5 })}
                    >
                      +
                    </cf-button>
                    <cf-button
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove ${dim.name}`}
                      onClick={() => removeDimension.send({ name: dim.name })}
                    >
                      ✕
                    </cf-button>
                  </div>
                  {dim.isNumeric
                    ? (
                      <div style={styles.row}>
                        <span style={styles.small}>Range</span>
                        <cf-input
                          type="number"
                          size="sm"
                          aria-label={`Minimum of ${dim.name}`}
                          value={dim.minText}
                          timingStrategy="blur"
                          oncf-change={(e: { detail?: { value?: string } }) =>
                            setRange.send({
                              name: dim.name,
                              min: e?.detail?.value ?? "",
                            })}
                        />
                        <span style={styles.small}>to</span>
                        <cf-input
                          type="number"
                          size="sm"
                          aria-label={`Maximum of ${dim.name}`}
                          value={dim.maxText}
                          timingStrategy="blur"
                          oncf-change={(e: { detail?: { value?: string } }) =>
                            setRange.send({
                              name: dim.name,
                              max: e?.detail?.value ?? "",
                            })}
                        />
                      </div>
                    )
                    : <div style={styles.small}>{dim.scaleLabel}</div>}
                </div>
              ))}
            </div>
          )
          : (
            <div style={styles.hint}>
              No dimensions yet. Categorical ones score Excellent / Good / Fair
              / Poor; numeric ones map their range (0–100 until you change it)
              onto the same 0–10 scale.
            </div>
          )}
      </div>
    );

    return {
      [NAME]: computed(() => `⚖️ ${title.get()}`),
      [UI]: (
        <cf-screen>
          <div style={styles.page}>
            <cf-input $value={title} placeholder="Rubric title" />
            {quickAddPanel}
            <div style={styles.panes}>
              {rankingPane}
              {detailPane}
            </div>
            {dimensionsPanel}
          </div>
        </cf-screen>
      ),
      [FS]: {
        type: "text/markdown",
        frontmatter: { title },
        content: fsContent,
      },
      title,
      options,
      dimensions,
      ranked,
      selected: selectedName,
      quickAddStatus,
      quickAddPreview,
      addOption,
      removeOption,
      addDimension,
      removeDimension,
      changeWeight,
      selectOption,
      setValue,
      stepValue,
      moveOption,
      resetManualRanks,
      analyzeQuickAdd,
      acceptQuickAdd,
      clearQuickAdd,
      dismissQuickAdd,
      toggleDirection,
      setRange,
    };
  },
);

export default SmartRubric;
