import {
  computed,
  Default,
  generateText,
  hasError,
  hasSchemaMismatch,
  ifElse,
  isPending,
  isSyncing,
  NAME,
  pattern,
  resultOf,
  UI,
  type VNode,
} from "commonfabric";

// ===== Types =====

type SummaryInput = {
  topic?: string | Default<"">;
  context?: Record<string, any> | Default<Record<string, never>>;
};

export type SummaryOutput = {
  [NAME]: string;
  [UI]: VNode;
  topic: string;
  summary: string;
  pending: boolean;
  availability: string;
  error: string;
};

// ===== Pattern =====

/**
 * Generates a concise summary of provided context using an LLM.
 * Designed as "suggestion fuel" - a lightweight utility pattern that can be
 * instantiated across many different contexts.
 */
const Summary = pattern<SummaryInput, SummaryOutput>(({ topic, context }) => {
  // An empty prompt holds the request back: `generateText` clears its state
  // and makes no call until one arrives. A summary with no topic has nothing
  // to condense, so the model is asked only once a caller names the subject.
  const prompt = computed(() => {
    if (!topic) return "";
    return `Please provide a concise, well-structured summary of ${topic}`;
  });

  // Generate the summary
  const responseRequest = generateText({
    system:
      "You are a helpful assistant that creates clear, concise summaries. Focus on the key points and structure your response in a readable way.",
    prompt,
    context,
  });
  const responseState = computed(() => {
    if (!topic) {
      return {
        response: "",
        pending: false,
        availability: "ready",
        error: "",
      };
    }
    if (isPending(responseRequest)) {
      return {
        response: "",
        pending: true,
        availability: "pending",
        error: "",
      };
    }
    if (hasSchemaMismatch(responseRequest)) {
      return {
        response: "",
        pending: false,
        availability: "schemaMismatch",
        error: "The generated summary did not match the expected format.",
      };
    }
    if (hasError(responseRequest)) {
      return {
        response: "",
        pending: false,
        availability: "error",
        error: responseRequest.errorMessage,
      };
    }
    if (isSyncing(responseRequest)) {
      return {
        response: "",
        pending: false,
        availability: "syncing",
        error: "Waiting for synchronized data.",
      };
    }
    return {
      response: resultOf(responseRequest),
      pending: false,
      availability: "ready",
      error: "",
    };
  });

  return {
    [NAME]: computed(() => (topic ? `Summary: ${topic}` : "Summary")),
    [UI]: (
      <cf-screen>
        <cf-vstack slot="header" gap="1">
          <cf-heading level={4}>
            {computed(() => topic || "Summary")}
          </cf-heading>
        </cf-vstack>

        <cf-vstack gap="3" style="padding: 1.5rem;">
          {ifElse(
            responseState.pending,
            <div style="color: var(--cf-theme-color-text-secondary);">
              <cf-loader show-elapsed /> Generating summary...
            </div>,
            ifElse(
              responseState.error,
              <div role="alert" style="color: var(--cf-theme-color-error);">
                {responseState.error}
              </div>,
              <div style="line-height: 1.6; white-space: pre-wrap;">
                {responseState.response}
              </div>,
            ),
          )}
        </cf-vstack>
      </cf-screen>
    ),
    topic,
    summary: responseState.response,
    pending: responseState.pending,
    availability: responseState.availability,
    error: responseState.error,
  };
});

export default Summary;
