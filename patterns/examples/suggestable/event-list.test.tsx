import { assert, NAME, pattern, TESTS, UI } from "commonfabric";
import { hasText } from "../../tools/test-support/vnode-helpers.ts";
import EventList, { EventListView } from "./event-list.tsx";

export default pattern(() => {
  // In a space that mentions no events, the list is empty.
  const empty = EventList({});
  const list = EventListView({
    events: [
      {
        title: "Standup",
        date: "2026-11-13",
        time: "09:00",
        notes: "Bring updates",
      },
      { title: "Design review", date: "2026-11-14", time: "14:30", notes: "" },
    ],
  });

  const assert_empty_space_lists_nothing = assert(() =>
    empty[NAME] === "Events" && empty.events.length === 0 &&
    !hasText(empty[UI], "📅")
  );
  const assert_counts_events = assert(() =>
    list[NAME] === "Events: 2" && list.events.length === 2
  );
  const assert_renders_each_event = assert(() =>
    hasText(list[UI], "Standup") && hasText(list[UI], "📅 2026-11-13") &&
    hasText(list[UI], "🕐 09:00") && hasText(list[UI], "Design review") &&
    hasText(list[UI], "🕐 14:30")
  );
  const assert_renders_notes = assert(() => hasText(list[UI], "Bring updates"));

  return {
    [TESTS]: [
      { assertion: assert_empty_space_lists_nothing },
      { assertion: assert_counts_events },
      { assertion: assert_renders_each_event },
      { assertion: assert_renders_notes },
    ],
    list,
  };
});
