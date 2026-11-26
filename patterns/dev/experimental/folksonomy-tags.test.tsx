/**
 * Test Pattern: the folksonomy tag editor
 *
 * The editor keeps one item's tags, offers the community's tags for its scope
 * as autocomplete suggestions, and reports every tag it adds or removes to the
 * aggregator. The aggregator is injected here, so the events the editor posts
 * land in a cell the test reads back, and the suggestions it offers come from
 * events the test seeds.
 *
 * Run: deno task cf test patterns/dev/experimental/folksonomy-tags.test.tsx --root patterns
 */
import {
  action,
  assert,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  findElement,
  fireEvent,
  hasText,
  propValue,
} from "../../tools/test-support/vnode-helpers.ts";
import AggregatorPattern from "./folksonomy-aggregator.tsx";
import FolksonomyTags from "./folksonomy-tags.tsx";

interface TagEvent {
  scope: string;
  tag: string;
  action: "add" | "use" | "remove";
  timestamp: number;
}

const seeded = (scope: string, tag: string, timestamp: number): TagEvent => ({
  scope,
  tag,
  action: "add",
  timestamp,
});

/** The events the editor posted, as "action tag" strings, oldest first. */
const posted = (events: TagEvent[]): string[] =>
  events.filter((event) => event.timestamp > 100).map((event) =>
    `${event.action} ${event.tag}`
  );

const isSuggestion = (
  item: unknown,
): item is { label: string; group: string } =>
  typeof item === "object" && item !== null && "label" in item &&
  typeof item.label === "string" && "group" in item &&
  typeof item.group === "string";

/** The labels of the autocomplete items an editor's view offers, with any item
 * that is not a suggestion spelled out so that it fails the comparison. */
const suggestionLabels = (ui: unknown): string[] => {
  const items = propValue(findElement(ui, "cf-autocomplete"), "items") ?? [];
  return Array.isArray(items)
    ? items.map((item) =>
      isSuggestion(item)
        ? `${item.group}: ${item.label}`
        : `not a suggestion: ${JSON.stringify(item)}`
    )
    : [`not a list: ${JSON.stringify(items)}`];
};

/** Fires the autocomplete's change event the way picking a tag does. */
const reportChange = (ui: unknown, value: readonly string[]): void =>
  fireEvent(
    findElement(ui, "cf-autocomplete"),
    "oncf-change",
    { value, oldValue: [] },
    "the autocomplete",
  );

