/**
 * Weekly Calendar Pattern
 *
 * A weekly calendar that manages Event patterns (event.tsx) similar to how
 * notebook.tsx manages note.tsx patterns. Events are independent pieces that
 * can be viewed, edited, and created from this calendar.
 *
 * Features:
 * - Day/Week view toggle
 * - Drag to move events between days/times
 * - Drag to resize event duration
 * - Click time slots to create new events
 * - Color-coded events
 * - Events are separate pieces that can be opened and edited
 */
import {
  action,
  Cell,
  computed,
  Default,
  handler,
  ifElse,
  NAME,
  navigateTo,
  pattern,
  Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";

import Event, { COLORS, generateId } from "./event.tsx";

// ============ TYPES ============

export type EventPiece = {
  [NAME]?: string;
  title?: string;
  date?: string;
  startTime?: string;
  endTime?: string;
  color?: string;
  notes?: string;
  isHidden?: boolean;
  eventId?: string;
};

type MinimalPiece = {
  [NAME]?: string;
};

// Type for backlinks
type MentionablePiece = {
  [NAME]?: string;
  isHidden?: boolean;
  mentioned: MentionablePiece[];
  backlinks: MentionablePiece[];
};

interface Input {
  title?: string | Default<"Weekly Calendar">;
  events: Writable<EventPiece[] | Default<[]>>;
  isCalendar?: boolean | Default<true>; // Marker for identification
  isHidden?: boolean | Default<false>;
}

export interface Output {
  [UI]: VNode;
  title: string;
  events: EventPiece[];
  mentionable: EventPiece[];
  eventCount: number;
  summary: string;
  isCalendar: boolean;
  isHidden: boolean;
  backlinks: MentionablePiece[];
  // LLM-callable streams
  createEvent: Stream<{
    title: string;
    date: string;
    startTime: string;
    endTime: string;
  }>;
  setTitle: Stream<{ newTitle: string }>;
}

// ============ CONSTANTS ============

const HOUR_HEIGHT = 60;
const DAY_START = 6;
const DAY_END = 22;
const RESIZE_HANDLE_HEIGHT = 14;
const SLOT_HEIGHT = 30;

// ============ STYLES ============

const STYLES = {
  button: {
    base: {
      padding: "4px 8px",
      fontSize: "0.75rem",
      border: "1px solid #d1d5db",
      borderRadius: "4px",
      backgroundColor: "#fff",
      cursor: "pointer",
    },
    primary: {
      padding: "4px 12px",
      fontSize: "0.75rem",
      border: "none",
      borderRadius: "4px",
      backgroundColor: "#3b82f6",
      color: "#fff",
      cursor: "pointer",
    },
    danger: {
      padding: "6px 12px",
      fontSize: "0.75rem",
      border: "none",
      borderRadius: "4px",
      backgroundColor: "#fee2e2",
      color: "#dc2626",
      cursor: "pointer",
    },
  },
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

// ============ DATE HELPERS ============

const formatDatePST = (d: Date): string =>
  d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

// `nowMs` is the current time in epoch milliseconds (the caller reads #now in a
// lift, or Date.now() in a handler/action).
const getTodayDate = (nowMs: number): string => formatDatePST(new Date(nowMs));

const getWeekStart = (date: string): string => {
  const d = new Date(date + "T12:00:00-08:00");
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return formatDatePST(d);
};

const addDays = (date: string, days: number): string => {
  const d = new Date(date + "T12:00:00-08:00");
  d.setDate(d.getDate() + days);
  return formatDatePST(d);
};

const getWeekDates = (start: string, count: number): string[] => {
  const dates: string[] = [];
  const d = new Date(start + "T12:00:00-08:00");
  for (let i = 0; i < count; i++) {
    const nd = new Date(d);
    nd.setDate(d.getDate() + i);
    dates.push(formatDatePST(nd));
  }
  return dates;
};

const formatDateHeader = (date: string): string => {
  const d = new Date(date + "T12:00:00-08:00");
  return d.toLocaleDateString("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
};

// ============ TIME HELPERS ============

const timeToMinutes = (time: string): number => {
  if (!time) return 0;
  const [h, m] = time.split(":").map(Number);
  return h * 60 + (m || 0);
};

const minutesToTime = (minutes: number): string => {
  const h = Math.min(23, Math.max(0, Math.floor(minutes / 60)));
  const m = Math.max(0, minutes % 60);
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
};

const addMinutesToTime = (time: string, minutes: number): string =>
  minutesToTime(timeToMinutes(time) + minutes);

const addHoursToTime = (time: string, hours: number): string =>
  addMinutesToTime(time, hours * 60);

// ============ HOUR DATA (Static - computed once) ============

const buildHours = (): Array<
  { idx: number; label: string; startTime: string }
> => {
  const hours: Array<{ idx: number; label: string; startTime: string }> = [];
  for (let h = DAY_START; h < DAY_END; h++) {
    const period = h >= 12 ? "PM" : "AM";
    const hour = h % 12 || 12;
    const startTime = `${h.toString().padStart(2, "0")}:00`;
    hours.push({ idx: h - DAY_START, label: `${hour} ${period}`, startTime });
  }
  return hours;
};

const GRID_HEIGHT = 960;
const COLUMN_INDICES = [0, 1, 2, 3, 4, 5, 6] as const;

// ============ MODULE-SCOPE HANDLERS (for LLM-callable streams) ============

// Handler to show the new event modal
const showNewEventModal = handler<
  void,
  { showNewEventPrompt: Writable<boolean> }
>((_, { showNewEventPrompt }) => showNewEventPrompt.set(true));

// Handler to create event and close modal (stays on calendar)
export const createEventHandler = handler<
  void,
  {
    newEventTitle: Writable<string>;
    newEventDate: Writable<string>;
    newEventStartTime: Writable<string>;
    newEventEndTime: Writable<string>;
    newEventColor: Writable<string>;
    showNewEventPrompt: Writable<boolean>;
    events: Writable<EventPiece[]>;
    pieceRegistry: Writable<EventPiece[]>;
  }
>((
  _,
  {
    newEventTitle,
    newEventDate,
    newEventStartTime,
    newEventEndTime,
    newEventColor,
    showNewEventPrompt,
    events,
    pieceRegistry,
  },
) => {
  const title = newEventTitle.get() || "New Event";
  const newEvent = Event({
    title,
    date: newEventDate.get(),
    startTime: newEventStartTime.get(),
    endTime: newEventEndTime.get(),
    color: newEventColor.get(),
    notes: "",
    isHidden: false,
    eventId: generateId(),
  });
  pieceRegistry.push(newEvent);
  events.push(newEvent);

  // Reset modal state and stay on calendar
  showNewEventPrompt.set(false);
  newEventTitle.set("");
});

// Handler to create event and stay in modal
export const createEventAndContinue = handler<
  void,
  {
    newEventTitle: Writable<string>;
    newEventDate: Writable<string>;
    newEventStartTime: Writable<string>;
    newEventEndTime: Writable<string>;
    newEventColor: Writable<string>;
    events: Writable<EventPiece[]>;
    pieceRegistry: Writable<EventPiece[]>;
    usedCreateAnother: Writable<boolean>;
  }
>((
  _,
  {
    newEventTitle,
    newEventDate,
    newEventStartTime,
    newEventEndTime,
    newEventColor,
    events,
    pieceRegistry,
    usedCreateAnother,
  },
) => {
  const title = newEventTitle.get() || "New Event";
  const newEvent = Event({
    title,
    date: newEventDate.get(),
    startTime: newEventStartTime.get(),
    endTime: newEventEndTime.get(),
    color: newEventColor.get(),
    notes: "",
    isHidden: false,
    eventId: generateId(),
  });
  pieceRegistry.push(newEvent);
  events.push(newEvent);
  usedCreateAnother.set(true);
  newEventTitle.set("");
});

// Handler to cancel new event prompt
const cancelNewEventPrompt = handler<
  void,
  {
    showNewEventPrompt: Writable<boolean>;
    newEventTitle: Writable<string>;
    usedCreateAnother: Writable<boolean>;
  }
>((_, { showNewEventPrompt, newEventTitle, usedCreateAnother }) => {
  showNewEventPrompt.set(false);
  newEventTitle.set("");
  usedCreateAnother.set(false);
});

// Handler for clicking on a backlink
const handleBacklinkClick = handler<
  void,
  { piece: Writable<MentionablePiece> }
>((_, { piece }) => navigateTo(piece));

// LLM-callable handler: Create a single event
export const handleCreateEvent = handler<
  { title: string; date: string; startTime: string; endTime: string },
  { events: Writable<EventPiece[]>; pieceRegistry: Writable<EventPiece[]> }
>(({ title, date, startTime, endTime }, { events, pieceRegistry }) => {
  const newEvent = Event({
    title,
    date,
    startTime,
    endTime,
    color: COLORS[0],
    notes: "",
    isHidden: false,
    eventId: generateId(),
  });
  pieceRegistry.push(newEvent);
  events.push(newEvent);
  return newEvent;
});

// LLM-callable handler: Rename the calendar
const handleSetTitle = handler<
  { newTitle: string },
  { title: Writable<string> }
>(({ newTitle }, { title }) => {
  title.set(newTitle);
  return newTitle;
});

// ============ PATTERN ============

const WeeklyCalendar = pattern<Input, Output>(
  ({ title, events, isCalendar, isHidden }) => {
    const pieceRegistry = wish<EventPiece[]>({
      query: "#pieceRegistry",
    }).result!;

    // Reactive #now for date defaults (filled once it resolves; the ambient
    // clock is not available at pattern body).
    const nowCell = wish<number>({ query: "#now" });

    // Navigation State
    const startDate = new Cell("");
    computed(() => {
      const nowMs = nowCell.result;
      if (nowMs != null && startDate.get() === "") {
        startDate.set(getWeekStart(getTodayDate(nowMs)));
      }
    });
    const visibleDays = new Cell(7);

    // Create Form State
    const showNewEventPrompt = new Writable<boolean>(false);
    const newEventTitle = new Writable<string>("");
    const newEventDate = new Writable<string>("");
    computed(() => {
      const nowMs = nowCell.result;
      if (nowMs != null && newEventDate.get() === "") {
        newEventDate.set(getTodayDate(nowMs));
      }
    });
    const newEventStartTime = new Writable<string>("09:00");
    const newEventEndTime = new Writable<string>("10:00");
    const newEventColor = new Writable<string>(COLORS[0]);
    const usedCreateAnother = new Writable<boolean>(false);

    // Edit Form State
    const showEditModal = new Writable<boolean>(false);
    const editingEventIndex = new Writable<number>(-1);
    const editEventTitle = new Writable<string>("");
    const editEventDate = new Writable<string>("");
    const editEventStartTime = new Writable<string>("09:00");
    const editEventEndTime = new Writable<string>("10:00");
    const editEventColor = new Writable<string>(COLORS[0]);

    // A drag-drop's pointer-up also synthesizes a click on the drop target;
    // this flag lets the next click after a drop be swallowed. A time-window
    // guard is not usable here: the in-handler clock is coarsened to one second,
    // so a millisecond-scale "just dropped" window cannot be measured.
    const suppressNextClick = new Cell(false);

    // Backlinks
    const backlinks = new Writable<MentionablePiece[]>([]);

    // Computed Values
    const eventCount = computed(() => events.get().length);
    const summary = computed(() => {
      return events.get()
        .map((e) => `${e.date || ""} ${e.title || ""}`.trim())
        .join(", ");
    });
    const hours = buildHours();
    const weekDates = computed(() => {
      const s = startDate.get();
      return s === "" ? [] : getWeekDates(s, 7);
    });
    const todayDate = computed(() => {
      const nowMs = nowCell.result;
      return nowMs != null ? getTodayDate(nowMs) : "";
    });

    // Navigation Actions (using action for internal logic)
    const goPrev = action(() => {
      startDate.set(addDays(startDate.get(), -visibleDays.get()));
    });

    const goNext = action(() => {
      startDate.set(addDays(startDate.get(), visibleDays.get()));
    });

    const goToday = action(() => {
      const today = getTodayDate(Date.now());
      startDate.set(visibleDays.get() === 1 ? today : getWeekStart(today));
    });

    // View Mode Actions
    const setDayView = action(() => visibleDays.set(1));
    const setWeekView = action(() => visibleDays.set(7));

    // Form helpers
    const onStartTimeChange = action((e: { detail: { value: string } }) => {
      const newStart = e?.detail?.value;
      if (newStart) {
        newEventEndTime.set(addHoursToTime(newStart, 1));
      }
    });

    // Color selection actions (for create modal)
    const colorActions = COLORS.map((color) =>
      action(() => newEventColor.set(color))
    );

    // Color selection actions (for edit modal)
    const editColorActions = COLORS.map((color) =>
      action(() => editEventColor.set(color))
    );

    // Edit form helpers
    const onEditStartTimeChange = action((e: { detail: { value: string } }) => {
      const newStart = e?.detail?.value;
      if (newStart) {
        editEventEndTime.set(addHoursToTime(newStart, 1));
      }
    });

    // Close edit modal
    const closeEditModal = action(() => {
      showEditModal.set(false);
      editingEventIndex.set(-1);
    });

    // Save edited event
    const saveEditedEvent = action(() => {
      const idx = editingEventIndex.get();
      if (idx < 0) return;

      const eventCell = events.key(idx);
      eventCell.key("title").set(editEventTitle.get());
      eventCell.key("date").set(editEventDate.get());
      eventCell.key("startTime").set(editEventStartTime.get());
      eventCell.key("endTime").set(editEventEndTime.get());
      eventCell.key("color").set(editEventColor.get());

      showEditModal.set(false);
      editingEventIndex.set(-1);
    });

    // Delete event
    const deleteEvent = action(() => {
      const idx = editingEventIndex.get();
      if (idx < 0) return;

      const currentEvents = events.get();
      const updated = [...currentEvents];
      updated.splice(idx, 1);
      events.set(updated);

      showEditModal.set(false);
      editingEventIndex.set(-1);
    });

    // Computed Styles for View Toggle
    const dayButtonStyle = computed(() => ({
      ...STYLES.button.base,
      backgroundColor: visibleDays.get() === 1 ? "#3b82f6" : "#fff",
      color: visibleDays.get() === 1 ? "#fff" : "#374151",
    }));

    const weekButtonStyle = computed(() => ({
      ...STYLES.button.base,
      backgroundColor: visibleDays.get() === 7 ? "#3b82f6" : "#fff",
      color: visibleDays.get() === 7 ? "#fff" : "#374151",
    }));

    // ===== Render =====
    return {
      [NAME]: computed(() => `${title} (${eventCount})`),
      [UI]: (
        <cf-screen>
          {/* Header */}
          <div
            slot="header"
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "8px 0",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontWeight: "600", fontSize: "1.1rem" }}>
                {title}
              </span>
              <span style={{ fontSize: "0.75rem", color: "#6b7280" }}>
                ({eventCount} events)
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              {/* View Mode Buttons */}
              <div style={{ display: "flex", gap: "4px" }}>
                <button
                  type="button"
                  style={dayButtonStyle}
                  onClick={setDayView}
                >
                  Day
                </button>
                <button
                  type="button"
                  style={weekButtonStyle}
                  onClick={setWeekView}
                >
                  Week
                </button>
              </div>
              {/* Navigation Buttons */}
              <div style={{ display: "flex", gap: "4px" }}>
                <button
                  type="button"
                  style={STYLES.button.base}
                  onClick={goPrev}
                >
                  &lt;
                </button>
                <button
                  type="button"
                  style={STYLES.button.base}
                  onClick={goToday}
                >
                  Today
                </button>
                <button
                  type="button"
                  style={STYLES.button.base}
                  onClick={goNext}
                >
                  &gt;
                </button>
              </div>
              {/* Add Button */}
              <button
                type="button"
                style={STYLES.button.primary}
                onClick={showNewEventModal({ showNewEventPrompt })}
              >
                + Add
              </button>
            </div>
          </div>

          {/* Main Calendar Area */}
          <div
            style={{
              display: "flex",
              flex: "1",
              overflow: "hidden",
              position: "relative",
            }}
          >
            {/* New Event Modal */}
            <cf-modal
              $open={showNewEventPrompt}
              dismissable
              size="sm"
              label="New Event"
            >
              <span slot="header">New Event</span>

              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "12px",
                }}
              >
                {/* Title Input */}
                <div>
                  <label style={STYLES.label}>Title</label>
                  <cf-input
                    $value={newEventTitle}
                    placeholder="Event title..."
                    style={{ width: "100%" }}
                  />
                </div>

                {/* Date Input */}
                <div>
                  <label style={STYLES.label}>Date</label>
                  <cf-input
                    $value={newEventDate}
                    type="date"
                    style={{ width: "100%" }}
                  />
                </div>

                {/* Time Inputs */}
                <div style={{ display: "flex", gap: "8px" }}>
                  <div style={{ flex: 1 }}>
                    <label style={STYLES.label}>Start</label>
                    <cf-input
                      $value={newEventStartTime}
                      type="time"
                      style={{ width: "100%" }}
                      oncf-change={onStartTimeChange}
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={STYLES.label}>End</label>
                    <cf-input
                      $value={newEventEndTime}
                      type="time"
                      style={{ width: "100%" }}
                    />
                  </div>
                </div>

                {/* Color Picker */}
                <div>
                  <label style={STYLES.label}>Color</label>
                  <div style={{ display: "flex", gap: "6px" }}>
                    {COLORS.map((c, idx) => (
                      <div
                        style={{
                          ...STYLES.colorSwatch,
                          backgroundColor: c,
                          border: computed(() =>
                            newEventColor.get() === c
                              ? "2px solid #111"
                              : "2px solid transparent"
                          ),
                        }}
                        onClick={colorActions[idx]}
                      />
                    ))}
                  </div>
                </div>
              </div>

              {/* Modal Footer */}
              <div
                slot="footer"
                style={{
                  display: "flex",
                  gap: "8px",
                  justifyContent: "flex-end",
                  width: "100%",
                }}
              >
                <button
                  type="button"
                  style={STYLES.button.base}
                  onClick={cancelNewEventPrompt({
                    showNewEventPrompt,
                    newEventTitle,
                    usedCreateAnother,
                  })}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  style={STYLES.button.base}
                  onClick={createEventAndContinue({
                    newEventTitle,
                    newEventDate,
                    newEventStartTime,
                    newEventEndTime,
                    newEventColor,
                    events,
                    pieceRegistry,
                    usedCreateAnother,
                  })}
                >
                  Create Another
                </button>
                <button
                  type="button"
                  style={STYLES.button.primary}
                  onClick={createEventHandler({
                    newEventTitle,
                    newEventDate,
                    newEventStartTime,
                    newEventEndTime,
                    newEventColor,
                    showNewEventPrompt,
                    events,
                    pieceRegistry,
                  })}
                >
                  Create
                </button>
              </div>
            </cf-modal>

            {/* Edit Event Modal */}
            <cf-modal
              $open={showEditModal}
              dismissable
              size="sm"
              label="Edit Event"
            >
              <span slot="header">Edit Event</span>

              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "12px",
                }}
              >
                {/* Title Input */}
                <div>
                  <label style={STYLES.label}>Title</label>
                  <cf-input
                    $value={editEventTitle}
                    placeholder="Event title..."
                    style={{ width: "100%" }}
                  />
                </div>

                {/* Date Input */}
                <div>
                  <label style={STYLES.label}>Date</label>
                  <cf-input
                    $value={editEventDate}
                    type="date"
                    style={{ width: "100%" }}
                  />
                </div>

                {/* Time Inputs */}
                <div style={{ display: "flex", gap: "8px" }}>
                  <div style={{ flex: 1 }}>
                    <label style={STYLES.label}>Start</label>
                    <cf-input
                      $value={editEventStartTime}
                      type="time"
                      style={{ width: "100%" }}
                      oncf-change={onEditStartTimeChange}
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label style={STYLES.label}>End</label>
                    <cf-input
                      $value={editEventEndTime}
                      type="time"
                      style={{ width: "100%" }}
                    />
                  </div>
                </div>

                {/* Color Picker */}
                <div>
                  <label style={STYLES.label}>Color</label>
                  <div style={{ display: "flex", gap: "6px" }}>
                    {COLORS.map((c, idx) => (
                      <div
                        style={{
                          ...STYLES.colorSwatch,
                          backgroundColor: c,
                          border: computed(() =>
                            editEventColor.get() === c
                              ? "2px solid #111"
                              : "2px solid transparent"
                          ),
                        }}
                        onClick={editColorActions[idx]}
                      />
                    ))}
                  </div>
                </div>
              </div>

              {/* Modal Footer */}
              <div
                slot="footer"
                style={{
                  display: "flex",
                  gap: "8px",
                  justifyContent: "flex-end",
                  width: "100%",
                }}
              >
                <button
                  type="button"
                  style={STYLES.button.danger}
                  onClick={deleteEvent}
                >
                  Delete
                </button>
                <div style={{ flex: 1 }} />
                <button
                  type="button"
                  style={STYLES.button.base}
                  onClick={closeEditModal}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  style={STYLES.button.primary}
                  onClick={saveEditedEvent}
                >
                  Save
                </button>
              </div>
            </cf-modal>

            {/* Calendar Grid */}
            <div
              style={{
                flex: "1",
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
                userSelect: "none",
              }}
            >
              <cf-vscroll flex showScrollbar fadeEdges>
                <div
                  style={{
                    display: "flex",
                    minHeight: `${GRID_HEIGHT + 60}px`,
                  }}
                >
                  {/* Time Labels Column */}
                  <div
                    style={{
                      width: "50px",
                      flexShrink: "0",
                      paddingTop: "50px",
                    }}
                  >
                    {hours.map((hour) => (
                      <div
                        style={{
                          height: `${HOUR_HEIGHT}px`,
                          fontSize: "0.65rem",
                          color: "#6b7280",
                          textAlign: "right",
                          paddingRight: "8px",
                        }}
                      >
                        {hour.label}
                      </div>
                    ))}
                  </div>

                  {/* Day Columns */}
                  {COLUMN_INDICES.map((colIdx) => {
                    // Computed values for this column
                    const columnDate = computed(() => weekDates[colIdx] || "");
                    const isToday = computed(() =>
                      weekDates[colIdx] === todayDate
                    );
                    const dateHeader = computed(() => {
                      const d = weekDates[colIdx];
                      return d ? formatDateHeader(d) : "";
                    });
                    const displayStyle = computed(() =>
                      colIdx < visibleDays.get() ? "flex" : "none"
                    );
                    const headerBg = computed(() =>
                      weekDates[colIdx] === todayDate
                        ? "#eff6ff"
                        : "transparent"
                    );
                    const headerColor = computed(() =>
                      weekDates[colIdx] === todayDate ? "#2563eb" : "#374151"
                    );

                    // Drop handler for moving/resizing events (using action)
                    const handleDayDrop = action((e: {
                      detail: {
                        sourceCell: Cell<EventPiece>;
                        pointerY?: number;
                        dropZoneRect?: { top: number };
                        type?: string;
                      };
                    }) => {
                      const evt = e.detail.sourceCell.get();
                      const { pointerY, dropZoneRect, type: dragType } =
                        e.detail;

                      if (pointerY === undefined || !dropZoneRect) return;

                      const relativeY = pointerY - dropZoneRect.top;
                      const slotIdx = Math.max(
                        0,
                        Math.floor(relativeY / SLOT_HEIGHT),
                      );
                      const newHour = DAY_START + Math.floor(slotIdx / 2);
                      const newMin = (slotIdx % 2) * 30;
                      const newTime = minutesToTime(
                        Math.min(DAY_END - 1, Math.max(DAY_START, newHour)) *
                            60 +
                          newMin,
                      );

                      const current = events.get();
                      const evtId = (evt as any)?.eventId;
                      const evtIdx = current.findIndex(
                        (a: any) => a?.eventId === evtId,
                      );
                      if (evtIdx < 0) return;

                      const dateVal = weekDates[colIdx];
                      const eventCell = events.key(evtIdx);

                      if (dragType === "event-resize") {
                        const adjustedY = relativeY + SLOT_HEIGHT / 2;
                        const resizeSlotIdx = Math.max(
                          0,
                          Math.floor(adjustedY / SLOT_HEIGHT),
                        );
                        const resizeHour = DAY_START +
                          Math.floor(resizeSlotIdx / 2);
                        const resizeMin = (resizeSlotIdx % 2) * 30;
                        const startMin = timeToMinutes(
                          evt.startTime || "09:00",
                        );
                        const newEndMin = Math.max(
                          startMin + 30,
                          resizeHour * 60 + resizeMin,
                        );
                        eventCell
                          .key("endTime")
                          .set(
                            minutesToTime(Math.min(DAY_END * 60, newEndMin)),
                          );
                      } else {
                        const duration = timeToMinutes(evt.endTime || "10:00") -
                          timeToMinutes(evt.startTime || "09:00");
                        eventCell.key("date").set(dateVal);
                        eventCell.key("startTime").set(newTime);
                        eventCell
                          .key("endTime")
                          .set(addMinutesToTime(newTime, duration));
                      }

                      suppressNextClick.set(true);
                    });

                    // Click handlers for creating events at specific hours (using action)
                    const hourClickActions = hours.map((hour) =>
                      action(() => {
                        if (suppressNextClick.get()) {
                          suppressNextClick.set(false);
                          return;
                        }
                        newEventTitle.set("");
                        newEventDate.set(columnDate);
                        newEventStartTime.set(hour.startTime);
                        newEventEndTime.set(addHoursToTime(hour.startTime, 1));
                        newEventColor.set(COLORS[0]);
                        showNewEventPrompt.set(true);
                      })
                    );

                    return (
                      <div
                        style={{
                          flex: "1",
                          minWidth: "100px",
                          borderRight: "1px solid #e5e7eb",
                          boxSizing: "border-box",
                          display: displayStyle,
                          flexDirection: "column",
                        }}
                      >
                        {/* Date Header */}
                        <div
                          style={{
                            height: "50px",
                            padding: "8px 4px",
                            textAlign: "center",
                            borderBottom: "1px solid #e5e7eb",
                            boxSizing: "border-box",
                            backgroundColor: headerBg,
                          }}
                        >
                          <div
                            style={{
                              fontSize: "0.75rem",
                              fontWeight: "600",
                              color: headerColor,
                            }}
                          >
                            {dateHeader}
                          </div>
                          {ifElse(
                            isToday,
                            <div
                              style={{ fontSize: "0.6rem", color: "#3b82f6" }}
                            >
                              Today
                            </div>,
                            null,
                          )}
                        </div>

                        {/* Time Grid with Drop Zone */}
                        <cf-drop-zone
                          accept="event,event-resize"
                          oncf-drop={handleDayDrop}
                          style={{ position: "relative", flex: "1" }}
                        >
                          {hours.map((hour, hourIdx) => (
                            <div
                              style={{
                                position: "absolute",
                                top: `${hour.idx * HOUR_HEIGHT}px`,
                                left: "0",
                                right: "0",
                                height: `${HOUR_HEIGHT}px`,
                                borderTop: "1px solid #e5e7eb",
                                cursor: "pointer",
                              }}
                              onClick={hourClickActions[hourIdx]}
                            />
                          ))}
                        </cf-drop-zone>
                      </div>
                    );
                  })}

                  {/* Event Blocks */}
                  {events.map((evt, evtIndex) => {
                    // Compute position and visibility
                    const styles = computed(() => {
                      const weekStart = startDate.get();
                      const visibleCount = visibleDays.get();
                      const evtDate = evt.date;

                      const hidden = {
                        top: "0",
                        height: "0",
                        left: "0",
                        width: "0",
                        display: "none" as const,
                      };

                      if (!evtDate || !weekStart) return hidden;

                      const startMs = new Date(weekStart + "T00:00:00")
                        .getTime();
                      const evtMs = new Date(evtDate + "T00:00:00").getTime();
                      if (isNaN(startMs) || isNaN(evtMs)) return hidden;

                      const dayOffset = Math.floor(
                        (evtMs - startMs) / (24 * 60 * 60 * 1000),
                      );
                      if (dayOffset < 0 || dayOffset >= visibleCount) {
                        return hidden;
                      }

                      const startMin = timeToMinutes(evt.startTime || "09:00") -
                        DAY_START * 60;
                      const endMin = timeToMinutes(evt.endTime || "10:00") -
                        DAY_START * 60;
                      const top = (startMin / 60) * HOUR_HEIGHT;
                      const height = Math.max(
                        30,
                        ((endMin - startMin) / 60) * HOUR_HEIGHT,
                      );

                      return {
                        top: `${50 + top}px`,
                        height: `${height}px`,
                        left:
                          `calc(50px + (100% - 50px) * ${dayOffset} / ${visibleCount} + 2px)`,
                        width: `calc((100% - 50px) / ${visibleCount} - 4px)`,
                        display: "block" as const,
                      };
                    });

                    // Click action to open edit modal
                    const openEvent = action(() => {
                      if (suppressNextClick.get()) {
                        suppressNextClick.set(false);
                        return;
                      }
                      // Populate edit form with event data
                      editingEventIndex.set(evtIndex);
                      editEventTitle.set(evt.title || "");
                      editEventDate.set(evt.date || "");
                      editEventStartTime.set(evt.startTime || "09:00");
                      editEventEndTime.set(evt.endTime || "10:00");
                      editEventColor.set(evt.color || COLORS[0]);
                      showEditModal.set(true);
                    });

                    // Workaround: Use computed() with evt.eventId dependency for static children
                    const resizeHandleLines = computed(() => {
                      const _id = evt.eventId;
                      return (
                        <div
                          style={{
                            width: "20px",
                            height: "4px",
                            borderTop: "1px solid rgba(0,0,0,0.2)",
                            borderBottom: "1px solid rgba(0,0,0,0.2)",
                            pointerEvents: "none",
                          }}
                        />
                      );
                    });

                    const dragAreaContent = computed(() => {
                      const _id = evt.eventId;
                      return (
                        <div
                          style={{
                            width: "100%",
                            minHeight: "200px",
                            touchAction: "none",
                          }}
                        />
                      );
                    });

                    return (
                      <div
                        style={{
                          position: "absolute",
                          top: styles.top,
                          left: styles.left,
                          width: styles.width,
                          height: styles.height,
                          minHeight: styles.height,
                          zIndex: "2",
                          backgroundColor: evt.color || COLORS[0],
                          borderRadius: "4px",
                          borderLeft: "3px solid rgba(0,0,0,0.2)",
                          overflow: "hidden",
                          display: styles.display,
                        }}
                      >
                        {/* Title */}
                        <div
                          style={{
                            padding: "4px",
                            fontSize: "0.7rem",
                            fontWeight: "500",
                            overflow: "hidden",
                            pointerEvents: "none",
                          }}
                        >
                          {evt.title || "(untitled)"}
                        </div>

                        {/* Drag Source for Moving */}
                        <cf-drag-source
                          $cell={evt}
                          type="event"
                          onClick={openEvent}
                          style={{
                            position: "absolute",
                            top: "0",
                            left: "0",
                            right: "0",
                            bottom: `${RESIZE_HANDLE_HEIGHT}px`,
                            cursor: "grab",
                            zIndex: "1",
                          }}
                        >
                          {dragAreaContent}
                        </cf-drag-source>

                        {/* Resize Drag Source */}
                        <cf-drag-source
                          $cell={evt}
                          type="event-resize"
                          style={{
                            position: "absolute",
                            bottom: "0",
                            left: "0",
                            right: "0",
                            height: `${RESIZE_HANDLE_HEIGHT}px`,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            cursor: "ns-resize",
                            zIndex: "10",
                          }}
                        >
                          {resizeHandleLines}
                        </cf-drag-source>
                      </div>
                    );
                  })}
                </div>
              </cf-vscroll>
            </div>
          </div>

          {/* Empty State */}
          {ifElse(
            computed(() => events.get().length === 0),
            <div
              slot="footer"
              style={{
                textAlign: "center",
                padding: "16px",
                color: "#6b7280",
                fontSize: "0.875rem",
              }}
            >
              No events yet. Click "+ Add" or click on a time slot.
            </div>,
            null,
          )}

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
      events,
      mentionable: events,
      eventCount,
      summary,
      isCalendar,
      isHidden,
      backlinks,
      // LLM-callable streams
      createEvent: handleCreateEvent({ events, pieceRegistry }),
      setTitle: handleSetTitle({ title }),
    };
  },
);

export default WeeklyCalendar;
