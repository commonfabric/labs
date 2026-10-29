import {
  computed,
  Default,
  generateObject,
  handler,
  ifElse,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

// ===== Types =====

type QuestionInput = {
  topic?: string | Default<"">;
  context?: Record<string, any> | Default<Record<string, never>>;
};

export type QuestionOutput = {
  [NAME]: string;
  [UI]: VNode;
  topic: string;
  question: string;
  options: string[];
  answer: Writable<string>;
  pending: boolean;
};

// ===== Handler (module scope) =====

const onAnswer = handler<
  { detail: { answer: string } },
  { answer: Writable<string> }
>(({ detail }, { answer }) => {
  answer.set(detail.answer);
});

// ===== Pattern =====

/**
 * Generates a clarifying question to ask the user based on the topic and context.
 * Designed as "suggestion fuel" - useful when the system needs more information
 * before proceeding, or to prompt the user to think about something.
 */
const Question = pattern<QuestionInput, QuestionOutput>(
  ({ topic, context }) => {
    // An empty prompt holds the request back: `generateObject` clears its
    // state and makes no call until one arrives. A question with no topic has
    // nothing to ask about, so the model is asked only once a caller names the
    // subject.
    const prompt = computed(() => {
      if (!topic) return "";
      return `Generate a single, thoughtful clarifying question about: ${topic}. Include 2-4 multiple choice options if appropriate, or leave options empty for a free-text answer.`;
    });

    const response = generateObject<{
      question: string;
      options: string[];
    }>({
      system:
        "You generate thoughtful, specific questions that help clarify intent or gather useful information. Questions should be concise and actionable. Provide 2-4 multiple choice options when the answer space is bounded, or an empty options array for open-ended questions.",
      prompt,
      context,
      schema: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["question", "options"],
      },
      model: "anthropic:claude-haiku-4-5",
    });

    const answer = new Writable("");

    return {
      [NAME]: computed(() => (topic ? `Question: ${topic}` : "Question")),
      [UI]: (
        <cf-screen>
          <cf-vstack slot="header" gap="1">
            <cf-heading level={4}>
              {computed(() => topic || "Question")}
            </cf-heading>
          </cf-vstack>

          <cf-vstack gap="3" style="padding: 1.5rem;">
            {ifElse(
              response.pending,
              <div style="color: var(--cf-theme-color-text-secondary);">
                <cf-loader show-elapsed /> Generating question...
              </div>,
              <cf-question
                question={computed(
                  () => response.result?.question || "",
                )}
                options={computed(
                  () => response.result?.options || [],
                )}
                oncf-answer={onAnswer({ answer })}
              />,
            )}
          </cf-vstack>
        </cf-screen>
      ),
      topic,
      question: computed(() => response.result?.question || ""),
      options: computed(() => response.result?.options || []),
      answer,
      pending: response.pending,
    };
  },
);

export default Question;
