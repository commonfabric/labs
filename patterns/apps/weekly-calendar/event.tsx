/**
 * Event Pattern
 *
 * An atomic pattern representing a single calendar event.
 * Can be created, edited, and managed by calendar patterns (like weekly-calendar-turtles).
 * Similar to how note.tsx is managed by notebook.tsx.
 */
import {
  computed,
  type Default,
  handler,
  NAME,
  navigateTo,
  pattern,
  Stream,
  UI,
  Writable,
} from "commonfabric";

// Simple random ID generator
const generateId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;

// Available colors for events
const COLORS: string[] = [
  "#fef08a", // yellow
  "#bbf7d0", // green
  "#bfdbfe", // blue
  "#fbcfe8", // pink
  "#fed7aa", // orange
  "#ddd6fe", // purple
];

// Type for backlinks (inline to work around CLI path resolution bug)
type MentionablePiece = {
  [NAME]?: string;
  isHidden?: boolean;
  mentioned: MentionablePiece[];
  backlinks: MentionablePiece[];
};

interface Input {
  title?: Writable<string | Default<"Untitled Event">>;
  date?: Writable<string | Default<"">>; // YYYY-MM-DD
  startTime?: Writable<string | Default<"09:00">>; // HH:MM
  endTime?: Writable<string | Default<"10:00">>; // HH:MM
  color?: Writable<string | Default<"#fef08a">>;
  notes?: Writable<string | Default<"">>;
  isHidden?: boolean | Default<false>;
  eventId?: string | Default<"">;
}

/** Represents a calendar event with a date, time, and notes. */
export interface Output {
  title: string;
  date: string;
  startTime: string;
  endTime: string;
  color: string;
  notes: string;
  summary: string;
  isHidden: boolean;
  eventId: string;
  backlinks: MentionablePiece[];
  // LLM-callable streams
  setTitle: Stream<{ newTitle: string }>;
  setDate: Stream<{ newDate: string }>;
  setTime: Stream<{ newStartTime: string; newEndTime: string }>;
  setColor: Stream<{ newColor: string }>;
  setNotes: Stream<{ newNotes: string }>;
}

// ============ STYLES ============

const STYLES = {
  label: {
    fontSize: "0.75rem",
    fontWeight: "500",
    display: "block",
    marginBottom: "4px",
  },
  colorSwatch: {
    width: "24px",
    height: "24px",
    borderRadius: "4px",
    cursor: "pointer",
  },
} as const;

// ============ TIME HELPERS ============

const timeToMinutes = (time: string): number => {
  if (!time) return 0;
  const [h, m] = time.split(":").map(Number);
  return h * 60 + (m || 0);
};

const formatDuration = (start: string, end: string): string => {
  const startMin = timeToMinutes(start);
  const endMin = timeToMinutes(end);
  const durationMin = Math.max(0, endMin - startMin);
  const hours = Math.floor(durationMin / 60);
  const mins = durationMin % 60;
  if (hours === 0) return `${mins}m`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
};

const formatTime12h = (time: string): string => {
  if (!time) return "";
  const [h, m] = time.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const hour = h % 12 || 12;
  return `${hour}:${m.toString().padStart(2, "0")} ${period}`;
};

const formatDateDisplay = (date: string): string => {
  if (!date) return "";
  const d = new Date(date + "T12:00:00");
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
};

// ============ HANDLERS ============

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

// Handler for clicking on a backlink
const handleBacklinkClick = handler<
  void,
  { piece: Writable<MentionablePiece> }
>((_, { piece }) => navigateTo(piece));

// Auto-update end time when start time changes
const onStartTimeChange = handler<
  { detail: { value: string } },
  { startTime: Writable<string>; endTime: Writable<string> }
