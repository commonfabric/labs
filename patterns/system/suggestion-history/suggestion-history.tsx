/**
 * A gallery of past suggestion results, read from the piece tagged
 * `#suggestions`. Each appears as a scaled live preview with a link to open it
 * and its timestamp.
 * Other patterns can search it by what was asked, so a similar earlier result
 * can be reused.
 */

import {
  computed,
  type Default,
  type JSONObject,
  type JSONValue,
  NAME,
  pattern,
  patternTool,
  type PatternToolResult,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";

export type SuggestionHistoryEntry = {
  result: Writable<unknown>;
  messages: JSONValue[];
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

/** Whether `value` is a JSON object rather than an array or a primitive. */
function isJSONObject(value: JSONValue | undefined): value is JSONObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The text of a message's content: the content itself when it is a string,
 * the text parts joined when it is a list of parts, and otherwise nothing.
 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .flatMap((part: unknown) =>
        typeof part === "object" && part !== null && "type" in part &&
          part.type === "text" && "text" in part && part.text
          ? [part.text]
          : []
      )
      .join(" ");
  }
  return "";
}

function messageText(entry: SuggestionHistoryEntry): string {
  return (entry.messages ?? [])
    .flatMap((m) =>
      isJSONObject(m) && m.role === "user" ? [extractText(m.content)] : []
    )
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
  const { result: entries } = wish<
    Partial<SuggestionHistoryEntry>[] | Default<[]>
  >({
    query: "#suggestions",
  });
  const allEntries = computed((): SuggestionHistoryEntry[] =>
    Array.isArray(entries)
      ? entries.flatMap((entry) => isHistoryEntry(entry) ? [entry] : [])
      : []
  );

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
