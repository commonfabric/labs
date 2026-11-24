/**
 * A gallery of past suggestion results, read from the piece tagged
 * `#suggestions`. Each appears as a scaled live preview with a link to open it
 * and its timestamp.
 * Other patterns can search it by what was asked, so a similar earlier result
 * can be reused.
 */

import {
  type AsyncResult,
  computed,
  type Default,
  hasError,
  lift,
  NAME,
  pattern,
  patternTool,
  type PatternToolResult,
  resultOf,
  UI,
  type VNode,
  wish,
  type WishErrorCode,
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
  search: PatternToolResult<{ entries: SuggestionHistoryEntry[] }>;
  [UI]: VNode;
};

function isHistoryEntry(
  entry: Partial<SuggestionHistoryEntry> | undefined,
): entry is SuggestionHistoryEntry {
  return entry?.result != null && Array.isArray(entry.messages);
}

/** Selects valid history entries, preserving failures other than confirmed absence. */
export const historyEntries = lift<{
  response: AsyncResult<Partial<SuggestionHistoryEntry>[]>;
  errorCode?: WishErrorCode;
}, SuggestionHistoryEntry[]>(({ response, errorCode }) => {
  if (hasError(response)) {
    if (errorCode === "no-match") return [];
    return resultOf<SuggestionHistoryEntry[]>(response);
  }
  return resultOf(response).filter(isHistoryEntry);
});

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
  // `#suggestions` is an ordinary hashtag, so what the wish finds is a piece
  // tagged with it, not a history list. Only entries shaped as history are
  // read; anything else reads as no entries. The wish asks for entries with
  // every field optional, since one entry missing a field would otherwise
  // fail the whole read and leave no history at all.
  const history = wish<
    Partial<SuggestionHistoryEntry>[] | Default<[]>
  >({
    query: "#suggestions",
  });
  const allEntries = historyEntries({
    response: history.result,
    errorCode: history.errorCode,
  });

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
    search: patternTool(searchPattern, { entries: allEntries }),
  };
});

export default SuggestionHistory;
