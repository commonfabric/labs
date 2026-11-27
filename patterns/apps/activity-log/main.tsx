import {
  action,
  computed,
  type Default,
  handler,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

// ===== Types =====

/**
 * A piece that can be mentioned via wiki-links.
 * Mirrors the shape used in notes/schemas.tsx.
 */
interface MentionablePiece {
  [NAME]?: string;
  isHidden?: boolean;
  mentioned: MentionablePiece[];
  backlinks: MentionablePiece[];
}

export interface ActivityEvent {
  id: string;
  timestamp: string; // ISO 8601
  agent: string;
  action: string; // short verb phrase e.g. "deployed", "populated"
  pieceName?: string;
  pieceRef?: MentionablePiece;
  note?: string;
}

interface ActivityLogInput {
  events?: Writable<ActivityEvent[] | Default<[]>>;
  mentioned?: Writable<MentionablePiece[] | Default<[]>>;
}

/** An #activityLog for recording structured agent events. */
export interface ActivityLogOutput {
  [NAME]: string;
  [UI]: VNode;
  logEvent: unknown;
  clearLog: unknown;
  summary: string;
}

// ===== Module-scope Handlers =====

const logEventHandler = handler<
  Omit<ActivityEvent, "id" | "timestamp">,
  { events: Writable<ActivityEvent[]>; mentioned: Writable<MentionablePiece[]> }
>((args, { events, mentioned }) => {
  const now = Date.now();
  events.push({
    id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 11)}`,
    timestamp: new Date(now).toISOString(),
    ...args,
  });
  if (args.pieceRef) mentioned.push(args.pieceRef);
});

const clearLogHandler = handler<
  unknown,
  { events: Writable<ActivityEvent[]> }
>((_, { events }) => events.set([]));

// ===== Pattern =====

export default pattern<ActivityLogInput, ActivityLogOutput>(
  ({ events, mentioned }) => {
    // Bind handlers
    const logEvent = logEventHandler({ events, mentioned });
    const clearLog = clearLogHandler({ events });

    // Filter state — local, use action not handler
    const filterAgent = new Writable<string | null>(null);
    const setFilter = action(({ agent }: { agent: string | null }) =>
      filterAgent.set(agent)
    );

    // Derived values
    const agents = computed(() => [
      ...new Set(
        events.get().filter(Boolean).map((e: ActivityEvent) => e.agent),
      ),
    ]);
    const filtered = computed(() => {
      const all = events.get().filter(Boolean) as ActivityEvent[];
      return filterAgent.get()
        ? all.filter((e) => e.agent === filterAgent.get())
        : all;
    });

    const summary = computed(() => {
      const all = events.get().filter(Boolean) as ActivityEvent[];
      if (!all.length) return "No activity logged.";
      return all
        .slice(-20)
        .map((e: ActivityEvent) => {
          const ts = new Date(e.timestamp).toLocaleString();
          const parts = [`[${ts}]`, `${e.agent}:`, e.action];
          if (e.pieceName) parts.push(e.pieceName);
          if (e.note) parts.push(`— ${e.note}`);
          return parts.join(" ");
        })
        .join("\n");
    });

    return {
      [NAME]: computed(() => `Activity Log (${events.get().length})`),
      [UI]: (
        <cf-screen>
          <cf-hstack
            slot="header"
            gap="2"
            style="padding: 0.75rem 1rem; align-items: center;"
          >
            <cf-label style="font-weight: 600; flex: 1;">Activity Log</cf-label>
            <cf-button
              color="neutral"
              variant="ghost"
              size="sm"
              onClick={clearLog}
            >
              Clear
            </cf-button>
          </cf-hstack>

          <cf-vscroll flex showScrollbar fadeEdges>
            <cf-vstack gap="3" style="padding: 0.75rem 1rem;">
              {/* Agent filter chips */}
              <cf-hstack gap="1" style="flex-wrap: wrap;">
                <cf-button
                  color={filterAgent.get() === null ? "primary" : "neutral"}
                  variant={filterAgent.get() === null ? "solid" : "ghost"}
                  size="sm"
                  onClick={() => setFilter.send({ agent: null })}
                >
                  All
                </cf-button>
                {agents.map((agent: string) => (
                  <cf-button
                    color={filterAgent.get() === agent ? "primary" : "neutral"}
                    variant={filterAgent.get() === agent ? "solid" : "ghost"}
                    size="sm"
                    onClick={() => setFilter.send({ agent })}
                  >
                    {agent}
                  </cf-button>
                ))}
              </cf-hstack>

              {/* Event list */}
              {filtered.map((event: ActivityEvent) => (
                <cf-hstack
                  gap="2"
                  style="align-items: flex-start; border-bottom: 1px solid var(--cf-colors-gray-100); padding-bottom: 0.5rem;"
                >
                  <cf-vstack gap="0" style="flex: 1; min-width: 0;">
                    <cf-hstack
                      gap="2"
                      style="align-items: center; flex-wrap: wrap;"
                    >
                      <cf-badge>{event.agent}</cf-badge>
                      <cf-label style="font-weight: 500;">
                        {event.action}
                      </cf-label>
                      {event.pieceName
                        ? (
                          <cf-label style="color: var(--cf-colors-gray-500);">
                            {event.pieceName}
                          </cf-label>
                        )
                        : null}
                      {event.pieceRef
                        ? <cf-render variant="chip" $cell={event.pieceRef} />
                        : null}
                    </cf-hstack>
                    {event.note
                      ? (
                        <cf-label style="color: var(--cf-colors-gray-600); font-size: 0.875em;">
                          {event.note}
                        </cf-label>
                      )
                      : null}
                  </cf-vstack>
                  <cf-label style="color: var(--cf-colors-gray-400); font-size: 0.75em; white-space: nowrap; flex-shrink: 0;">
                    {new Date(event.timestamp).toLocaleTimeString()}
                  </cf-label>
                </cf-hstack>
              ))}

              {computed(() =>
                filtered.length === 0
                  ? (
                    <cf-label style="color: var(--cf-colors-gray-400); text-align: center; padding: 2rem 0;">
                      No events yet
                    </cf-label>
                  )
                  : null
              )}
            </cf-vstack>
          </cf-vscroll>
        </cf-screen>
      ),
      logEvent,
      clearLog,
      summary,
    };
  },
);
