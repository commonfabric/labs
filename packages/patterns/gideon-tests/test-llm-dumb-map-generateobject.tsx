// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: packages/patterns/index.md
/**
 * TEST PATTERN: Dumb Map Approach for generateObject
 *
 * CLAIM: The "dumb map approach" works for generateObject - just use .map() directly
 * SOURCE: folk_wisdom/llm.md - "The Dumb Map Approach Works for ALL Reactive Primitives"
 *
 * WHAT THIS TESTS:
 * - That calling generateObject inside a .map() on a list of items works correctly
 * - That each item's generateObject is cached independently (via hash in llm.ts:945-963)
 * - That the framework handles caching via refer(params).toString() hash
 *
 * FRAMEWORK EVIDENCE:
 * - packages/runner/src/builtins/llm.ts:945 - Hash creation: refer(generateObjectParams).toString()
 * - packages/runner/src/builtins/llm.ts:950-957 - Early return if hash matches cached requestHash
 * - Each item has unique content → unique prompt → unique hash → independent cache entry
 *
 * EXPECTED BEHAVIOR (if claim is TRUE):
 * - All items process independently with their own generateObject calls
 * - No need for complex caching layers or trigger patterns
 * - Adding/editing items only triggers LLM for changed items (new hash)
 * - Network tab shows requests = new/changed items only
 *
 * MANUAL VERIFICATION STEPS:
 * 1. Deploy pattern: deno task cf piece new test-llm-dumb-map-generateobject.tsx
 * 2. Add 3-5 items with different content (e.g., "I love this!", "This is terrible", "It's okay")
 * 3. Open browser DevTools → Network tab → filter for "anthropic" or "generate"
 * 4. Wait for all items to complete (all show sentiment results)
 * 5. Add ONE new item → verify only 1 new network request (not 4-6)
 * 6. Remove and re-add an item with slightly different text → verify only 1 request
 * 7. Check console for any "Tried to directly access opaque value" errors (should be none)
 */
import {
  type BuiltInLLMMessage,
  computed,
  Default,
  generateObject,
  handler,
  hasError,
  isPending,
  NAME,
  pattern,
  type Reactive,
  resultOf,
  type Stream,
  UI,
  Writable,
} from "commonfabric";

interface Item {
  id: string;
  content: string;
}

interface Sentiment {
  sentiment: "positive" | "neutral" | "negative";
  confidence: number;
  keywords: string[];
}

type LegacySentimentAnalysis = {
  pending: Reactive<boolean>;
  result?: Reactive<Sentiment | undefined>;
  error?: Reactive<string>;
  messages?: Reactive<BuiltInLLMMessage[]>;
  partial?: Reactive<string>;
  cancelGeneration: Stream<void>;
};

const cancelGeneration = handler<
  void,
  Record<string, never>
>(() => {});

interface Input {
  items: Item[] | Default<[]>;
}

const addItem = handler<
  { detail: { message: string } },
  { items: Writable<Item[]> }
