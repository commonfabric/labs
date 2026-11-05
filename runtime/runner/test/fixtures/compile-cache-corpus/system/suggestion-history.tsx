import {
  computed,
  type Default,
  NAME,
  pattern,
  type PatternFactory,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";

export type SuggestionHistoryEntry = {
  result: Writable<any>;
  messages: any[];
  timestamp: string;
};

type Input = Record<string, never>;
export type Output = {
  entries: SuggestionHistoryEntry[];
  search: PatternFactory<{ query: string }, SuggestionHistoryEntry[]>;
  [UI]: VNode;
};

function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p: any) => p.type === "text" && p.text)
      .map((p: any) => p.text)
      .join(" ");
  }
  return "";
}

function messageText(entry: SuggestionHistoryEntry): string {
  return (entry.messages ?? [])
    .filter((m: any) => m.role === "user")
    .map((m: any) => extractText(m.content))
    .join(" ");
}

export const searchPattern = pattern<
  { query: string; entries: SuggestionHistoryEntry[] },
  SuggestionHistoryEntry[]
>(({ query, entries }) => {
  return computed(() => {
    if (!query || query.trim() === "") return entries;
    const q = query.toLowerCase().trim();
    return entries.filter(
      (entry: SuggestionHistoryEntry) =>
        messageText(entry).toLowerCase().includes(q) ||
        (entry.timestamp ?? "").includes(q),
    );
  });
});

const SuggestionHistory = pattern<Input, Output>(() => {
  const { result: entries } = wish<SuggestionHistoryEntry[] | Default<[]>>({
    query: "#suggestions",
  });
  const allEntries = computed(() => entries ?? []);

  return {
    [NAME]: "Suggestion History",
    [UI]: (
      <cf-screen>
        <cf-grid columns="3" gap="4" padding="4">
          {allEntries.map((entry: SuggestionHistoryEntry) => (
            <div
              style={{
                border: "1px solid var(--cf-theme-color-border, #e5e5e7)",
                borderRadius: "12px",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: "100%",
                  height: "200px",
                  overflow: "hidden",
                  position: "relative",
                }}
              >
                <div
                  style={{
                    transform: "scale(0.4)",
                    transformOrigin: "top left",
                    width: "250%",
                    height: "250%",
                    pointerEvents: "none",
                  }}
                >
                  <cf-render $cell={entry.result} />
                </div>
              </div>
              <div style={{ padding: "8px" }}>
                <cf-cell-link $cell={entry.result} />
                <div
                  style={{
                    fontSize: "12px",
                    color: "var(--cf-theme-color-text-secondary)",
                  }}
                >
                  {entry.timestamp}
                </div>
              </div>
            </div>
          ))}
        </cf-grid>
      </cf-screen>
    ),
    entries: allEntries,
    search: pattern<{ query: string }, SuggestionHistoryEntry[]>(({ query }) =>
      searchPattern({ query, entries: allEntries })
    ),
  };
});

export default SuggestionHistory;
