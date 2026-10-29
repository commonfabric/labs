import {
  computed,
  type Default,
  generateText,
  handler,
  NAME,
  navigateTo,
  pattern,
  SELF,
  Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";

// Type for backlinks (inline to work around CLI path resolution bug)
type MentionablePiece = {
  [NAME]?: string;
  isHidden?: boolean;
  content?: string;
  mentioned: MentionablePiece[];
  backlinks: MentionablePiece[];
};

type MinimalPiece = {
  [NAME]?: string;
};

// Default system prompt - based on leaked/inferred Claude system prompt style
const DEFAULT_SYSTEM_PROMPT =
  `You are Claude, a helpful AI assistant created by Anthropic. You are direct, helpful, and thoughtful in your responses. You aim to be truthful and you acknowledge uncertainty when relevant. You engage naturally with the human while maintaining appropriate boundaries.`;

// Available models for selection
const MODELS = [
  { id: "anthropic:claude-sonnet-4-5", label: "Sonnet 4.5" },
  { id: "anthropic:claude-haiku-4-5", label: "Haiku 4.5" },
  { id: "anthropic:claude-opus-4-1", label: "Opus 4.1" },
] as const;

type Input = {
  title?: Writable<string | Default<"Chat Note">>;
  content?: Writable<string | Default<"">>;
  isHidden?: boolean | Default<false>;
  noteId?: string | Default<"">;

  /** Pattern JSON for [[wiki-links]]. Defaults to creating new ChatNotes. */
  linkPattern?: Writable<string | Default<"">>;

  /** Parent notebook reference (passed via SELF from notebook.tsx) */
  parentNotebook?: any;

  /** Selected model for generation. Defaults to Sonnet 4.5 */
  model?: Writable<string | Default<"anthropic:claude-sonnet-4-5">>;
};

type LLMMessage = {
  role: "user" | "assistant";
  content: string;
};

/** Represents a chat-enabled note with inline LLM conversations. */
export type Output = {
  [NAME]?: string;
  [UI]: VNode;
  mentioned: Array<MentionablePiece> | Default<[]>;
  backlinks: MentionablePiece[];
  parentNotebook: any;
  content: string | Default<"">;
  isHidden: boolean | Default<false>;
  noteId: string | Default<"">;
  isGenerating: boolean;
  editContent: Stream<{ detail: { value: string } }>;
};

// Parse document content into LLM messages
// Format:
// - First section starting with "## System" becomes the system prompt
// - Sections separated by --- horizontal rules
// - Sections with ## AI or ## Assistant header are assistant messages
// - Other sections are user messages
function parseContentToMessages(
  content: string,
  mentionable: MentionablePiece[],
): { system: string; messages: LLMMessage[] } {
  if (!content.trim()) {
    return { system: DEFAULT_SYSTEM_PROMPT, messages: [] };
  }

  // Expand wiki links before parsing
  const expandedContent = expandWikiLinks(content, mentionable);

  // Split by horizontal rules (--- on its own line)
  const sections = expandedContent.split(/\n---+\n/).map((s) => s.trim());

  let system = DEFAULT_SYSTEM_PROMPT;
  const messages: LLMMessage[] = [];

  let startIndex = 0;

  // Check if first section is a system prompt
  if (sections.length > 0 && sections[0].match(/^##\s*[Ss]ystem\b/)) {
    // Extract content after the header
    const systemContent = sections[0]
      .replace(/^##\s*[Ss]ystem\b\s*\n?/, "")
      .trim();
    if (systemContent) {
      system = systemContent;
    }
    startIndex = 1;
  }

  // Process remaining sections
  for (let i = startIndex; i < sections.length; i++) {
    const section = sections[i];
    if (!section) continue;

    // Check if this is an assistant message (## AI or ## Assistant)
    const isAssistant = section.match(/^##\s*(?:AI|Assistant)\b/i);

    if (isAssistant) {
      // Remove the header and get the content
      const assistantContent = section
        .replace(/^##\s*(?:AI|Assistant)\b\s*\n?/i, "")
        .trim();
      if (assistantContent) {
        messages.push({ role: "assistant", content: assistantContent });
      }
    } else {
      // User message - use the whole section
      if (section) {
        messages.push({ role: "user", content: section });
      }
    }
  }

  // Coalesce adjacent same-role messages
  const coalescedMessages: LLMMessage[] = [];
  for (const msg of messages) {
    const last = coalescedMessages[coalescedMessages.length - 1];
    if (last && last.role === msg.role) {
      last.content += "\n\n" + msg.content;
    } else {
      coalescedMessages.push({ ...msg });
    }
  }

  return { system, messages: coalescedMessages };
}

// Expand [[wiki links]] with the content of referenced notes
// Format: [[Name (id)]] -> ## [Name]\n[content of linked note]
function expandWikiLinks(
  text: string,
  mentionable: MentionablePiece[],
): string {
  // Match [[Name (id)]] pattern
  const wikiLinkRegex = /\[\[([^\]]*?)\s*\(([^)]+)\)\]\]/g;

  return text.replace(wikiLinkRegex, (match, name, id) => {
    // Find the piece by ID
    const piece = mentionable?.find((c: any) => {
      // Check various ways the ID might be stored
      const pieceId = c?.id || c?.noteId || (c as any)?.$id ||
        (c as any)?.["$ID"];
      return pieceId === id;
    });

    if (piece && piece.content) {
      return `## ${name.trim()}\n${piece.content}`;
    }

    // If we can't find the content, keep the original link
    return match;
  });
}

const _updateContent = handler<
  { detail: { value: string } },
  { content: Writable<string> }
>((event, state) => {
  state.content.set(event.detail?.value ?? "");
});

const handlePieceLinkClick = handler<
  {
    detail: {
      piece: Writable<MentionablePiece>;
    };
  },
  Record<string, never>
>(({ detail }, _) => {
  return navigateTo(detail.piece);
});

const handleNewBacklink = handler<
  {
    detail: {
      text: string;
      pieceId: any;
      piece: Writable<MentionablePiece>;
      navigate: boolean;
    };
  },
  {
    mentionable: Writable<MentionablePiece[]>;
    pieceRegistry: Writable<MinimalPiece[]>;
  }
>(({ detail }, { mentionable, pieceRegistry }) => {
  pieceRegistry.push(detail.piece);

  if (detail.navigate) {
    return navigateTo(detail.piece);
  } else {
    mentionable.push(detail.piece);
  }
});

const handleEditContent = handler<
  { detail: { value: string }; result?: Writable<string> },
  { content: Writable<string> }
>(({ detail, result }, { content }) => {
  content.set(detail.value);
  result?.set("updated");
});

const handlePieceLinkClicked = handler<
  void,
  { piece: Writable<MentionablePiece> }
>((_, { piece }) => {
  return navigateTo(piece);
});

// Handler to start editing title
const startEditingTitle = handler<
  Record<string, never>,
  { isEditingTitle: Writable<boolean> }
>((_, { isEditingTitle }) => {
  isEditingTitle.set(true);
});

// Handler to stop editing title
const stopEditingTitle = handler<
  Record<string, never>,
  { isEditingTitle: Writable<boolean> }
>((_, { isEditingTitle }) => {
  isEditingTitle.set(false);
});

// Handler for keydown on title input (Enter to save)
const handleTitleKeydown = handler<
  { key?: string },
  { isEditingTitle: Writable<boolean> }
>((event, { isEditingTitle }) => {
  if (event?.key === "Enter") {
    isEditingTitle.set(false);
  }
});

// Handler for Generate button - triggers LLM generation
// Event type matches both onClick (unknown) and oncf-submit ({ value: string })
const handleGenerate = handler<
  { value?: string },
  {
    content: Writable<string>;
    llmSystem: Writable<string>;
    llmMessages: Writable<LLMMessage[]>;
    isGenerating: Writable<boolean>;
    mentionable: any;
    beforeAIInsert: Writable<string>;
  }
>((_event, state) => {
  const currentContent = state.content.get();

  // Parse entire content into messages - get raw array from mentionable
  const mentionableArray = Array.isArray(state.mentionable)
    ? state.mentionable
    : state.mentionable?.get?.() ?? [];
  const { system, messages } = parseContentToMessages(
    currentContent,
    mentionableArray,
  );

  // If there are no messages, don't generate
  if (messages.length === 0) {
    return;
  }

  // Ensure last message is from user
  const lastMessage = messages[messages.length - 1];
  if (lastMessage && lastMessage.role === "assistant") {
    // Don't generate if last message is already from assistant
    return;
  }

  // Add the AI response separator to content
  const separator = currentContent.endsWith("\n")
    ? "---\n## AI\n"
    : "\n---\n## AI\n";
  const newContent = currentContent + separator;
  state.content.set(newContent);

  // Save the prefix for streaming display
  state.beforeAIInsert.set(newContent);

  // Set up the LLM call
  state.llmSystem.set(system);
  state.llmMessages.set(messages);
  state.isGenerating.set(true);
});

// Handler to cancel generation
const handleCancelGeneration = handler<
  void,
  {
    isGenerating: Writable<boolean>;
    llmMessages: Writable<LLMMessage[]>;
  }
>((_, state) => {
  state.isGenerating.set(false);
  // Clear messages to stop the LLM
  state.llmMessages.set([]);
});

// Navigate to parent notebook
const goToParent = handler<Record<string, never>, { self: any }>(
  (_, { self }) => {
    const p = (self as any).parentNotebook;
    if (p) navigateTo(p);
  },
);

// Handler for model selection change
const handleModelChange = handler<
  { target: { value: string } },
  { model: Writable<string> }
>(({ target }, { model }) => {
  model.set(target.value);
});

const ChatNote = pattern<Input, Output>(
  ({
    title,
    content,
    isHidden,
    noteId,
    linkPattern,
    parentNotebook: parentNotebookProp,
    model,
    [SELF]: self,
  }) => {
    const pieceRegistry = wish<MinimalPiece[] | Default<[]>>({
      query: "#pieceRegistry",
    }).result!;
    const mentionable = wish<MentionablePiece[] | Default<[]>>({
      query: "#mentionable",
    }).result!;
    const mentioned = new Writable<MentionablePiece[]>([]);
    const backlinks = new Writable<MentionablePiece[]>([]);

    // State for inline title editing
    const isEditingTitle = new Writable<boolean>(false);

    // LLM state
    const isGenerating = new Writable<boolean>(false);
    const llmSystem = new Writable<string>("");
    const llmMessages = new Writable<LLMMessage[]>([]);

    // LLM call - reactive based on llmMessages
    const llmResponse = generateText({
      system: llmSystem,
      messages: llmMessages,
      model: model,
    });

    // Track content before AI insertion point for streaming display
    const beforeAIInsert = new Writable<string>("");

    // Watch for LLM streaming partial updates
    // Side-effect-only reactive computation: tracks its reactive reads
    // (isGenerating, llmResponse.partial, beforeAIInsert) automatically.
    computed(() => {
      const generating = isGenerating.get();
      const partial = llmResponse.partial;
      const prefix = beforeAIInsert.get();
      if (generating && partial && prefix) {
        content.set(prefix + partial);
      }
    });

    // Watch for LLM completion
    // Side-effect-only reactive computation; reactive reads tracked automatically.
    computed(() => {
      const generating = isGenerating.get();
      const pending = llmResponse.pending;
      const result = llmResponse.result;
      // When complete, finalize with result and closing separator
      if (!pending && result && generating) {
        const prefix = beforeAIInsert.get();
        if (prefix) {
          content.set(prefix + result + "\n---\n");
        }
        isGenerating.set(false);
        llmMessages.set([]);
        beforeAIInsert.set("");
      }
    });

    // Compute parent notebook
    const parentNotebook = computed(() => {
      const selfParent = (self as any)?.parentNotebook;
      if (selfParent) return selfParent;
      if (parentNotebookProp) return parentNotebookProp;
      return null;
    });

    // Use provided linkPattern or default to creating new ChatNotes
    const patternJson = computed(() => {
      const lpValue = (linkPattern as any)?.get?.() ?? linkPattern;
      const custom = typeof lpValue === "string" ? lpValue.trim() : "";
      return custom || JSON.stringify(ChatNote);
    });

    // Generation state display (reactive expression auto-wraps at use sites)
    const showGenerating = isGenerating.get() && llmResponse.pending;

    // Can generate when there's content and not already generating
    // Optimized to avoid splitting entire content on every keystroke
    const canGenerate = computed(() => {
      if (isGenerating.get()) return false;
      const currentContent = content.get();
      if (!currentContent.trim()) return false;

      // Find the last section separator efficiently using lastIndexOf
      const lastSepIdx = currentContent.lastIndexOf("\n---");
      let lastSection: string;
      if (lastSepIdx === -1) {
        lastSection = currentContent;
      } else {
        // Find the end of the separator line (skip past the ---\n)
        const afterSep = currentContent.indexOf("\n", lastSepIdx + 4);
        lastSection = afterSep === -1
          ? currentContent.substring(lastSepIdx + 4)
          : currentContent.substring(afterSep + 1);
      }

      const trimmedLast = lastSection.trim();
      if (!trimmedLast) return false;

      // If last section starts with ## AI, we can't generate
      if (trimmedLast.match(/^##\s*(?:AI|Assistant)\b/i)) return false;

      return true;
    });

    // Model change handler
    const modelChangeHandler = handleModelChange({ model });

    return {
      [NAME]: `💬 ${title.get()}`,
      [UI]: (
        <cf-screen>
          <cf-vstack
            slot="header"
            gap="2"
            padding="4"
            style={{
              borderBottom: "1px solid var(--cf-theme-color-border, #e5e5e7)",
            }}
          >
            {/* Parent notebook chip */}
            <cf-hstack
              gap="2"
              align="center"
              style={{
                display: (self as any).parentNotebook ? "flex" : "none",
                marginBottom: "4px",
              }}
            >
              <span
                style={{
                  fontSize: "13px",
                  color: "var(--cf-theme-color-text-secondary)",
                }}
              >
                In:
              </span>
              <cf-chip
                label={(self as any).parentNotebook?.[NAME] ??
                  (self as any).parentNotebook?.title ?? "Notebook"}
                interactive
                oncf-click={goToParent({ self })}
              />
            </cf-hstack>

            <cf-hstack gap="3" style={{ alignItems: "center" }}>
              {/* Editable Title - click to edit */}
              <div
                style={{
                  display: isEditingTitle.get() ? "none" : "flex",
                  alignItems: "center",
                  gap: "8px",
                  cursor: "pointer",
                  flex: 1,
                }}
                onClick={startEditingTitle({ isEditingTitle })}
              >
                <span
                  style={{ margin: 0, fontSize: "15px", fontWeight: "600" }}
                >
                  {title}
                </span>
              </div>
              <div
                style={{
                  display: isEditingTitle.get() ? "flex" : "none",
                  flex: 1,
                  marginRight: "12px",
                }}
              >
                <cf-input
                  $value={title}
                  placeholder="Chat note title..."
                  style={{ flex: 1 }}
                  oncf-blur={stopEditingTitle({ isEditingTitle })}
                  oncf-keydown={handleTitleKeydown({ isEditingTitle })}
                />
              </div>

              {/* Model selector */}
              <select
                value={model}
                onChange={modelChangeHandler}
                style={{
                  display: showGenerating ? "none" : "block",
                  padding: "4px 8px",
                  fontSize: "13px",
                  borderRadius: "6px",
                  border: "1px solid var(--cf-theme-color-border, #e5e5e7)",
                  background: "var(--cf-theme-color-background, white)",
                  cursor: "pointer",
                }}
              >
                {MODELS.map((m) => <option value={m.id}>{m.label}</option>)}
              </select>

              {/* Generate button - shown when not generating */}
              <cf-button
                variant="primary"
                size="sm"
                onClick={handleGenerate({
                  content,
                  llmSystem,
                  llmMessages,
                  isGenerating,
                  mentionable,
                  beforeAIInsert,
                })}
                disabled={!canGenerate}
                style={{
                  display: showGenerating ? "none" : "flex",
                }}
                title="Generate (Cmd+Enter)"
              >
                Generate
              </cf-button>

              {/* Generation status / Cancel button - shown when generating */}
              <cf-hstack
                gap="2"
                align="center"
                style={{
                  display: showGenerating ? "flex" : "none",
                  flexShrink: 0,
                }}
              >
                <cf-loader show-elapsed style={{ flexShrink: 0 }} />
                <cf-button
                  variant="secondary"
                  size="sm"
                  onClick={handleCancelGeneration({
                    isGenerating,
                    llmMessages,
                  })}
                  style={{ flexShrink: 0 }}
                >
                  Cancel
                </cf-button>
              </cf-hstack>
            </cf-hstack>
          </cf-vstack>

          {/* Keyboard shortcut: Cmd+Enter to generate */}
          <cf-keybind
            code="Enter"
            meta
            ignore-editable={false}
            oncf-keybind={handleGenerate({
              content,
              llmSystem,
              llmMessages,
              isGenerating,
              mentionable,
              beforeAIInsert,
            })}
          />
          {/* Keyboard shortcut: Ctrl+Enter to generate (Windows/Linux) */}
          <cf-keybind
            code="Enter"
            ctrl
            ignore-editable={false}
            oncf-keybind={handleGenerate({
              content,
              llmSystem,
              llmMessages,
              isGenerating,
              mentionable,
              beforeAIInsert,
            })}
          />

          {/* Editor */}
          <cf-code-editor
            $value={content}
            $mentionable={mentionable}
            $mentioned={mentioned}
            $pattern={patternJson}
            onbacklink-click={handlePieceLinkClick({})}
            onbacklink-create={handleNewBacklink({
              mentionable,
              pieceRegistry,
            })}
            language="text/markdown"
            theme="light"
            wordWrap
            tabIndent
            lineNumbers
            readonly={isGenerating}
          />

          <cf-hstack slot="footer">
            {backlinks?.map((piece) => (
              <cf-button onClick={handlePieceLinkClicked({ piece })}>
                {piece?.[NAME]}
              </cf-button>
            ))}
          </cf-hstack>
        </cf-screen>
      ),
      title,
      content,
      mentioned,
      backlinks,
      parentNotebook,
      isHidden,
      noteId,
      isGenerating,
      editContent: handleEditContent({ content }),
    };
  },
);

export default ChatNote;
