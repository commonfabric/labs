import {
  computed,
  fetchText,
  handler,
  NAME,
  navigateTo,
  pattern,
  patternTool,
  Stream,
  UI,
  when,
  wish,
  Writable,
} from "commonfabric";
import Chatbot from "../chatbot.tsx";
import {
  bash,
  calculator,
  fetchAndRunPattern,
  listMentionable,
  navigateToPattern,
  readWebpage,
  searchWeb,
  updateProfile,
} from "./common-fabric.tsx";
import { MentionablePiece } from "./backlinks-index.tsx";
import {
  searchPattern as summarySearchPattern,
  type SummaryIndexEntry,
} from "./summary-index.tsx";

interface OmniboxFABInput {
  mentionable: Writable<MentionablePiece[]>;
  extraTools: any;
  extraSystemPrompt: string;
}

const toggle = handler<any, { value: Writable<boolean> }>((_, { value }) => {
  value.set(!value.get());
});

const closeFab = handler<any, { fabExpanded: Writable<boolean> }>(
  (_, { fabExpanded }) => {
    fabExpanded.set(false);
  },
);

const dismissPeek = handler<
  any,
  { peekDismissedIndex: Writable<number>; assistantMessageCount: number }
>((_, { peekDismissedIndex, assistantMessageCount }) => {
  peekDismissedIndex.set(assistantMessageCount);
});

const handleDropToPin = handler<
  any,
  {
    pinToChat: Stream<{ path: string; name: string; accumulate: boolean }>;
    fabExpanded: Writable<boolean>;
  }
>((event, { pinToChat, fabExpanded }) => {
  const ref = event.detail?.sourceCellRef;
  if (!ref) return;

  const path = ref.path && ref.path.length > 0
    ? `/${ref.id}/${ref.path.join("/")}`
    : `/${ref.id}`;

  // Try to get name from the cell's value, fall back to truncated ID
  const sourceCell = event.detail?.sourceCell;
  const cellName = sourceCell?.[NAME];
  const name = cellName || `Cell #${ref.id.slice(-6)}`;

  // Drop always replaces; use pin button + Shift to accumulate
  pinToChat.send({ path, name, accumulate: false });
  fabExpanded.set(true);
});

const handleExternalPin = handler<
  { path: string; name: string; accumulate: boolean },
  {
    pinToChat: Stream<{ path: string; name: string; accumulate: boolean }>;
    fabExpanded: Writable<boolean>;
  }
>((event, { pinToChat, fabExpanded }) => {
  pinToChat.send({
    path: event.path,
    name: event.name,
    accumulate: event.accumulate,
  });
  fabExpanded.set(true);
});

/** Wish for a #tag or a custom query with optional linked context. Automatically navigates to the result. */
type WishToolParameters = {
  query: string;
  context?: Record<string, any>;
};

const wishTool = pattern<WishToolParameters, boolean>(
  ({ query, context }) => {
    // Context may not have been provided.
    const wishParams = computed(() => {
      return { query, ...(context && { context }) };
    });
    const wishResult = wish<any>(wishParams);

    // Navigate to wishResult.result (the actual cell), not the entire wish state object
    return when(wishResult.result, navigateTo(wishResult.result));
  },
);

