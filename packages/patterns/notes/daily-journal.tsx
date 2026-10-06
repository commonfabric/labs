import {
  action,
  type BuiltInLLMMessage,
  computed,
  type Default,
  handler,
  hasError,
  ifElse,
  isPending,
  llmDialog,
  NAME,
  navigateTo,
  pattern,
  resultOf,
  Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";
import Note from "./note.tsx";
import Suggestion from "../system/suggestion.tsx";
import { type MentionablePiece, type NotePiece } from "./schemas.tsx";

// ===== Pure utility functions =====

const toLocalISODate = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

// `nowMs` is the current time in epoch ms (handler callers pass Date.now();
// lift/body callers pass the reactive #now value).
const getTodayDate = (nowMs: number): string => toLocalISODate(new Date(nowMs));

const journalTitle = (dateStr: string): string => {
  const d = new Date(dateStr + "T00:00:00");
  const dayOfWeek = d.toLocaleDateString("en-US", { weekday: "long" });
  return `${dateStr} - ${dayOfWeek}`;
};

const DEFAULT_TEMPLATE = `# {{date}} - {{dayOfWeek}}

## Tasks
- [ ]

## Notes

## Reflection
`;

function applyTemplate(templateStr: string, dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const dayOfWeek = d.toLocaleDateString("en-US", { weekday: "long" });
  const monthName = d.toLocaleDateString("en-US", { month: "long" });
  const year = d.getFullYear().toString();
  return templateStr
    .replace(/\{\{date\}\}/g, dateStr)
    .replace(/\{\{dayOfWeek\}\}/g, dayOfWeek)
    .replace(/\{\{month\}\}/g, monthName)
    .replace(/\{\{year\}\}/g, year);
}

// ===== Module-scope handlers =====

/**
 * Handle calendar day selection: navigate to existing note or create a new one.
 */
const handleCalendarChange = handler<
  { detail: { value: string; oldValue: string } },
  {
    entries: Writable<NotePiece[]>;
    template: Writable<string>;
    selectedDate: Writable<string>;
    addPiece: Stream<{ piece: MentionablePiece }>;
  }
>(({ detail }, { entries, template, selectedDate, addPiece }) => {
  const dateStr = detail.value;
  selectedDate.set(dateStr);

  // Check if a note already exists for this date
  const all = entries.get();
  for (const entry of all) {
    if (entry?.title === journalTitle(dateStr)) {
      return navigateTo(entry as any);
    }
  }

  // Create a new daily note
  const noteTitle = journalTitle(dateStr);
  const t = template.get();
  const content = applyTemplate(t || DEFAULT_TEMPLATE, dateStr);
  const note = Note({
    title: noteTitle,
    content,
  });
  entries.push(note as any);
  addPiece.send({ piece: note as any });
  return navigateTo(note as any);
});

/**
 * Handle "Go to Today" — navigate to today's note, creating it if needed.
 */
const handleGoToToday = handler<
  void,
  {
    entries: Writable<NotePiece[]>;
    template: Writable<string>;
    selectedDate: Writable<string>;
    addPiece: Stream<{ piece: MentionablePiece }>;
  }
>((_event, { entries, template, selectedDate, addPiece }) => {
  const dateStr = getTodayDate(Date.now());
  selectedDate.set(dateStr);

  const all = entries.get();
  for (const entry of all) {
    if (entry?.title === journalTitle(dateStr)) {
      return navigateTo(entry as any);
    }
  }

  const d = new Date(dateStr + "T00:00:00");
  const dayOfWeek = d.toLocaleDateString("en-US", { weekday: "long" });
  const noteTitle = `${dateStr} - ${dayOfWeek}`;
  const t = template.get();
  const content = applyTemplate(t || DEFAULT_TEMPLATE, dateStr);
  const note = Note({
    title: noteTitle,
    content,
  });
  entries.push(note as any);
  addPiece.send({ piece: note as any });
  return navigateTo(note as any);
});

// ===== Weekly rollup =====

type WeeklyRollup = {
  headline: string;
  themes: Array<{ name: string; detail: string }>;
  accomplishments: string[];
  openThreads: string[];
  mood: string;
};

const triggerRollup = handler<
  unknown,
  { addMessage: Stream<BuiltInLLMMessage> }
>((_, { addMessage }) => {
  addMessage.send({
    role: "user",
    content: [{
      type: "text" as const,
      text:
        "Analyze my daily notes from this past week and produce a weekly rollup.",
    }],
  });
});

// ===== Input / Output types =====

interface DailyJournalInput {
  title?: Writable<string | Default<"Daily Journal">>;
  entries?: Writable<NotePiece[] | Default<[]>>;
  template?: Writable<string | Default<"">>;
}

export interface DailyJournalOutput {
  [NAME]: string;
  [UI]: VNode;
  title: string;
  entries: NotePiece[];
  template: string;
  isJournal: boolean;
  summary: string;
  mentionable: NotePiece[];
  goToToday: Stream<void>;
  weeklyRollup: WeeklyRollup | undefined;
}

// ===== Pattern =====

export default pattern<DailyJournalInput, DailyJournalOutput>(
  ({ title, entries, template }) => {
    // Access default-app for addPiece (global piece registration)
    const defaultWish = wish<{
      addPiece: Stream<{ piece: MentionablePiece }>;
    }>({ query: "#default" });
    const { addPiece } = resultOf(defaultWish.result);

    // UI state
    const showSettings = new Writable(false);
    // Reactive #now; dependent computations remain unavailable until it
    // resolves because the ambient clock is not readable from the pattern body.
    const nowCell = wish<number>({ query: "#now" });
    const nowCellValue = resultOf(nowCell.result);
    const selectedDate = new Writable("");
    computed(() => {
      const nowMs = nowCellValue;
      if (selectedDate.get() === "") {
        selectedDate.set(getTodayDate(nowMs));
      }
    });

    // Dates that already have a journal entry (for calendar markers)
    const datesWithNotes = computed(() => {
      const dates: string[] = [];
      for (const entry of entries.get()) {
        const t = entry?.title;
        if (t && /^\d{4}-\d{2}-\d{2}/.test(t)) {
          dates.push(t.slice(0, 10));
        }
      }
      return dates;
    });

    // Sorted entries — most recent first
    const sortedEntries = computed(() => {
      const arr: NotePiece[] = [];
      for (const entry of entries.get()) {
        if (entry) arr.push(entry);
      }
      return arr.sort((a, b) => (b.title ?? "").localeCompare(a.title ?? ""));
    });

    // Short summary for search/LLM
    const summary = computed(() => {
      const count = entries.get().length;
      const sorted = sortedEntries;
      const latest = sorted.length > 0
        ? (sorted[0].title ?? "").slice(0, 10) || "none"
        : "none";
      return `Daily Journal — ${count} entries, last: ${latest}`;
    });

    // Settings visibility helpers
    const mainDisplay = computed(() => showSettings.get() ? "none" : "flex");
    const settingsDisplay = computed(() =>
      showSettings.get() ? "flex" : "none"
    );

    const toggleSettings = action(() => {
      showSettings.set(!showSettings.get());
    });

    const goToToday = handleGoToToday({
      entries,
      template,
      selectedDate,
      addPiece,
    });

    // ===== Weekly Rollup (LLM-powered) =====

    // Gather last 7 days of note content for the system prompt
    const recentNotesContext = computed(() => {
      const now = nowCellValue;
      const today = new Date(now);
      const sevenDaysAgo = new Date(now);
      sevenDaysAgo.setDate(today.getDate() - 7);
      const cutoff = toLocalISODate(sevenDaysAgo);

      const recent: string[] = [];
      for (const entry of entries.get()) {
        const t = entry?.title;
        if (!t || !/^\d{4}-\d{2}-\d{2}/.test(t)) continue;
        const dateStr = t.slice(0, 10);
        if (dateStr >= cutoff) {
          const noteTitle = entry.title ?? dateStr;
          const noteContent = entry.content ?? "";
          recent.push(
            `<note date="${dateStr}" title="${noteTitle}">\n${noteContent}\n</note>`,
          );
        }
      }
      recent.sort().reverse();
      return recent;
    });

    const hasRecentNotes = computed(() => recentNotesContext.length > 0);

    const rollupSystemPrompt = computed(() => {
      const notes = recentNotesContext;
      const noteCount = notes.length;
      const notesXml = notes.join("\n\n");
      return `You are a personal journal assistant producing a weekly rollup from daily notes.

<instructions>
You will receive ${noteCount} daily note(s) from the past 7 days. Even if there is only one note, produce a complete rollup based on whatever content is available. Work with what you have — a single day's notes are still worth summarizing.

Produce a structured result with:
- headline: A punchy one-sentence summary of the period
- themes: 2-4 topics or areas of focus you identified (each with name and brief detail). If there's only one note, extract themes from that note.
- accomplishments: Tasks completed, decisions made, or progress noted. Extract from checkbox items, explicit mentions, or implied completions.
- openThreads: Unresolved items, questions, or things to follow up on. Extract from unchecked tasks, open questions, or forward-looking statements.
- mood: A brief read on energy/tone from the writing style and content.

Be concise and specific. Reference actual content from the notes rather than being generic.
</instructions>

<daily-notes count="${noteCount}">
${notesXml}
</daily-notes>`;
    });

    const rollupMessages = new Writable<BuiltInLLMMessage[]>([]);

    const rollupParams = {
      system: rollupSystemPrompt,
      messages: rollupMessages,
      tools: {},
      model: "anthropic:claude-haiku-4-5" as const,
      builtinTools: false,
    };
    const rollupDialog = llmDialog<WeeklyRollup>(rollupParams);
    const {
      addMessage: rollupAddMessage,
      pending: rollupPending,
    } = rollupDialog;

    const weeklyRollup = computed(() =>
      isPending(rollupDialog.result) || hasError(rollupDialog.result)
        ? undefined
        : resultOf(rollupDialog.result)
    );
    const hasRollup = computed(() => !!weeklyRollup);

    // Suggestion context derived from the weekly rollup
    const suggestionSituation = computed(() => {
      const rollup = weeklyRollup;
      if (!rollup) return "Suggest something useful based on my daily journal.";
      const threads: string[] = [];
      if (rollup.openThreads) {
        for (const t of rollup.openThreads) threads.push(t);
      }
      const themeNames: string[] = [];
      if (rollup.themes) {
        for (const t of rollup.themes) themeNames.push(t.name);
      }
      const mood = rollup.mood || "unknown";
      return `Based on my weekly journal rollup, suggest a next step or useful pattern. Active themes: ${
        themeNames.join(", ")
      }. Open threads: ${threads.join(", ")}. Mood: ${mood}.`;
    });

    const suggestionContext = computed(() => {
      const rollup = weeklyRollup;
      if (!rollup) {
        return {
          weeklyHeadline: "",
          themes: [],
          accomplishments: [],
          openThreads: [],
        };
      }
      return {
        weeklyHeadline: rollup.headline || "",
        themes: rollup.themes,
        accomplishments: rollup.accomplishments,
        openThreads: rollup.openThreads,
      };
    });

    return {
      [NAME]: computed(() => `📅 ${title.get()}`),
      [UI]: (
        <cf-screen>
          {/* Main view — two column layout */}
          <div
            style={{
              display: mainDisplay,
              gap: "24px",
              padding: "24px",
              alignItems: "start",
            }}
          >
            {/* Column 1: Calendar + Entries */}
            <div style={{ width: "320px", flexShrink: "0" }}>
              <cf-vstack gap="4">
                {/* Go to Today */}
                <cf-button
                  color="primary"
                  variant="solid"
                  onClick={handleGoToToday({
                    entries,
                    template,
                    selectedDate,
                    addPiece,
                  })}
                  style={{
                    width: "100%",
                    padding: "12px",
                    fontSize: "16px",
                    fontWeight: "bold",
                  }}
                >
                  Go to Today's Note
                </cf-button>

                {/* Mini calendar */}
                <cf-card>
                  <cf-calendar
                    $value={selectedDate}
                    markedDates={datesWithNotes}
                    oncf-change={handleCalendarChange({
                      entries,
                      template,
                      selectedDate,
                      addPiece,
                    })}
                  />
                </cf-card>

                {/* Entries list */}
                <cf-vstack gap="2">
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <h3 style={{ margin: 0, fontSize: "16px" }}>Entries</h3>
                    <cf-button
                      color="neutral"
                      variant="ghost"
                      onClick={toggleSettings}
                    >
                      Settings
                    </cf-button>
                  </div>
                  {sortedEntries.map((entry: any) => (
                    <cf-cell-link $cell={entry} />
                  ))}
                </cf-vstack>
              </cf-vstack>
            </div>

            {/* Column 2: Weekly Rollup */}
            <div style={{ flex: "1", minWidth: "0" }}>
              {ifElse(
                hasRecentNotes,
                <cf-card>
                  <cf-vstack gap="3" padding="4">
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <h3 style={{ margin: 0, fontSize: "14px" }}>
                        Weekly Rollup
                      </h3>
                      <cf-button
                        color="neutral"
                        variant="ghost"
                        size="sm"
                        onClick={triggerRollup({
                          addMessage: rollupAddMessage,
                        })}
                      >
                        Refresh
                      </cf-button>
                    </div>

                    <cf-autostart
                      onstart={triggerRollup({
                        addMessage: rollupAddMessage,
                      })}
                    />

                    {ifElse(
                      hasRollup,
                      <cf-vstack gap="3">
                        <p
                          style={{
                            fontSize: "15px",
                            fontWeight: "600",
                            margin: 0,
                            lineHeight: "1.3",
                          }}
                        >
                          {weeklyRollup?.headline}
                        </p>

                        <cf-vstack gap="1">
                          <span
                            style={{
                              fontSize: "11px",
                              fontWeight: "500",
                              color: "var(--cf-colors-gray-500)",
                              textTransform: "uppercase",
                              letterSpacing: "0.05em",
                            }}
                          >
                            Themes
                          </span>
                          {weeklyRollup?.themes.map(
                            (theme: { name: string; detail: string }) => (
                              <div
                                style={{
                                  padding: "6px 8px",
                                  borderRadius: "6px",
                                  background: "var(--cf-colors-gray-50)",
                                  fontSize: "13px",
                                }}
                              >
                                <strong>{theme.name}</strong>
                                {" — "}
                                <span
                                  style={{
                                    color: "var(--cf-colors-gray-600)",
                                  }}
                                >
                                  {theme.detail}
                                </span>
                              </div>
                            ),
                          )}
                        </cf-vstack>

                        {ifElse(
                          computed(
                            () =>
                              (weeklyRollup?.accomplishments?.length ?? 0) >
                                0,
                          ),
                          <cf-vstack gap="1">
                            <span
                              style={{
                                fontSize: "11px",
                                fontWeight: "500",
                                color: "var(--cf-colors-gray-500)",
                                textTransform: "uppercase",
                                letterSpacing: "0.05em",
                              }}
                            >
                              Done
                            </span>
                            <ul
                              style={{
                                margin: 0,
                                paddingLeft: "1.2rem",
                                fontSize: "13px",
                                lineHeight: "1.5",
                              }}
                            >
                              {weeklyRollup?.accomplishments.map(
                                (item: string) => <li>{item}</li>,
                              )}
                            </ul>
                          </cf-vstack>,
                          <span />,
                        )}

                        {ifElse(
                          computed(
                            () => (weeklyRollup?.openThreads?.length ?? 0) > 0,
                          ),
                          <cf-vstack gap="1">
                            <span
                              style={{
                                fontSize: "11px",
                                fontWeight: "500",
                                color: "var(--cf-colors-gray-500)",
                                textTransform: "uppercase",
                                letterSpacing: "0.05em",
                              }}
                            >
                              Open Threads
                            </span>
                            <ul
                              style={{
                                margin: 0,
                                paddingLeft: "1.2rem",
                                fontSize: "13px",
                                lineHeight: "1.5",
                              }}
                            >
                              {weeklyRollup?.openThreads.map(
                                (item: string) => <li>{item}</li>,
                              )}
                            </ul>
                          </cf-vstack>,
                          <span />,
                        )}

                        <p
                          style={{
                            margin: 0,
                            fontSize: "13px",
                            fontStyle: "italic",
                            color: "var(--cf-colors-gray-600)",
                          }}
                        >
                          {weeklyRollup?.mood}
                        </p>
                      </cf-vstack>,
                      <div
                        style={{
                          textAlign: "center",
                          color: "var(--cf-colors-gray-500)",
                          padding: "0.5rem",
                          fontSize: "13px",
                        }}
                      >
                        {ifElse(
                          rollupPending,
                          <span>Summarizing your week...</span>,
                          <span />,
                        )}
                      </div>,
                    )}
                  </cf-vstack>
                </cf-card>,
                <span />,
              )}

              {/* Suggestion based on weekly context */}
              {ifElse(
                hasRollup,
                <cf-card style={{ marginTop: "16px" }}>
                  <cf-vstack gap="2" padding="4">
                    <span
                      style={{
                        fontSize: "11px",
                        fontWeight: "500",
                        color: "var(--cf-colors-gray-500)",
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                      }}
                    >
                      Suggested
                    </span>
                    <Suggestion
                      situation={suggestionSituation}
                      context={suggestionContext}
                      initialResults={[]}
                    />
                  </cf-vstack>
                </cf-card>,
                <span />,
              )}
            </div>
          </div>

          {/* Settings view */}
          <cf-vstack
            gap="4"
            padding="6"
            style={{
              display: settingsDisplay,
            }}
          >
            <h3 style={{ margin: 0 }}>Daily Note Template</h3>
            <p
              style={{
                margin: 0,
                fontSize: "13px",
                color: "var(--cf-theme-color-text-secondary)",
              }}
            >
              Available variables: {"{{date}}"}, {"{{dayOfWeek}}"},
              {"{{month}}"}, {"{{year}}"}
            </p>
            <cf-code-editor
              $value={template}
              language="text/markdown"
              wordWrap
              style={{ minHeight: "300px" }}
            />
            <cf-button color="primary" variant="solid" onClick={toggleSettings}>
              Done
            </cf-button>
          </cf-vstack>
        </cf-screen>
      ),
      title,
      entries,
      template,
      isJournal: true,
      summary,
      mentionable: entries,
      goToToday,
      weeklyRollup,
    };
  },
);
