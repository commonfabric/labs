/// <cts-enable />
import {
  action,
  computed,
  type Default,
  handler,
  hasError,
  hasSchemaMismatch,
  isPending,
  isSyncing,
  NAME,
  pattern,
  resultOf,
  type Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";
import type { AgentPiece, AgentStatus } from "./schemas.tsx";

export type { AgentPiece };

// ===== Types =====

interface AgentInput {
  agentName?: Writable<string | Default<"Unnamed Agent">>;
  directive?: Writable<string | Default<"">>;
  enabled?: Writable<boolean | Default<true>>;
  learned?: Writable<string | Default<"">>;
  status?: Writable<AgentStatus | Default<"idle">>;
  lastRun?: Writable<string | Default<"">>;
  lastRunSummary?: Writable<string | Default<"">>;
  isAgent?: boolean | Default<true>;
}

/** An #agent piece — autonomous worker with directive, learned state, and status. */
export interface AgentOutput extends AgentPiece {
  [NAME]: string;
  [UI]: VNode;
  agentName: string;
  directive: string;
  enabled: boolean;
  learned: string;
  status: AgentStatus;
  lastRun: string;
  lastRunSummary: string;
  isAgent: boolean;
  summary: string;
  // Handlers
  setDirective: Stream<{ value: string }>;
  setLearned: Stream<{ value: string }>;
  appendLearned: Stream<{ entry: string }>;
  toggleEnabled: Stream<void>;
  markRunning: Stream<void>;
  markIdle: Stream<{ summary: string; learned?: string }>;
  markError: Stream<{ summary: string }>;
}

// ===== Activity Log Discovery Type =====

interface ActivityLogPiece {
  logEvent: Stream<{ agent: string; action: string; note?: string }>;
}

// ===== Module-scope Handlers =====

const setDirectiveHandler = handler<
  { value: string },
  { directive: Writable<string> }
>((args, { directive }) => {
  directive.set(args.value);
});

const setLearnedHandler = handler<
  { value: string },
  { learned: Writable<string> }
>((args, { learned }) => {
  learned.set(args.value);
});

const appendLearnedHandler = handler<
  { entry: string },
  { learned: Writable<string> }
>((args, { learned }) => {
  const current = learned.get() || "";
  const separator = current && !current.endsWith("\n") ? "\n" : "";
  learned.set(`${current}${separator}${args.entry}`);
});

// ===== The Pattern =====

export default pattern<AgentInput, AgentOutput>(
  ({
    agentName,
    directive,
    enabled,
    learned,
    status,
    lastRun,
    lastRunSummary,
    isAgent,
  }) => {
    // Discover activity-log (optional — null-checked before use)
    const activityLogWish = wish<ActivityLogPiece>({
      query: "#activityLog",
      headless: true,
    });
    const activityLog = hasError(activityLogWish.result) ||
        isPending(activityLogWish.result) ||
        isSyncing(activityLogWish.result) ||
        hasSchemaMismatch(activityLogWish.result)
      ? undefined
      : resultOf(activityLogWish.result);

    // Bind module-scope handlers
    const setDirective = setDirectiveHandler({ directive });
    const setLearned = setLearnedHandler({ learned });
    const appendLearned = appendLearnedHandler({ learned });

    // Pattern-body actions
    const toggleEnabled = action(() => {
      enabled.set(!enabled.get());
    });

    const markRunning = action(() => {
      status.set("running");
      if (activityLog) {
        activityLog.logEvent.send({
          agent: agentName.get(),
          action: "started",
        });
      }
    });

    const markIdle = action(
      ({ summary, learned: learnedEntry }: {
        summary: string;
        learned?: string;
      }) => {
        const nowIso = new Date().toISOString();
        status.set("idle");
        lastRun.set(nowIso);
        lastRunSummary.set(summary);
        if (learnedEntry) {
          const current = learned.get() || "";
          const separator = current && !current.endsWith("\n") ? "\n" : "";
          learned.set(`${current}${separator}${learnedEntry}`);
        }
        if (activityLog) {
          activityLog.logEvent.send({
            agent: agentName.get(),
            action: "completed",
            note: summary,
          });
        }
      },
    );

    const markError = action(({ summary }: { summary: string }) => {
      const nowIso = new Date().toISOString();
      status.set("error");
      lastRun.set(nowIso);
      lastRunSummary.set(`ERROR: ${summary}`);
      if (activityLog) {
        activityLog.logEvent.send({
          agent: agentName.get(),
          action: "errored",
          note: summary,
        });
      }
    });

    // UI state
    const isEditingName = new Writable(false);
    const startEditingName = action(() => isEditingName.set(true));
    const stopEditingName = action(() => isEditingName.set(false));
    const handleNameKeydown = action((event: { key?: string }) => {
      if (event?.key === "Enter") isEditingName.set(false);
    });

    const learnedExpanded = new Writable(false);
    const toggleLearned = action(() =>
      learnedExpanded.set(!learnedExpanded.get())
    );

    // Derived values
    const displayName = computed(() => `🤖 ${agentName.get()}`);

    const statusColor = computed(() => {
      const s = status.get();
      if (s === "running") return "var(--cf-colors-blue-500, #3b82f6)";
      if (s === "error") return "var(--cf-colors-red-500, #ef4444)";
      return "var(--cf-colors-gray-400, #9ca3af)";
    });

    const summaryText = computed(() => {
      const s = status.get();
      const name = agentName.get();
      const last = lastRunSummary.get();
      if (s === "running") return `${name} is running`;
      if (last) return `${name}: ${last}`;
      return `${name} (no runs yet)`;
    });

    const lastRunSectionDisplay = computed(() =>
      lastRun.get() ? "block" : "none"
    );

    const lastRunTimestamp = computed(() => {
      const ts = lastRun.get();
      if (!ts) return "";
      try {
        return new Date(ts).toLocaleString();
      } catch {
        return ts;
      }
    });

    const nameDisplayStyle = computed(() =>
      isEditingName.get() ? "none" : "flex"
    );
    const nameInputDisplayStyle = computed(() =>
      isEditingName.get() ? "flex" : "none"
    );

    const learnedDisplay = computed(() =>
      learnedExpanded.get() ? "block" : "none"
    );
    const learnedToggleLabel = computed(() =>
      learnedExpanded.get() ? "▼ Learned" : "▶ Learned"
    );
    const learnedSectionDisplay = computed(() =>
      learned.get() ? "flex" : "none"
    );

    return {
      [NAME]: displayName,
      [UI]: (
        <cf-screen>
          {/* Header: name, status badge, enabled toggle */}
          <cf-hstack
            slot="header"
            gap="3"
            style={{
              padding: "0.75rem 1rem",
              alignItems: "center",
              borderBottom: "1px solid var(--cf-theme-color-border, #e5e5e7)",
            }}
          >
            {/* Click-to-edit name */}
            <div
              style={{
                display: nameDisplayStyle,
                alignItems: "center",
                cursor: "pointer",
                flex: 1,
              }}
              onClick={startEditingName}
            >
              <span style={{ fontSize: "15px", fontWeight: "600" }}>
                {displayName}
              </span>
            </div>
            <div
              style={{
                display: nameInputDisplayStyle,
                flex: 1,
              }}
            >
              <cf-input
                $value={agentName}
                placeholder="Agent name..."
                style={{ flex: 1 }}
                oncf-blur={stopEditingName}
                oncf-keydown={handleNameKeydown}
              />
            </div>

            {/* Status badge */}
            <span
              style={{
                fontSize: "12px",
                fontWeight: "500",
                padding: "2px 8px",
                borderRadius: "9999px",
                backgroundColor: statusColor,
                color: "white",
                textTransform: "uppercase",
              }}
            >
              {status}
            </span>

            {/* Enabled toggle */}
            <cf-checkbox
              $checked={enabled}
              title="Enable/disable agent"
            />
          </cf-hstack>

          <cf-vscroll flex showScrollbar fadeEdges>
            <cf-vstack gap="4" style={{ padding: "1rem" }}>
              {/* Directive section */}
              <cf-vstack gap="1">
                <cf-label style={{ fontWeight: "600", fontSize: "13px" }}>
                  Directive
                </cf-label>
                <cf-code-editor
                  $value={directive}
                  language="text/markdown"
                  mode="prose"
                  wordWrap
                  placeholder="Describe this agent's role and instructions..."
                  style={{ minHeight: "120px" }}
                />
              </cf-vstack>

              {/* Learned section (collapsible) */}
              <cf-vstack
                gap="1"
                style={{
                  display: learnedSectionDisplay,
                }}
              >
                <div
                  onClick={toggleLearned}
                  style={{
                    cursor: "pointer",
                    fontWeight: "600",
                    fontSize: "13px",
                    userSelect: "none",
                  }}
                >
                  {learnedToggleLabel}
                </div>
                <div style={{ display: learnedDisplay }}>
                  <cf-code-editor
                    $value={learned}
                    language="text/markdown"
                    mode="prose"
                    wordWrap
                    placeholder="No observations yet."
                    style={{ minHeight: "80px" }}
                  />
                </div>
              </cf-vstack>

              {/* Last run section */}
              <cf-vstack
                gap="1"
                style={{
                  display: lastRunSectionDisplay,
                }}
              >
                <cf-label style={{ fontWeight: "600", fontSize: "13px" }}>
                  Last Run
                </cf-label>
                <cf-hstack
                  gap="2"
                  style={{
                    fontSize: "13px",
                    color: "var(--cf-theme-color-text-secondary, #6b7280)",
                    alignItems: "center",
                  }}
                >
                  <span>{lastRunTimestamp}</span>
                  <span>—</span>
                  <span>{lastRunSummary}</span>
                </cf-hstack>
              </cf-vstack>
            </cf-vstack>
          </cf-vscroll>
        </cf-screen>
      ),
      agentName,
      directive,
      enabled,
      learned,
      status,
      lastRun,
      lastRunSummary,
      isAgent,
      summary: summaryText,
      setDirective,
      setLearned,
      appendLearned,
      toggleEnabled,
      markRunning,
      markIdle,
      markError,
    };
  },
);