export default pattern(() => {
  const events = new Writable<TagEvent[]>([
    seeded("recipes", "pasta", 1),
    seeded("recipes", "pasta", 2),
    seeded("recipes", "quick", 3),
    seeded("elsewhere", "unrelated", 4),
  ]);
  const aggregator = AggregatorPattern({ events });

  const tags = new Writable<string[]>([]);
  const editor = FolksonomyTags({
    scope: new Writable("recipes"),
    tags,
    aggregator,
  });

  const localTags = new Writable<string[]>([]);
  const local = FolksonomyTags({
    scope: new Writable("recipes"),
    tags: localTags,
  });

  const action_add_two_tags = action(() => {
    editor.addTag.send({ tag: "  Pasta " });
    editor.addTag.send({ tag: "pasta" });
    editor.addTag.send({ tag: "   " });
    editor.addTag.send({ tag: "quick" });
  });
  const action_report_change = action(() =>
    reportChange(editor[UI], tags.get())
  );
  const action_add_vegan = action(() => {
    editor.addTag.send({ tag: "vegan" });
  });
  const action_remove_pasta = action(() => {
    editor.removeTag.send({ tag: " Pasta " });
  });
  const action_tag_local = action(() => {
    local.addTag.send({ tag: "solo" });
  });
  const action_report_local_change = action(() =>
    reportChange(local[UI], ["solo"])
  );

  const assert_starts_empty = assert(() =>
    editor[NAME] === "🏷️ Tags" && editor.tags.length === 0 &&
    hasText(editor[UI], "No tags yet. Type to add one.")
  );
  // Suggestions are this scope's community tags, most used first, with their
  // counts; the other scope's tag is not offered.
  const assert_suggests_scope_tags = assert(() => {
    const labels = suggestionLabels(editor[UI]);
    return labels.length === 2 && labels[0] === "Community: pasta (2)" &&
      labels[1] === "Community: quick (1)";
  });
  const assert_reports_connected = assert(() =>
    hasText(editor[UI], "Connected to community aggregator") &&
    !hasText(editor[UI], "Local mode")
  );
  const assert_local_reports_local_mode = assert(() =>
    hasText(local[UI], "Local mode") &&
    !hasText(local[UI], "Connected to community aggregator") &&
    suggestionLabels(local[UI]).length === 0
  );

  // Blank and case-insensitive duplicate tags are ignored, and the added
  // tags render and drop out of the suggestions.
  const assert_two_tags_added = assert(() =>
    editor.tags.length === 2 && editor.tags[0] === "Pasta" &&
    editor.tags[1] === "quick" && editor[NAME] === "🏷️ Tags (2)" &&
    hasText(editor[UI], "Pasta") &&
    !hasText(editor[UI], "No tags yet") &&
    suggestionLabels(editor[UI]).length === 0
  );
  const assert_nothing_posted_before_change = assert(() =>
    posted(aggregator.events).length === 0
  );
  // The first change after tags already exist posts only the newest tag.
  const assert_first_change_posts_newest = assert(() => {
    const sent = posted(aggregator.events);
    return sent.length === 1 && sent[0] === "add quick" &&
      aggregator.events[aggregator.events.length - 1].scope === "recipes";
  });
  // Later changes post exactly the tags that are new since the last change.
  const assert_change_posts_new_tag = assert(() => {
    const sent = posted(aggregator.events);
    return sent.length === 2 && sent[1] === "add vegan";
  });
  // The remove button drops its own tag and posts the removal.
  const assert_button_removes_quick = assert(() => {
    const sent = posted(aggregator.events);
    return editor.tags.length === 2 && editor.tags[0] === "Pasta" &&
      editor.tags[1] === "vegan" && sent.length === 3 &&
      sent[2] === "remove quick";
  });
  // The remove stream drops the named tag, trimmed. Unlike the remove button,
  // it sends the aggregator no event.
  const assert_stream_removes_pasta = assert(() =>
    editor.tags.length === 1 && editor.tags[0] === "vegan" &&
    posted(aggregator.events).length === 3 &&
    suggestionLabels(editor[UI])[0] === "Community: pasta (2)"
  );
  // Without an aggregator the editor keeps its tags to itself: the change
  // updates the tags and the name, and the view stays in local mode.
  const assert_local_keeps_its_tag = assert(() =>
    local.tags.length === 1 && local.tags[0] === "solo" &&
    local[NAME] === "🏷️ Tags (1)" && hasText(local[UI], "Local mode")
  );

  return {
    [TESTS]: [
      { assertion: assert_starts_empty },
      { assertion: assert_suggests_scope_tags },
      { assertion: assert_reports_connected },
      { assertion: assert_local_reports_local_mode },

      { action: action_add_two_tags },
      { assertion: assert_two_tags_added },
      { assertion: assert_nothing_posted_before_change },

      { action: action_report_change },
      { assertion: assert_first_change_posts_newest },

      { action: action_add_vegan },
      { action: action_report_change },
      { assertion: assert_change_posts_new_tag },

      { press: editor[UI], control: "×", within: "quick" },
      { assertion: assert_button_removes_quick },

      { action: action_remove_pasta },
      { assertion: assert_stream_removes_pasta },

      { action: action_tag_local },
      { action: action_report_local_change },
      { assertion: assert_local_keeps_its_tag },
    ],
  };
});