>(
  ({ detail }, { items }) => {
    const content = detail?.message?.trim();
    if (!content) return;

    items.push({
      id: `item-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      content,
    });
  },
);

const removeItem = handler<
  unknown,
  { items: Writable<Item[]>; itemId: string }
>(
  (_event, { items, itemId }) => {
    const current = items.get();
    items.set(current.filter((item) => item.id !== itemId));
  },
);

export default pattern<Input>(({ items }) => {
  // THE "DUMB MAP APPROACH" - just map directly over items
  // Framework caches each call via hash(prompt + schema + model + system)
  const sentimentAnalyses = items.map((item) => {
    const request = generateObject<Sentiment>({
      system:
        "Analyze the sentiment of the following text. Return positive, neutral, or negative sentiment with confidence 0-1 and relevant keywords.",
      prompt: item.content,
    });
    const analysis: LegacySentimentAnalysis = {
      pending: computed(() => isPending(request)),
      result: computed(() =>
        isPending(request) || hasError(request) ? undefined : resultOf(request)
      ),
      error: computed(() => hasError(request) ? request.errorMessage : ""),
      messages: computed((): BuiltInLLMMessage[] => []),
      partial: computed(() => ""),
      // The old output exposed cancellation even though the direct API does not.
      cancelGeneration: cancelGeneration({}),
    };
    return {
      itemId: item.id,
      content: item.content,
      // Project the direct request through the deployed output contract.
      analysis,
    };
  });

  const pendingCount = computed(() =>
    sentimentAnalyses.map((s) => s.analysis.pending).filter((p) => p).length
  );

  const completedCount = computed(() =>
    sentimentAnalyses.map((s) => s.analysis.result).filter((result) =>
      result !== undefined
    ).length
  );

  return {
    [NAME]: "Test: Dumb Map with generateObject",
    [UI]: (
      <div
        style={{ padding: "20px", maxWidth: "800px", fontFamily: "system-ui" }}
      >
        <h2>Dumb Map Approach: generateObject Test</h2>

        <p style={{ color: "#666", marginBottom: "20px" }}>
          Testing that .map() + generateObject works without custom caching.
          Each item gets independent caching via prompt content hashing.
        </p>

        <div
          style={{
            background: "#f0f0f0",
            padding: "15px",
            margin: "15px 0",
            borderRadius: "6px",
            borderLeft: "4px solid #2196F3",
          }}
        >
          <strong>Status:</strong> {completedCount}/{items.length} completed,
          {" "}
          {pendingCount} pending
        </div>

        <div style={{ margin: "20px 0" }}>
          <cf-message-input
            placeholder="Enter text to analyze sentiment (e.g., 'I love this!', 'This is terrible')..."
            appearance="rounded"
            oncf-send={addItem({ items })}
          />
        </div>

        <div style={{ marginTop: "20px" }}>
          {sentimentAnalyses.map((item, i) => (
            <div
              key={i}
              style={{
                border: "1px solid #ddd",
                padding: "15px",
                margin: "10px 0",
                borderRadius: "6px",
                background: "white",
              }}
            >
              <div style={{ marginBottom: "12px", fontSize: "14px" }}>
                <strong>Text:</strong> <em>{item.content}</em>
              </div>

              {computed(() => {
                const pending = item.analysis.pending;
                const result = item.analysis.result;
                const error = item.analysis.error;
                if (pending) {
                  return (
                    <div
                      style={{
                        color: "#666",
                        padding: "10px",
                        background: "#fff3cd",
                        borderRadius: "4px",
                      }}
                    >
                      <cf-loader
                        show-elapsed
                        style={{
                          display: "inline-block",
                          marginRight: "8px",
                        }}
                      />
                      Analyzing sentiment...
                    </div>
                  );
                }
                if (error) {
                  return (
                    <div
                      style={{
                        color: "#d32f2f",
                        padding: "10px",
                        background: "#ffebee",
                        borderRadius: "4px",
                      }}
                    >
                      <strong>Error:</strong> {String(error)}
                    </div>
                  );
                }
                const sentimentResult = result as Sentiment | undefined;
                if (sentimentResult) {
                  return (
                    <div
                      style={{
                        padding: "10px",
                        background: "#f5f5f5",
                        borderRadius: "4px",
                      }}
                    >
                      <div style={{ marginBottom: "6px" }}>
                        <strong>Sentiment:</strong>{" "}
                        <span
                          style={{
                            fontSize: "16px",
                            fontWeight: "bold",
                            color: sentimentResult.sentiment === "positive"
                              ? "#4CAF50"
                              : sentimentResult.sentiment === "negative"
                              ? "#f44336"
                              : "#757575",
                          }}
                        >
                          {sentimentResult.sentiment.toUpperCase()}
                        </span>{" "}
                        <span style={{ color: "#666", fontSize: "12px" }}>
                          ({Math.round(sentimentResult.confidence * 100)}%
                          confidence)
                        </span>
                      </div>
                      <div style={{ fontSize: "12px", color: "#666" }}>
                        <strong>Keywords:</strong>{" "}
                        {sentimentResult.keywords.join(", ")}
                      </div>
                    </div>
                  );
                }
                return null;
              })}

              <div style={{ marginTop: "12px" }}>
                <cf-button onClick={removeItem({ items, itemId: item.itemId })}>
                  Remove
                </cf-button>
              </div>
            </div>
          ))}
        </div>

        <div
          style={{
            marginTop: "30px",
            padding: "20px",
            background: "#e3f2fd",
            borderRadius: "6px",
            borderLeft: "4px solid #2196F3",
          }}
        >
          <h3 style={{ marginTop: 0 }}>Manual Testing Instructions:</h3>
          <ol style={{ lineHeight: 1.8, paddingLeft: "20px" }}>
            <li>Add 3-5 items with varying sentiments</li>
            <li>Open DevTools: Network tab → Filter for "anthropic"</li>
            <li>Wait for all items to complete</li>
            <li>Add ONE new item → Verify ONLY 1 new network request</li>
            <li>If you see 4+ requests, caching is NOT working</li>
          </ol>
        </div>
      </div>
    ),
    items,
    sentimentAnalyses,
  };
});