export default pattern<OmniboxFABInput>(
  ({ extraTools, extraSystemPrompt }) => {
    const mentionable =
      wish<MentionablePiece[]>({ query: "#mentionable" }).result;
    const { entries: summaryEntries } = wish<{
      entries: SummaryIndexEntry[];
    }>({ query: "#summaryIndex" }).result!;

    const profile = wish<string>({ query: "#learnedSummary" });

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
      return profileText
        ? `\n\n--- User Context ---\n${profileText}\n---\n`
        : "";
    });

    const systemPrompt = computed(() => {
      const profileSection = profileContext;
      const indexText = patternIndex
        ? `\n\n--- Available Patterns ---\n${patternIndex}\n---`
        : "";
      return `You are a polite but efficient assistant. Think Star Trek computer - helpful and professional without unnecessary conversation. Let your actions speak for themselves.
${profileSection}${indexText}
Tool usage priority:
- For finding content in the space: use searchSpace with a query to search the indexed mentionable pieces that have nonempty summaries
- For patterns: review the available patterns listed above, then use fetchAndRunPattern to instantiate one
- For existing pages/notes/content: searchSpace first, then listMentionable to identify what they're referencing
- Attach relevant items to conversation after instantiation/retrieval if they support ongoing tasks
- Remove attachments when no longer relevant
- Search web only as last resort when nothing exists in the space
- Use bash to run shell commands in a persistent Linux sandbox (Ubuntu). Installed packages and files persist across calls.
${extraSystemPrompt}
Be matter-of-fact. Prefer action to explanation.`;
    });

    const baseTools = {
      searchWeb: {
        pattern: searchWeb,
      },
      readWebpage: {
        pattern: readWebpage,
      },
      calculator: {
        pattern: calculator,
      },
      fetchAndRunPattern: patternTool(fetchAndRunPattern),
      navigateTo: patternTool(navigateToPattern),
      wishAndNavigate: patternTool(wishTool),
      listMentionable: patternTool(listMentionable, { mentionable }),
      updateProfile: patternTool(updateProfile),
      bash: patternTool(bash),
      searchSpace: patternTool(summarySearchPattern, {
        entries: summaryEntries,
      }),
    };

    const allTools = computed(() => ({
      ...baseTools,
      ...extraTools,
    }));

    const omnibot = Chatbot({
      system: systemPrompt,
      tools: allTools,
    });

    const fabExpanded = new Writable(false);
    const showHistory = new Writable(false);
    const peekDismissedIndex = new Writable(-1);

    // Derive pin count for collapsed state dots
    const pinCount = computed(() => {
      const pinned = omnibot.pinnedCells;
      return pinned ? pinned.length : 0;
    });

    // Derive assistant message count for dismiss tracking
    const assistantMessageCount = computed(() => {
      return omnibot.messages
        ? omnibot.messages.filter((m) => m.role === "assistant").length
        : 0;
    });

    // Derive latest assistant message for peek
    const latestAssistantMessage = computed(() => {
      if (!omnibot.messages || omnibot.messages.length === 0) return null;

      for (let i = omnibot.messages.length - 1; i >= 0; i--) {
        const msg = omnibot.messages[i];
        if (msg.role === "assistant") {
          const content = typeof msg.content === "string"
            ? msg.content
            : msg.content.map((part: any) => {
              if (part.type === "text") return part.text;
              return "";
            }).join("");

          return content;
        }
      }
      return null;
    });

    return {
      [NAME]: "OmniboxFAB",
      messages: omnibot.messages,
      [UI]: (
        <cf-drop-zone
          accept="cell-link"
          style="position: fixed; bottom: 0; left: 50%; transform: translateX(-50%); z-index: 997;"
          oncf-drop={handleDropToPin({
            pinToChat: omnibot.pinToChat,
            fabExpanded,
          })}
        >
          <cf-fab
            expanded={fabExpanded}
            variant="primary"
            position="bottom-center"
            pending={omnibot.pending}
            pinCount={pinCount}
            $messages={omnibot.messages}
            $previewMessage={latestAssistantMessage}
            placeholder="Ask about anything..."
            oncf-fab-backdrop-click={closeFab({ fabExpanded })}
            oncf-fab-escape={closeFab({ fabExpanded })}
            onClick={toggle({ value: fabExpanded })}
          >
            {fabExpanded
              ? (
                <div style="width: 100%; display: flex; flex-direction: column; max-height: 580px;">
                  {/* Chevron to expand chat history */}
                  <div style="display: flex; justify-content: center; flex-shrink: 0;">
                    <cf-chevron-button
                      expanded={showHistory}
                      loading={omnibot.pending}
                      oncf-toggle={toggle({ value: showHistory })}
                    />
                  </div>

                  {/* Pinned items / attachments - always visible */}
                  <div style="padding: 4px 8px; flex-shrink: 0;">
                    {omnibot.ui.attachmentsAndTools}
                  </div>

                  {/* Expandable chat history */}
                  <div
                    style={computed(() => {
                      const show = showHistory.get();
                      return `flex: ${
                        show ? "1" : "0"
                      }; min-height: 0; display: flex; flex-direction: column; opacity: ${
                        show ? "1" : "0"
                      }; max-height: ${
                        show ? "480px" : "0"
                      }; overflow: hidden; transition: opacity 200ms ease, max-height 300ms ease; pointer-events: ${
                        show ? "auto" : "none"
                      };`;
                    })}
                  >
                    <div style="flex: 1; overflow-y: auto; min-height: 0;">
                      {omnibot.ui.chatLog}
                    </div>
                  </div>

                  {computed(() => {
                      const show = showHistory.get();
                      const dismissedIdx = peekDismissedIndex.get();
                      return !show && latestAssistantMessage &&
                        assistantMessageCount !== dismissedIdx;
                    })
                    ? (
                      <div style="margin: 4px 8px 0; padding: 0; flex-shrink: 0; position: relative;">
                        <cf-button
                          variant="ghost"
                          size="icon"
                          onClick={dismissPeek({
                            peekDismissedIndex,
                            assistantMessageCount,
                          })}
                          style="position: absolute; top: 0px; right: 0px; z-index: 1; font-size: 16px;"
                          title="Dismiss"
                        >
                          ×
                        </cf-button>
                        <div
                          onClick={toggle({ value: showHistory })}
                          style="cursor: pointer;"
                        >
                          <cf-chat-message
                            role="assistant"
                            compact
                            content={latestAssistantMessage ?? ""}
                            pending={omnibot.pending}
                          />
                        </div>
                      </div>
                    )
                    : null}

                  {/* Prompt input */}
                  <div style="padding: 4px 8px 8px; flex-shrink: 0;">
                    {omnibot.ui.promptInput}
                  </div>
                </div>
              )
              : null}
          </cf-fab>
        </cf-drop-zone>
      ),
      fabExpanded,
      pinToChat: handleExternalPin({
        pinToChat: omnibot.pinToChat,
        fabExpanded,
      }),
    };
  },
);