>((e, { startTime, endTime }) => {
  const newStart = e?.detail?.value;
  if (newStart) {
    // Keep same duration or default to 1 hour
    const oldStart = startTime.get() || "09:00";
    const oldEnd = endTime.get() || "10:00";
    const duration = timeToMinutes(oldEnd) - timeToMinutes(oldStart);
    const newEndMin = timeToMinutes(newStart) + Math.max(60, duration);
    const h = Math.min(23, Math.floor(newEndMin / 60));
    const m = newEndMin % 60;
    endTime.set(
      `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`,
    );
  }
});

// LLM-callable handlers
const handleSetTitle = handler<
  { newTitle: string },
  { title: Writable<string> }
>(({ newTitle }, { title }) => {
  title.set(newTitle);
  return newTitle;
});

const handleSetDate = handler<
  { newDate: string },
  { date: Writable<string> }
>(({ newDate }, { date }) => {
  date.set(newDate);
  return newDate;
});

const handleSetTime = handler<
  { newStartTime: string; newEndTime: string },
  { startTime: Writable<string>; endTime: Writable<string> }
>(({ newStartTime, newEndTime }, { startTime, endTime }) => {
  startTime.set(newStartTime);
  endTime.set(newEndTime);
});

const handleSetColor = handler<
  { newColor: string },
  { color: Writable<string> }
>(({ newColor }, { color }) => {
  color.set(newColor);
  return newColor;
});

const handleSetNotes = handler<
  { newNotes: string },
  { notes: Writable<string> }
>(({ newNotes }, { notes }) => {
  notes.set(newNotes);
  return newNotes;
});

const selectColor = handler<
  void,
  { color: Writable<string>; selectedColor: string }
>((_, { color, selectedColor }) => color.set(selectedColor));

// ============ PATTERN ============

