/**
 * Journal viewer pattern.
 * Displays a rolling narrative stream of journal entries.
 *
 * Access via: wish({ query: "#journal" })
 */
import {
  computed,
  handler,
  NAME,
  pattern,
  toIndentedDebugString,
  UI,
  wish,
  Writable,
} from "commonfabric";

type JournalSubject = {
  [NAME]?: string;
};

// Raw journal entry as stored - subject is a cell link, not a Cell
type JournalEntry = {
  timestamp?: number;
  eventType?: string;
  subject?: Writable<JournalSubject>;
  snapshot?: {
    name?: string;
    schemaTag?: string;
    valueExcerpt?: string;
  };
  narrative?: string;
  tags?: string[];
  space?: string;
};

function formatTimestamp(
  timestamp: number | undefined,
  nowMs: number,
): string {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  const now = new Date(nowMs);
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}

function eventTypeLabel(eventType: string | undefined): string {
  if (!eventType) return "Unknown";
  const labels: Record<string, string> = {
    "piece:favorited": "Favorited",
    "piece:unfavorited": "Unfavorited",
    "piece:created": "Created",
    "piece:modified": "Modified",
    "space:entered": "Entered space",
  };
  return labels[eventType] || eventType;
}

function eventTypeEmoji(eventType: string | undefined): string {
  if (!eventType) return "\u2022";
  const emojis: Record<string, string> = {
    "piece:favorited": "\u2b50",
    "piece:unfavorited": "\u2606",
    "piece:created": "\u2795",
    "piece:modified": "\u270f\ufe0f",
    "space:entered": "\u27a1\ufe0f",
  };
  return emojis[eventType] || "\u2022";
}

const clearJournal = handler<
  Record<string, never>,
  { journal: Writable<JournalEntry[]> }
>((_, { journal }) => {
  journal.set([]);
});

export default pattern<Record<string, never>>((_) => {
  // Use wish() to access journal from home.tsx via defaultPattern
  const journalResult = wish<Array<JournalEntry>>({
    query: "#journal",
  });

  // Current time, ticking every 60 seconds so relative-time labels
  // ("just now", "5m ago", ...) refresh as time passes.
  const nowCell = wish<number>({ query: "#now/60" });

  // Debug: stringify raw result for the debug panel
  const debugRaw = computed(() => {
    const raw = journalResult.result;
    return toIndentedDebugString(raw);
  });

  // Most recent entries first
  const entries = computed(() => {
    const journal = journalResult.result || [];
    return [...journal].reverse();
  });

  const entryCount = computed(() => entries.length);

  return {
    [NAME]: "Journal",
    [UI]: (
      <div style={{ padding: "16px", maxWidth: "800px", margin: "0 auto" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "24px",
          }}
        >
          <h2 style={{ margin: "0" }}>Activity Journal</h2>
          {entryCount > 0 && (
            <cf-button
              onClick={clearJournal({ journal: journalResult.result! })}
              variant="secondary"
            >
              Clear Journal
            </cf-button>
          )}
        </div>

        {/* Debug section */}
        <details style={{ marginBottom: "16px", fontSize: "12px" }}>
          <summary>Debug: Raw Data</summary>
          <pre
            style={{
              overflow: "auto",
              maxHeight: "200px",
              background: "#f5f5f5",
              padding: "8px",
            }}
          >
            {debugRaw}
          </pre>
        </details>

        {entryCount === 0 && (
          <div
            style={{
              textAlign: "center",
              padding: "40px",
              color: "#666",
            }}
          >
            <p>No journal entries yet.</p>
            <p style={{ fontSize: "0.9em" }}>
              Favorite some pieces to start building your journal.
            </p>
          </div>
        )}

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "16px",
          }}
        >
          {entries.map((entry) => (
            <div
              style={{
                border: "1px solid #e0e0e0",
                borderRadius: "8px",
                padding: "16px",
                backgroundColor: "#fff",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  marginBottom: "8px",
                }}
              >
                <span style={{ fontSize: "1.2em" }}>
                  {eventTypeEmoji(entry.eventType)}
                </span>
                <span
                  style={{
                    fontWeight: "500",
                    color: "#1976d2",
                  }}
                >
                  {eventTypeLabel(entry.eventType)}
                </span>
                <span
                  style={{
                    marginLeft: "auto",
                    fontSize: "0.85em",
                    color: "#666",
                  }}
                >
                  {nowCell.result == null
                    ? ""
                    : formatTimestamp(entry.timestamp, nowCell.result)}
                </span>
              </div>

              {entry.narrative && (
                <p
                  style={{
                    margin: "8px 0",
                    lineHeight: "1.5",
                    color: "#333",
                  }}
                >
                  {entry.narrative}
                </p>
              )}

              {entry.snapshot?.name && (
                <div
                  style={{
                    marginTop: "8px",
                    fontSize: "0.9em",
                    color: "#555",
                  }}
                >
                  {entry.snapshot.name}:{" "}
                  {entry.subject && <cf-cell-link $cell={entry.subject} />}
                </div>
              )}

              {entry.tags && entry.tags.length > 0 && (
                <div
                  style={{
                    marginTop: "8px",
                    display: "flex",
                    gap: "4px",
                    flexWrap: "wrap",
                  }}
                >
                  {entry.tags.map((tag: string) => (
                    <span
                      style={{
                        fontSize: "0.8em",
                        padding: "2px 8px",
                        borderRadius: "12px",
                        backgroundColor: "#e3f2fd",
                        color: "#1565c0",
                      }}
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    ),
  };
});
