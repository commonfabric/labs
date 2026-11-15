## `apps/smart-rubric/smart-rubric.tsx`

Weigh options against a weighted rubric. Define categorical dimensions (scored
Excellent / Good / Fair / Poor) and numeric ones (a range mapped onto the same
0–10 scale, higher or lower is better), weight them, and set each option's
values; options rank by weighted score. ▲/▼ pins an option at a slot by hand
while the rest keep ranking by score. Quick Add sends a free-text description to
`generateObject` and proposes the option's name and values, checked against the
rubric, for review before adding.

**Keywords:** decision, rubric, scoring, ranking, weights, generateObject, llm

### Input Schema

```ts
interface CategoryOption {
  label: string;
  score: number;
}

interface Dimension {
  name: string; // unique; option values refer to it
  type: "categorical" | "numeric";
  multiplier: number; // weight, 0..10 in steps of 0.5
  categories: CategoryOption[];
  numericMin: number;
  numericMax: number;
  higherIsBetter?: boolean; // numeric only; default true
}

interface RubricOption {
  name: string; // unique
  values: { dimensionName: string; value: string | number }[];
  manualRank: number | null; // slot pinned by hand, or null
}

interface RubricInput {
  title?: PerSpace<Writable<string | Default<"Decision Rubric">>>;
  options?: PerSpace<Writable<RubricOption[] | Default<[]>>>;
  dimensions?: PerSpace<Writable<Dimension[] | Default<[]>>>;
}
```

### Output Schema

```ts
interface RubricOutput {
  title: string;
  options: RubricOption[];
  dimensions: Dimension[];
  ranked: RankedOption[]; // displayed order with scores
  selected: string;
  quickAddStatus: "idle" | "pending" | "error" | "ready";
  quickAddPreview: QuickAddPreview;
  addOption: Stream<{ name?: string }>;
  removeOption: Stream<{ name: string }>;
  addDimension: Stream<{ name?: string; type: "categorical" | "numeric" }>;
  removeDimension: Stream<{ name: string }>;
  changeWeight: Stream<{ name: string; delta: number }>;
  toggleDirection: Stream<{ name: string }>;
  selectOption: Stream<{ name: string }>;
  setValue: Stream<
    { option: string; dimension: string; value: string | number }
  >;
  stepValue: Stream<{ option: string; dimension: string; delta: number }>;
  moveOption: Stream<{ name: string; delta: number }>;
  resetManualRanks: Stream<void>;
  analyzeQuickAdd: Stream<void>;
  acceptQuickAdd: Stream<void>;
  clearQuickAdd: Stream<void>;
  dismissQuickAdd: Stream<void>;
}
```

<!-- demo-list: `apps/smart-rubric/` (score and rank options against a weighted rubric, with LLM Quick Add) -->
