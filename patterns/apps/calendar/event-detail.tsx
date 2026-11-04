import {
  action,
  computed,
  Default,
  NAME,
  pattern,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

/** Input for creating a new event detail piece */
interface EventDetailInput {
  title?: Writable<string | Default<"">>;
  date?: Writable<string | Default<"">>;
  time?: Writable<string | Default<"">>;
  notes?: Writable<string | Default<"">>;
}

/**
 * Output shape of the event piece - this is what gets stored in calendars
 * #event
 */
export interface EventDetailOutput {
  [NAME]: string;
  [UI]: VNode;
  title: string;
  date: string;
  time: string;
  notes: string;
  summary: string;
  setTitle: Stream<{ title: string }>;
  setDate: Stream<{ date: string }>;
  setTime: Stream<{ time: string }>;
  setNotes: Stream<{ notes: string }>;
}

// Re-export the Output type as EventPiece for use in collections
export type EventPiece = EventDetailOutput;

export default pattern<EventDetailInput, EventDetailOutput>(
  ({ title, date, time, notes }) => {
    const setTitle = action(({ title: newTitle }: { title: string }) => {
      title.set(newTitle);
    });

    const setDate = action(({ date: newDate }: { date: string }) => {
      date.set(newDate);
    });

    const setTime = action(({ time: newTime }: { time: string }) => {
      time.set(newTime);
    });

    const setNotes = action(({ notes: newNotes }: { notes: string }) => {
      notes.set(newNotes);
    });

    return {
      [NAME]: computed(() => `Event: ${title.get()}`),
      [UI]: (
        <cf-screen>
          <cf-vstack slot="header">
            <cf-heading level={4}>{title || "New Event"}</cf-heading>
          </cf-vstack>

          <cf-vscroll flex showScrollbar fadeEdges>
            <cf-vstack gap="3" style="padding: 1rem;">
              <cf-card>
                <cf-vstack gap="2">
                  <cf-vstack gap="1">
                    <label style="font-size: 0.75rem; font-weight: 500; color: var(--cf-colors-gray-500);">
                      Title
                    </label>
                    <cf-input $value={title} placeholder="Event title" />
                  </cf-vstack>

                  <cf-hstack gap="2">
                    <cf-vstack gap="1" style="flex: 1;">
                      <label style="font-size: 0.75rem; font-weight: 500; color: var(--cf-colors-gray-500);">
                        Date
                      </label>
                      <cf-input $value={date} type="date" />
                    </cf-vstack>

                    <cf-vstack gap="1" style="flex: 1;">
                      <label style="font-size: 0.75rem; font-weight: 500; color: var(--cf-colors-gray-500);">
                        Time
                      </label>
                      <cf-input $value={time} type="time" />
                    </cf-vstack>
                  </cf-hstack>
                </cf-vstack>
              </cf-card>

              <cf-card>
                <cf-vstack gap="1">
                  <label style="font-size: 0.75rem; font-weight: 500; color: var(--cf-colors-gray-500);">
                    Notes
                  </label>
                  <cf-textarea
                    $value={notes}
                    placeholder="Add details about this event..."
                    rows={6}
                  />
                </cf-vstack>
              </cf-card>
            </cf-vstack>
          </cf-vscroll>
        </cf-screen>
      ),
      title,
      date,
      time,
      notes,
      summary: computed(() => {
        const t = title.get();
        const d = date.get();
        const tm = time.get();
        return `${t}${d ? ` on ${d}` : ""}${tm ? ` at ${tm}` : ""}${
          notes.get() ? `: ${notes.get().slice(0, 150)}` : ""
        }`;
      }),
      setTitle,
      setDate,
      setTime,
      setNotes,
    };
  },
);
