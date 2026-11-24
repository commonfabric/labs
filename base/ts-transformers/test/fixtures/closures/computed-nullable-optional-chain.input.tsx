import { computed, pattern, UI, NAME } from "commonfabric";

// Represents a question that may or may not exist
type Question = {
  question: string;
  category: string;
  priority: number;
};

// FIXTURE: computed-nullable-optional-chain
// Verifies: computed() capturing a nullable computed result preserves anyOf [type, null] in schema
//   computed(() => topQuestion?.question || "") → lift(({ topQuestion }) => topQuestion?.question || "")({ topQuestion })
//   computed(() => topQuestion === null ? "" : topQuestion.question) → lift(({ topQuestion }) => ...)({ topQuestion })
// Context: Tests both optional chaining (?.) and explicit null-check patterns on
//   a nullable Reactive. The capture schema correctly uses anyOf [Question, null]
//   with asOpaque: true for the topQuestion capture.
export default pattern((_) => {
  // This computed can return null - simulates finding a question from a list
  const topQuestion = computed((): Question | null => {
    // In real code this would filter and return first match, or null
    return null;
  });

  return {
    [NAME]: "Computed Nullable Optional Chain",
    [UI]: (
      <div>
        {/* BUG CASE: Optional chaining loses nullability in schema inference */}
        {/* The input schema should have topQuestion as anyOf [Question, null] */}
        {/* but instead infers topQuestion as object with required "question" */}
        <p>Optional chaining: {computed(() => topQuestion?.question || "")}</p>

        {/* WORKAROUND: Explicit null check preserves nullability */}
        {/* This correctly generates anyOf [Question, null] in the schema */}
        <p>Explicit check: {computed(() => topQuestion === null ? "" : topQuestion.question)}</p>

        {/* Same issue with category field */}
        <span>Category (buggy): {computed(() => topQuestion?.category || "")}</span>
        <span>Category (works): {computed(() => topQuestion === null ? "" : topQuestion.category)}</span>
      </div>
    ),
  };
});
