/**
 * Folksonomy Aggregator - Community Tag Telemetry Piece
 *
 * This piece collects tag usage events from folksonomy-tags instances and
 * computes community suggestions ranked by usage count (preferential attachment).
 *
 * SETUP: After deploying, FAVORITE this piece with tag "folksonomyAggregator"
 * so that folksonomy-tags instances can discover it via wish("#folksonomyAggregator").
 *
 * HOW IT WORKS:
 * 1. folksonomy-tags instances post events via the postEvent stream
 * 2. This aggregator stores events and computes suggestions by scope
 * 3. Suggestions are sorted by count (most used first) for preferential attachment
 *
 * CFC: When Contextual Flow Control is implemented, this aggregator will only
 * include tags in community suggestions if 5+ independent users have posted
 * the same scope+tag combination. This protects individual tagging choices
 * while enabling wisdom of crowds.
 */
import {
  computed,
  type Default,
  handler,
  NAME,
  pattern,
  Stream,
  UI,
  Writable,
} from "commonfabric";

/**
 * Tag event posted by folksonomy-tags instances.
 */
interface TagEvent {
  scope: string;
  tag: string;
  action: "add" | "use" | "remove";
  timestamp: number;
  // CFC: In the future, Contextual Flow Control will enforce that
  // the user's identity is only included in the aggregate if
  // 5+ independent users have posted the same scope+tag combo.
  // For now, we track events but don't expose user identity.
}

/**
 * Community tag suggestion with usage count.
 */
interface CommunityTagSuggestion {
  tag: string;
  count: number;
  // CFC: Future uniqueUsers field for threshold enforcement
}

interface Input {
  events: TagEvent[] | Default<[]>;
}

/**
 * A #folksonomyAggregator that collects tag usage events and serves community suggestions.
 *
 * The #folksonomyAggregator tag is how folksonomy-tags instances discover this piece via wish().
 */
export interface Output {
  events: TagEvent[];
  suggestions: Record<string, CommunityTagSuggestion[]>;
  postEvent: Stream<TagEvent>;
}

// Handler for receiving new tag events
const handlePostEvent = handler<TagEvent, { events: Writable<TagEvent[]> }>(
  (event, { events }) => {
    // Validate the event has required fields
    if (!event?.scope || !event?.tag || !event?.action) {
      console.warn("[folksonomy-aggregator] Invalid event received:", event);
      return;
    }

    const currentEvents = events.get() || [];
    const newEvent: TagEvent = {
      scope: event.scope,
      tag: event.tag,
      action: event.action,
      timestamp: event.timestamp || Date.now(),
    };

    // Add the new event to the list
    events.set([...currentEvents, newEvent]);
  },
);

