// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: packages/patterns/index.md
import {
  type BuiltInLLMMessage,
  computed,
  generateObject,
  handler,
  hasError,
  isPending,
  type JSONSchema,
  pattern,
  type Reactive,
  resultOf,
  type Stream,
} from "commonfabric";

interface Email {
  id: string;
  content: string;
}

interface ExtractedData {
  summary: string;
}

type LegacyAnalysis<T> = {
  pending: Reactive<boolean>;
  result?: Reactive<T | undefined>;
  error?: Reactive<string>;
  messages?: Reactive<BuiltInLLMMessage[]>;
  partial?: Reactive<string>;
  cancelGeneration: Stream<void>;
};

const cancelGeneration = handler<
  void,
  Record<string, never>
>(() => {});

// Generic building block - T is a type parameter
function BuildingBlock<T>(emails: Reactive<Email[]>, schema: JSONSchema) {
  // This is the problematic case: generateObject<T> where T is a type parameter
  // resultOf preserves the unresolved T while filtering unavailable states.
  const analyses = emails.map((email: Email) => {
    const request = generateObject<T>({
      prompt: email.content,
      schema,
    });
    const usableResult = resultOf(request);
    const result = computed(() =>
      isPending(request) || hasError(request) ? undefined : usableResult
    );
    const analysis: LegacyAnalysis<T> = {
      pending: computed(() => isPending(request)),
      result,
      error: computed(() => hasError(request) ? request.errorMessage : ""),
      messages: computed((): BuiltInLLMMessage[] => []),
      partial: computed(() => ""),
      cancelGeneration: cancelGeneration({}),
    };

    return {
      email,
      // Project the direct request through the deployed output contract.
      analysis,
      result,
    };
  });

  return { analyses };
}

// Pattern that uses the building block
export default pattern(({ emails }: { emails: Reactive<Email[]> }) => {
  const data = BuildingBlock<ExtractedData>(emails, { type: "object" });
  return { data };
});