const Event = pattern<Input, Output>(
  ({ title, date, startTime, endTime, color, notes, isHidden, eventId }) => {
    // State for inline title editing
    const isEditingTitle = new Writable<boolean>(false);

    // Backlinks - populated by backlinks-index.tsx
    const backlinks = new Writable<MentionablePiece[]>([]);

    // Computed display values
    const dateDisplay = computed(() => formatDateDisplay(date.get()));
    const timeDisplay = computed(() =>
      `${formatTime12h(startTime.get())} - ${formatTime12h(endTime.get())}`
    );
    const durationDisplay = computed(() =>
      formatDuration(startTime.get(), endTime.get())
    );

    return {
      [NAME]: computed(() => `${title.get()}`),
      [UI]: (
        <cf-screen>
          {/* Header */}
          <cf-vstack
            slot="header"
            gap="2"
            padding="4"
            style={{
              borderBottom: "1px solid var(--cf-theme-color-border, #e5e5e7)",
            }}
          >
            <cf-hstack gap="3" style={{ alignItems: "center" }}>
              {/* Editable Title - click to edit */}
              <div
                style={{
                  display: computed(() =>
                    isEditingTitle.get() ? "none" : "flex"
                  ),
                  alignItems: "center",
                  gap: "8px",
                  cursor: "pointer",
                  flex: 1,
                }}
                onClick={startEditingTitle({ isEditingTitle })}
              >
                <div
                  style={{
                    width: "16px",
                    height: "16px",
                    borderRadius: "4px",
                    backgroundColor: computed(() => color.get()),
                    flexShrink: 0,
                  }}
                />
                <span
                  style={{ margin: 0, fontSize: "15px", fontWeight: "600" }}
                >
                  {title}
                </span>
              </div>
              <div
                style={{
                  display: computed(() =>
                    isEditingTitle.get() ? "flex" : "none"
                  ),
                  flex: 1,
                  marginRight: "12px",
                }}
              >
                <cf-input
                  $value={title}
                  placeholder="Event title..."
                  style={{ flex: 1 }}
                  oncf-blur={stopEditingTitle({ isEditingTitle })}
                  oncf-keydown={handleTitleKeydown({ isEditingTitle })}
                />
              </div>
            </cf-hstack>

            {/* Date/Time summary */}
            <cf-hstack gap="2" style={{ alignItems: "center" }}>
              <span
                style={{
                  fontSize: "0.875rem",
                  color: "var(--cf-theme-color-text-secondary, #6e6e73)",
                }}
              >
                {dateDisplay} | {timeDisplay} ({durationDisplay})
              </span>
            </cf-hstack>
          </cf-vstack>

          {/* Main Content */}
          <cf-vstack padding="4" gap="4" style={{ flex: 1, overflow: "auto" }}>
            {/* Date Input */}
            <div>
              <label style={STYLES.label}>Date</label>
              <cf-input
                $value={date}
                type="date"
                style={{ width: "100%" }}
              />
            </div>

            {/* Time Inputs */}
            <div style={{ display: "flex", gap: "8px" }}>
              <div style={{ flex: 1 }}>
                <label style={STYLES.label}>Start Time</label>
                <cf-input
                  $value={startTime}
                  type="time"
                  style={{ width: "100%" }}
                  oncf-change={onStartTimeChange({ startTime, endTime })}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={STYLES.label}>End Time</label>
                <cf-input
                  $value={endTime}
                  type="time"
                  style={{ width: "100%" }}
                />
              </div>
            </div>

            {/* Color Picker */}
            <div>
              <label style={STYLES.label}>Color</label>
              <div style={{ display: "flex", gap: "6px" }}>
                {COLORS.map((c) => (
                  <div
                    style={{
                      ...STYLES.colorSwatch,
                      backgroundColor: c,
                      border: computed(() =>
                        color.get() === c
                          ? "2px solid #111"
                          : "2px solid transparent"
                      ),
                    }}
                    onClick={selectColor({ color, selectedColor: c })}
                  />
                ))}
              </div>
            </div>

            {/* Notes */}
            <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
              <label style={STYLES.label}>Notes</label>
              <cf-textarea
                $value={notes}
                placeholder="Add notes about this event..."
                style={{ flex: 1, minHeight: "100px" }}
              />
            </div>
          </cf-vstack>

          {/* Backlinks footer */}
          <cf-hstack
            slot="footer"
            gap="2"
            padding="3"
            style={{
              display: computed(() =>
                backlinks.get().length > 0 ? "flex" : "none"
              ),
              alignItems: "center",
              borderTop: "1px solid var(--cf-theme-color-border, #e5e5e7)",
              flexWrap: "wrap",
            }}
          >
            <span
              style={{
                fontSize: "12px",
                lineHeight: "28px",
                color: "var(--cf-theme-color-text-secondary, #666)",
              }}
            >
              Linked from:
            </span>
            {backlinks.map((piece) => (
              <cf-button
                variant="ghost"
                size="sm"
                onClick={handleBacklinkClick({ piece })}
                style={{ fontSize: "12px" }}
              >
                {piece?.[NAME]}
              </cf-button>
            ))}
          </cf-hstack>
        </cf-screen>
      ),
      title,
      date,
      startTime,
      endTime,
      color,
      notes,
      summary: computed(() => {
        const t = title.get();
        const d = date.get() ? formatDateDisplay(date.get()) : "";
        const st = startTime.get() ? formatTime12h(startTime.get()) : "";
        const et = endTime.get() ? formatTime12h(endTime.get()) : "";
        const n = notes.get();
        return `${t}${d ? ` on ${d}` : ""}${st ? ` ${st}` : ""}${
          et ? `-${et}` : ""
        }${n ? `: ${n.slice(0, 150)}` : ""}`;
      }),
      isHidden,
      eventId,
      backlinks,
      // LLM-callable streams
      setTitle: handleSetTitle({ title }),
      setDate: handleSetDate({ date }),
      setTime: handleSetTime({ startTime, endTime }),
      setColor: handleSetColor({ color }),
      setNotes: handleSetNotes({ notes }),
    };
  },
);

export default Event;
export { COLORS, generateId };
