import {
  type BuiltInLLMMessage,
  computed,
  handler,
  llmDialog,
  NAME,
  pattern,
  patternTool,
  type Stream,
  toSchema,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";
import { type MentionablePiece } from "./backlinks-index.tsx";
import {
  searchPattern as summarySearchPattern,
  type SummaryIndexEntry,
} from "./summary-index.tsx";
import { listMentionable } from "./common-fabric.tsx";

// ===== Types =====

type SpaceOverviewResult = {
  headline: string;
  themes: Array<{ name: string; description: string; relatedPieces: string[] }>;
  connections: Array<{ description: string; pieceNames: string[] }>;
  suggestions: string[];
};

type SpaceOverviewInput = Record<string, never>;

export interface SpaceOverviewOutput {
  [NAME]: string;
  [UI]: VNode;
  summary: string;
}

// ===== Handlers =====

const triggerAnalysis = handler<
  unknown,
  { addMessage: Stream<BuiltInLLMMessage> }
>((_, { addMessage }) => {
  addMessage.send({
    role: "user",
    content: [{
      type: "text" as const,
      text: "Analyze this space and give me an overview of what's here.",
    }],
  });
});

// ===== Main Pattern =====

export default pattern<SpaceOverviewInput, SpaceOverviewOutput>(() => {
  // Fetch space data references for tools
  const mentionable = wish<MentionablePiece[]>({
    query: "#mentionable",
  }).result;
  const { entries: summaryEntries } = wish<{ entries: SummaryIndexEntry[] }>({
    query: "#summaryIndex",
  }).result!;
  const profileWish = wish<string>({ query: "#learnedSummary" });
  const profileText = computed(() => profileWish.result ?? "");

  const systemPrompt = computed(() => {
    const profile = profileText;
    const profileSection = profile
      ? `\n\n--- User Context ---\n${profile}\n---`
      : "";

    return `You are a space orientation assistant. When activated, you explore the user's knowledge space using your tools and produce a clear, insightful overview of what's going on.

Process:
1. Use searchSpace to browse the space contents — search for broad terms and specific topics
2. Use listMentionable to get a full inventory
3. Synthesize what you find into a structured overview

After exploring, call the finalResult tool with your structured findings:
- headline: A punchy one-sentence summary of the space
- themes: 2-4 active themes or topic clusters you identified (each with name, description, and relatedPieces)
- connections: Notable connections between pieces (each with description and pieceNames)
- suggestions: 2-3 suggested next actions or things to explore

Conventions:
- Notes are prefixed with "📝 ", notebooks with "📓 "
- "Transcript:" notes contain raw voice memo captures
- "Capture Summary:" notes are reflections on ingestion sessions
- The "📓 Capture Log" notebook groups transcripts and summaries
- [[Wiki-links]] in note content indicate intentional connections

Be concise and insightful. Focus on patterns and connections, not just listing things. Reference actual piece names.${profileSection}`;
  });

  const messages = new Writable<BuiltInLLMMessage[]>([]);

  const llmTools = {
    searchSpace: patternTool(summarySearchPattern, {
      entries: summaryEntries,
    }),
    listMentionable: patternTool(listMentionable, { mentionable }),
  };

  const dialogParams = {
    system: systemPrompt,
    messages,
    tools: llmTools,
    model: "anthropic:claude-haiku-4-5" as const,
    builtinTools: false,
    resultSchema: toSchema<SpaceOverviewResult>(),
  };
  const { addMessage, pending, result } = llmDialog(dialogParams);

  const overview = computed(() => result as SpaceOverviewResult | undefined);

  const hasResult = computed(() => !!overview);
  const summary = computed(() => overview?.headline ?? "Space Overview");

  return {
    [NAME]: "Space Overview",
    [UI]: (
      <cf-screen>
        <cf-toolbar slot="header" sticky>
          <h2 style={{ margin: 0, fontSize: "18px" }}>Space Overview</h2>
        </cf-toolbar>

        <cf-autostart onstart={triggerAnalysis({ addMessage })} />

        <cf-vscroll flex showScrollbar fadeEdges>
          <cf-vstack gap="3" style="padding: 1rem;">
            <cf-message-beads
              label="overview"
              $messages={messages}
              pending={pending}
            />

            {hasResult
              ? (
                <cf-vstack gap="4">
                  <p
                    style={{
                      fontSize: "18px",
                      fontWeight: "600",
                      margin: 0,
                      lineHeight: "1.3",
                    }}
                  >
                    {overview?.headline}
                  </p>

                  <cf-vstack gap="2">
                    <h3
                      style={{
                        margin: 0,
                        fontSize: "14px",
                        color: "var(--cf-colors-gray-500)",
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                      }}
                    >
                      Themes
                    </h3>
                    {overview?.themes.map((theme) => (
                      <cf-vstack
                        gap="1"
                        style={{
                          padding: "0.75rem",
                          borderRadius: "8px",
                          background: "var(--cf-colors-gray-50)",
                        }}
                      >
                        <strong style={{ fontSize: "14px" }}>
                          {theme.name}
                        </strong>
                        <p
                          style={{
                            margin: 0,
                            fontSize: "13px",
                            color: "var(--cf-colors-gray-600)",
                          }}
                        >
                          {theme.description}
                        </p>
                      </cf-vstack>
                    ))}
                  </cf-vstack>

                  {computed(() => (overview?.connections?.length ?? 0) > 0)
                    ? (
                      <cf-vstack gap="1">
                        <h3
                          style={{
                            margin: 0,
                            fontSize: "14px",
                            color: "var(--cf-colors-gray-500)",
                            textTransform: "uppercase",
                            letterSpacing: "0.05em",
                          }}
                        >
                          Connections
                        </h3>
                        {overview?.connections.map((conn) => (
                          <p
                            style={{
                              margin: 0,
                              fontSize: "13px",
                              lineHeight: "1.4",
                            }}
                          >
                            {conn.description}
                          </p>
                        ))}
                      </cf-vstack>
                    )
                    : <span />}

                  <cf-vstack gap="1">
                    <h3
                      style={{
                        margin: 0,
                        fontSize: "14px",
                        color: "var(--cf-colors-gray-500)",
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                      }}
                    >
                      Explore Next
                    </h3>
                    <ul
                      style={{
                        margin: 0,
                        paddingLeft: "1.2rem",
                        fontSize: "14px",
                        lineHeight: "1.6",
                      }}
                    >
                      {overview?.suggestions.map((s) => <li>{s}</li>)}
                    </ul>
                  </cf-vstack>
                </cf-vstack>
              )
              : (
                <div style="text-align: center; color: var(--cf-colors-gray-500); padding: 2rem;">
                  {pending ? <span>Exploring the space...</span> : <span />}
                </div>
              )}
          </cf-vstack>
        </cf-vscroll>
      </cf-screen>
    ),
    summary,
  };
});
