import {
  type BuiltInLLMMessage,
  computed,
  type Default,
  fetchText,
  handler,
  ifElse,
  llmDialog,
  NAME,
  pattern,
  patternTool,
  type Stream,
  toSchema,
  UI,
  type VNode,
  wish,
  type WishState,
  Writable,
} from "commonfabric";
import { bash, fetchAndRunPattern, listMentionable } from "./common-fabric.tsx";
import {
  searchPattern as summarySearchPattern,
  type SummaryIndexEntry,
} from "./summary-index.tsx";
import SuggestionHistory from "./suggestion-history.tsx";
import { type MentionablePiece } from "./backlinks-index.tsx";

type SuggestionResult = {
  [NAME]?: string;
};

type SuggestionResultCell = Writable<SuggestionResult>;

const triggerGeneration = handler<
  unknown,
  {
    addMessage: Stream<BuiltInLLMMessage>;
    situation: string;
    result: any | null;
  }
>((_, { addMessage, situation, result }) => {
  if (!result) {
    addMessage.send({
      role: "user",
      content: [{ type: "text" as const, text: situation }],
    });
  }
});

const sendMessage = handler<
  { detail: { text: string; attachments?: Array<any> } },
  { addMessage: Stream<BuiltInLLMMessage> }
>((event, { addMessage }) => {
  addMessage.send({
    role: "user",
    content: [{ type: "text" as const, text: event.detail.text }],
  });
});

const showRefineInput = handler<unknown, { showRefine: Writable<boolean> }>(
  (_, { showRefine }) => {
    showRefine.set(true);
  },
);

const setQuestion = handler<
  { question: string; options?: string[] },
  { pendingQuestion: Writable<{ question: string; options: string[] } | null> }
>(({ question, options }, { pendingQuestion }) => {
  pendingQuestion.set({ question, options: options ?? [] });
});

const onQuestionAnswer = handler<
  { detail: { answer: string } },
  {
    addMessage: Stream<BuiltInLLMMessage>;
    pendingQuestion: Writable<{ question: string; options: string[] } | null>;
  }
>(({ detail }, { addMessage, pendingQuestion }) => {
  pendingQuestion.set(null);
  addMessage.send({
    role: "user",
    content: [{ type: "text" as const, text: detail.answer }],
  });
});

export default pattern<
  {
    situation: string;
    context: { [id: string]: any };
    initialResults: SuggestionResultCell[] | Default<[]>;
  },
  WishState<SuggestionResultCell> & { [UI]: VNode }
