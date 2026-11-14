import { computed, NAME, pattern, UI, type VNode, wish } from "commonfabric";

// ===== Types =====

type EventListInput = Record<string, never>;

type Event = {
  title: string;
  date: string;
  time: string;
  notes: string;
};

export type EventListOutput = {
  [NAME]: string;
  [UI]: VNode;
  events: Event[];
};

// ===== Pattern =====

export interface EventListViewInput {
  /** The events to list. */
  events: Event[];
}

/** Lists `events`, and counts them in its name. */
export const EventListView = pattern<EventListViewInput, EventListOutput>((
  { events },
) => {
  return {
    [NAME]: computed(() =>
      events.length ? `Events: ${events.length}` : "Events"
    ),
    [UI]: (
      <cf-vstack gap="2" style="padding: 1.5rem;">
        <div>
          {events.map((event) => (
            <cf-vstack
              gap="1"
              style="border: 1px solid #e0e0e0; border-radius: 8px; padding: 1rem; margin-bottom: 1rem;"
            >
              <cf-hstack gap="2" align="center">
                <strong style="font-size: 1.1em;">{event.title}</strong>
              </cf-hstack>
              <cf-hstack gap="2" align="center">
                <span style="color: #666;">📅 {event.date}</span>
                <span style="color: #666;">🕐 {event.time}</span>
              </cf-hstack>
              {event.notes && (
                <div style="color: #555; margin-top: 0.5rem;">
                  {event.notes}
                </div>
              )}
            </cf-vstack>
          ))}
        </div>
      </cf-vstack>
    ),
    events,
  };
});

/** Lists the events the space and the viewer's home space mention. */
const EventList = pattern<EventListInput, EventListOutput>(() => {
  const events = wish<Event>({ query: "#event", scope: [".", "~"] });
  return EventListView({ events: events.candidates });
});

export default EventList;