export default pattern<Input, Output>(({ events }) => {
  // Compute suggestions by scope - aggregates all events into usage counts
  const suggestions = computed(() => {
    const eventList = (events || []) as TagEvent[];
    const byScope: Record<string, Map<string, number>> = {};

    for (const event of eventList) {
      if (!event?.scope || !event?.tag) continue;

      if (!byScope[event.scope]) {
        byScope[event.scope] = new Map();
      }

      const scopeMap = byScope[event.scope];
      const currentCount = scopeMap.get(event.tag) || 0;

      // Add, use, and remove affect counts
      // CFC: When implemented, only count if 5+ unique users
      switch (event.action) {
        case "add":
        case "use":
          scopeMap.set(event.tag, currentCount + 1);
          break;
        case "remove":
          // Don't go below 0
          scopeMap.set(event.tag, Math.max(0, currentCount - 1));
          break;
      }
    }

    // Convert to CommunityTagSuggestion arrays, sorted by count (preferential attachment)
    const result: Record<string, CommunityTagSuggestion[]> = {};
    for (const [scope, tagCounts] of Object.entries(byScope)) {
      result[scope] = Array.from(tagCounts.entries())
        .filter(([_, count]) => count > 0)
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count); // Most used first
    }

    return result;
  });

  // Compute stats for display
  const totalEvents = computed(() => ((events || []) as TagEvent[]).length);
  const uniqueScopes = computed(() => {
    const scopes = new Set<string>();
    for (const event of (events || []) as TagEvent[]) {
      if (event?.scope) scopes.add(event.scope);
    }
    return scopes.size;
  });

  // Recent events for display (last 20)
  const recentEvents = computed(() => {
    const eventList = (events || []) as TagEvent[];
    return eventList.slice(-20).reverse();
  });

  // Top tags across all scopes
  const topTags = computed(() => {
    const suggs = suggestions as Record<string, CommunityTagSuggestion[]>;
    const allTags: Map<string, number> = new Map();

    for (const scopeSuggestions of Object.values(suggs)) {
      for (const { tag, count } of scopeSuggestions) {
        allTags.set(tag, (allTags.get(tag) || 0) + count);
      }
    }

    return Array.from(allTags.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tag, count]) => ({ tag, count }));
  });

  return {
    [NAME]: computed(() => `🏷️ Folksonomy Aggregator (${totalEvents} events)`),
    [UI]: (
      <cf-vstack gap="4" style={{ padding: "16px" }}>
        <cf-vstack gap="2">
          <h2 style={{ margin: 0 }}>🏷️ Folksonomy Aggregator</h2>
          <p style={{ color: "#666", margin: 0, fontSize: "14px" }}>
            Community tag telemetry collector. Favorite this piece with tag
            "folksonomyAggregator" for discovery.
          </p>
        </cf-vstack>

        {/* Stats */}
        <cf-hstack gap="4" style={{ marginTop: "8px" }}>
          <cf-vstack
            style={{
              padding: "12px",
              background: "#f0f9ff",
              borderRadius: "8px",
              flex: 1,
            }}
          >
            <span style={{ fontSize: "24px", fontWeight: "bold" }}>
              {totalEvents}
            </span>
            <span style={{ fontSize: "12px", color: "#666" }}>
              Total Events
            </span>
          </cf-vstack>
          <cf-vstack
            style={{
              padding: "12px",
              background: "#f0fdf4",
              borderRadius: "8px",
              flex: 1,
            }}
          >
            <span style={{ fontSize: "24px", fontWeight: "bold" }}>
              {uniqueScopes}
            </span>
            <span style={{ fontSize: "12px", color: "#666" }}>
              Unique Scopes
            </span>
          </cf-vstack>
        </cf-hstack>

        {/* Top Tags */}
        <cf-vstack gap="2" style={{ marginTop: "12px" }}>
          <span
            style={{
              fontWeight: "600",
              fontSize: "14px",
              textTransform: "uppercase",
              color: "#6b7280",
            }}
          >
            Top Tags (All Scopes)
          </span>
          <cf-hstack gap="2" wrap>
            {topTags.map(
              (item: { tag: string; count: number }, idx: number) => (
                <span
                  key={idx}
                  style={{
                    padding: "4px 8px",
                    background: "#e5e7eb",
                    borderRadius: "12px",
                    fontSize: "13px",
                  }}
                >
                  {item.tag} ({item.count})
                </span>
              ),
            )}
          </cf-hstack>
        </cf-vstack>

        {/* Recent Events */}
        <cf-vstack gap="2" style={{ marginTop: "12px" }}>
          <span
            style={{
              fontWeight: "600",
              fontSize: "14px",
              textTransform: "uppercase",
              color: "#6b7280",
            }}
          >
            Recent Events
          </span>
          <cf-vstack
            gap="1"
            style={{
              maxHeight: "200px",
              overflowY: "auto",
              background: "#f9fafb",
              borderRadius: "8px",
              padding: "8px",
            }}
          >
            {recentEvents.length === 0
              ? (
                <span style={{ color: "#9ca3af", fontSize: "13px" }}>
                  No events yet
                </span>
              )
              : (
                recentEvents.map((event: TagEvent, idx: number) => (
                  <cf-hstack
                    key={idx}
                    gap="2"
                    style={{ fontSize: "12px", padding: "4px 0" }}
                  >
                    <span
                      style={{
                        padding: "2px 6px",
                        borderRadius: "4px",
                        background: event.action === "add"
                          ? "#dcfce7"
                          : event.action === "remove"
                          ? "#fee2e2"
                          : "#fef3c7",
                        color: event.action === "add"
                          ? "#166534"
                          : event.action === "remove"
                          ? "#991b1b"
                          : "#92400e",
                        fontFamily: "monospace",
                        fontSize: "10px",
                      }}
                    >
                      {event.action}
                    </span>
                    <span style={{ fontWeight: "500" }}>{event.tag}</span>
                    <span style={{ color: "#9ca3af" }}>in</span>
                    <span
                      style={{
                        color: "#6b7280",
                        maxWidth: "200px",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {event.scope}
                    </span>
                  </cf-hstack>
                ))
              )}
          </cf-vstack>
        </cf-vstack>

        {/* CFC Notice */}
        <div
          style={{
            marginTop: "16px",
            padding: "12px",
            background: "#fefce8",
            border: "1px solid #fef08a",
            borderRadius: "8px",
            fontSize: "12px",
          }}
        >
          <strong>Privacy Note (CFC Planned):</strong>{" "}
          When Contextual Flow Control is implemented, tags will only appear in
          community suggestions if 5+ independent users have added them,
          protecting individual choices while enabling collective wisdom.
        </div>
      </cf-vstack>
    ),
    events,
    suggestions,
    postEvent: handlePostEvent({ events }),
  };
});