>(({ situation, context, initialResults }) => {
  // --- Picker state (used when initialResults is non-empty) ---
  const selectedIndex = new Writable(0);
  const userConfirmedIndex = new Writable<number | null>(null);

  const confirmedIndex = computed(() => {
    if (initialResults.length === 1) return 0;
    return userConfirmedIndex.get();
  });

  const pickerResult = computed((): SuggestionResultCell | undefined => {
    if (initialResults.length === 0) return undefined;
    const idx = confirmedIndex; // Auto-unwraps to number | null
    if (idx === null) return undefined; // Wait for user confirmation
    return initialResults[Math.min(idx, initialResults.length - 1)];
  });

  // --- LLM state (freeform query path) ---
  const profile = wish<string>({ query: "#learnedSummary" });

  const mentionable = wish<MentionablePiece[]>({
    query: "#mentionable",
  }).result;
  const { entries: summaryEntries } = wish<{
    entries: SummaryIndexEntry[];
  }>({ query: "#summaryIndex" }).result!;

  const suggestionHistory = SuggestionHistory({});

  const patternIndexUrl = wish<{ url: Writable<string> }>({
    query: "#patternIndex",
  });
  const resolvedPatternUrl = new Writable<string>("/api/patterns/index.md");
  computed(() => {
    const urlRef = patternIndexUrl?.result?.url;
    const urlValue = typeof urlRef?.get === "function"
      ? urlRef.get()
      : (typeof urlRef === "string" ? urlRef : undefined);
    if (typeof urlValue === "string" && urlValue.length > 0) {
      resolvedPatternUrl.set(urlValue);
    }
  });

  const { result: patternIndex } = fetchText({
    url: resolvedPatternUrl,
  });

  const profileContext = computed(() => {
    const profileText = profile.result;
    return profileText ? `\n\n--- User Context ---\n${profileText}\n---` : "";
  });

  const systemPrompt = computed(() => {
    const profileCtx = profileContext;
    const indexText = patternIndex
      ? `\n\n--- Available Patterns ---\n${patternIndex}\n---`
      : "";
    return `You help users by finding relevant content and patterns.${profileCtx}${indexText}

Your textual responses are invisible to the user — they can only see the presented result.

Strategy:
0. Before generating anything new, call searchHistory to check if a similar result was already created. If a match is found, presentResult with it directly.
1. If the request is ambiguous or you need user preferences, call askUserQuestion first. After calling it, STOP — the user's answer will arrive as the next message. Then resume from step 2 with that context.
2. Review the available patterns listed above to find the best match for the user's request.
3. Search the space for existing relevant content using searchSpace.
4. Decide: if an existing cell matches what the user needs, presentResult with it. Otherwise, use fetchAndRunPattern to instantiate a pattern from the index, optionally with existing data as context, then presentResult with the resulting cell link.

The final result you present is almost always either an existing cell or a pattern instantiated from the index. Always gather the information you need (search results, user clarification) before presenting a result.

Use the user context above to personalize your suggestions when relevant.`;
  });

  const messages = new Writable<BuiltInLLMMessage[]>([]);
  const showRefine = new Writable(false);
  const pendingQuestion = new Writable<
    {
      question: string;
      options: string[];
    } | null
  >(null);
  const hasPendingQuestion = computed(() => pendingQuestion.get() != null);

  const {
    addMessage,
    pending,
    result: suggestionResult,
  } = llmDialog({
    system: systemPrompt,
    messages,
    tools: {
      fetchAndRunPattern: patternTool(fetchAndRunPattern),
      bash: patternTool(bash),
      searchSpace: patternTool(summarySearchPattern, {
        entries: summaryEntries,
      }),
      searchHistory: suggestionHistory.search,
      listMentionable: patternTool(listMentionable, { mentionable }),
      askUserQuestion: {
        handler: setQuestion({ pendingQuestion }),
        description:
          "Ask the user a clarifying question. Options are optional — if provided (2-4 strings), they appear as quick-select buttons alongside a free-text input. If omitted, only a text input is shown. After calling, STOP and wait for the user's answer. Input: { question: string, options?: string[] }",
      },
    },
    context,
    resultSchema: toSchema<{ cell: SuggestionResultCell }>(),
    queue: "suggestions",
  });

  const llmResult = computed(() => suggestionResult?.cell);

  // Reactively select between picker and LLM result. This must be a named
  // computed variable — the CTS transformer leaves named Cells as-is in the
  // return object, which lets wish.ts read the result via .get().
  const result = computed(() => {
    if (initialResults.length > 0) return pickerResult;
    return llmResult;
  });

  // Pre-create VNodes outside the computed so they're stable across
  // re-evaluations (creating VNodes inside a computed causes the
  // reconciler to re-mount the DOM, losing inner subscriptions).
  const freeformUI = (
    <div style="display:contents">
      <cf-autostart
        onstart={triggerGeneration({
          addMessage,
          situation,
          result: llmResult,
        })}
      />
      <cf-cell-link
        $cell={llmResult}
        style={computed(() => (llmResult ? "" : "display:none"))}
      />
      {ifElse(
        computed(() => !!llmResult),
        computed(() => llmResult),
        undefined,
      )}
      <cf-message-beads
        label="suggestion"
        $messages={messages}
        pending={pending}
        oncf-refine={showRefineInput({ showRefine })}
      />

      <cf-question
        question={computed(() => pendingQuestion.get()?.question ?? "")}
        options={computed(() => pendingQuestion.get()?.options ?? [])}
        allow-custom
        style={computed(() => (hasPendingQuestion ? "" : "display:none"))}
        oncf-answer={onQuestionAnswer({ addMessage, pendingQuestion })}
      />
      <cf-prompt-input
        placeholder="Refine suggestion..."
        pending={pending}
        style={computed(() => (showRefine.get() ? "" : "display:none"))}
        oncf-send={sendMessage({ addMessage })}
      />
    </div>
  );

  const pickerUI = (
    <cf-card>
      <h2>Choose Result ({initialResults.length})</h2>
      <cf-picker $items={initialResults} $selectedIndex={selectedIndex} />
      <cf-button
        variant="primary"
        onClick={() => userConfirmedIndex.set(selectedIndex.get())}
      >
        Confirm Selection
      </cf-button>
    </cf-card>
  );

  return {
    result,
    candidates: initialResults,
    // [UI] must be a static VNode — the reconciler breaks if it's a computed.
    // Switch between modes at the child level instead.
    [UI]: (
      <div style="display:contents">
        {computed(() => initialResults.length > 0) ? pickerUI : freeformUI}
      </div>
    ),
  };
});
