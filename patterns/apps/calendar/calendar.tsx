import {
  action,
  computed,
  Default,
  equals,
  NAME,
  navigateTo,
  pattern,
  Stream,
  UI,
  type VNode,
  wish,
  Writable,
} from "commonfabric";

import EventDetail, { type EventPiece } from "./event-detail.tsx";

// Re-export for consumers and tests
export type { EventPiece };

interface CalendarInput {
  events?: Writable<EventPiece[] | Default<[]>>;
}

export interface CalendarOutput {
  [NAME]: string;
  [UI]: VNode;
  events: EventPiece[];
  sortedEvents: EventPiece[];
  mentionable: EventPiece[];
  todayDate: string;
  summary: string;
  addEvent: Stream<{ title: string; date: string; time: string }>;
  removeEvent: Stream<{ event: EventPiece }>;
}

// `nowMs` is the current time in epoch milliseconds (the caller reads #now).
const getTodayDate = (nowMs: number): string => {
  return new Date(nowMs).toISOString().split("T")[0];
};

const formatDate = (date: string): string => {
  if (!date) return "";
  const d = new Date(date + "T00:00:00");
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
};

const isToday = (date: string, today: string): boolean => date === today;
const isPast = (date: string, today: string): boolean =>
  today !== "" && date < today;

export default pattern<CalendarInput, CalendarOutput>(({ events }) => {
  const nowCell = wish<number>({ query: "#now" });
  const todayDate = computed(() => {
    const nowMs = nowCell.result;
    return nowMs != null ? getTodayDate(nowMs) : "";
  });

  const newTitle = new Writable("");
  // Seed empty and fill from #now once it resolves, so the date input defaults
  // to today without reading the ambient clock at pattern body.
  const newDate = new Writable("");
  computed(() => {
    const nowMs = nowCell.result;
    if (nowMs != null && newDate.get() === "") {
      newDate.set(getTodayDate(nowMs));
    }
  });
  const newTime = new Writable("");

  const eventCount = computed(() => events.get()?.length ?? 0);

  const sortedEvents = computed((): EventPiece[] => {
    const all = events.get();
    if (!Array.isArray(all)) return [];
    return [...all].filter((e) => e).sort((a, b) => {
      const aDate = a.date ?? "";
      const bDate = b.date ?? "";
      if (aDate !== bDate) return aDate.localeCompare(bDate);
      return (a.time || "").localeCompare(b.time || "");
    });
  });

  const summary = computed(() => {
    const sorted = sortedEvents;
    return sorted
      .map((e) => `${e.date} ${e.time || ""} ${e.title}`.trim())
      .join(", ");
  });

  const addEvent = action(
    ({ title, date, time }: { title: string; date: string; time: string }) => {
      const trimmed = title.trim();
      if (trimmed && date) {
        events.push(EventDetail({ title: trimmed, date, time }));
        newTitle.set("");
        newTime.set("");
      }
    },
  );

  const removeEvent = action(({ event }: { event: EventPiece }) => {
    const current = events.get();
    const idx = current.findIndex((e) => equals(event, e));
    if (idx >= 0) {
      events.set(current.toSpliced(idx, 1));
    }
  });

  return {
    [NAME]: "Calendar",
    [UI]: (
      <cf-screen>
        <cf-vstack slot="header" gap="1">
          <cf-hstack justify="between" align="center">
            <cf-heading level={4}>Calendar ({eventCount})</cf-heading>
            <span style="font-size: 0.875rem; color: var(--cf-colors-gray-500);">
              {todayDate}
            </span>
          </cf-hstack>
        </cf-vstack>

        <cf-vscroll flex showScrollbar fadeEdges>
          <cf-vstack gap="3" style="padding: 1rem;">
            {computed(() => {
              const sorted = sortedEvents;
              if (sorted.length === 0) {
                return (
                  <div style="text-align: center; color: var(--cf-colors-gray-500); padding: 2rem;">
                    No events yet. Add one below!
                  </div>
                );
              }

              let lastDate = "";
              return sorted.flatMap((event) => {
                const date = event.date;
                const items = [];

                if (date !== lastDate) {
                  lastDate = date;
                  const dateIsToday = isToday(date, todayDate);
                  const dateIsPast = isPast(date, todayDate);
                  items.push(
                    <cf-hstack gap="2" align="center">
                      <span
                        style={{
                          fontWeight: "600",
                          fontSize: "0.875rem",
                          color: dateIsToday
                            ? "var(--cf-colors-primary-500)"
                            : dateIsPast
                            ? "var(--cf-colors-gray-400)"
                            : "var(--cf-colors-gray-700)",
                        }}
                      >
                        {formatDate(date)}
                      </span>
                      {dateIsToday
                        ? (
                          <span style="font-size: 0.75rem; background: var(--cf-colors-primary-100); color: var(--cf-colors-primary-700); padding: 0.125rem 0.5rem; border-radius: 999px;">
                            Today
                          </span>
                        )
                        : null}
                    </cf-hstack>,
                  );
                }

                items.push(
                  <cf-card>
                    <cf-hstack gap="2" align="center">
                      {event.time && (
                        <span style="font-size: 0.875rem; color: var(--cf-colors-gray-500); min-width: 50px;">
                          {event.time}
                        </span>
                      )}
                      <cf-vstack gap="0" style="flex: 1;">
                        <span style="font-weight: 500;">
                          {event.title || "(untitled)"}
                        </span>
                        {event.notes && (
                          <span style="font-size: 0.75rem; color: var(--cf-colors-gray-500); font-style: italic; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%;">
                            {event.notes}
                          </span>
                        )}
                      </cf-vstack>
                      <cf-button
                        variant="secondary"
                        onClick={() => navigateTo(event)}
                      >
                        Edit
                      </cf-button>
                      <cf-button
                        variant="ghost"
                        onClick={() => removeEvent.send({ event })}
                      >
                        ×
                      </cf-button>
                    </cf-hstack>
                  </cf-card>,
                );

                return items;
              });
            })}
          </cf-vstack>
        </cf-vscroll>

        <cf-vstack slot="footer" gap="2" style="padding: 1rem;">
          <cf-hstack gap="2">
            <cf-input
              $value={newTitle}
              placeholder="Event title..."
              style="flex: 1;"
            />
            <cf-input $value={newDate} type="date" style="width: 140px;" />
            <cf-input $value={newTime} type="time" style="width: 100px;" />
            <cf-button
              variant="primary"
              onClick={() =>
                addEvent.send({
                  title: newTitle.get(),
                  date: newDate.get(),
                  time: newTime.get(),
                })}
            >
              Add
            </cf-button>
          </cf-hstack>
        </cf-vstack>
      </cf-screen>
    ),
    events,
    sortedEvents,
    mentionable: events,
    todayDate,
    summary,
    addEvent,
    removeEvent,
  };
});
