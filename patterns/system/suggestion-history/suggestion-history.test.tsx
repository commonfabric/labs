/**
 * Test Pattern: the suggestion history
 *
 * The history is whatever the user's favorites tag `#suggestions`, read only
 * where it is shaped as history. The test favorites a list of entries under
 * that tag, one of them malformed, and reads the history back through its
 * entries and its view, then searches entries with the history's search tool.
 */
import {
  action,
  assert,
  NAME,
  pattern,
  TESTS,
  UI,
  wish,
  Writable,
} from "commonfabric";
import { hasText } from "../../tools/test-support/vnode-helpers.ts";
import SuggestionHistory, {
  searchPattern,
  type SuggestionHistoryEntry,
} from "./suggestion-history.tsx";

type Favorite = { cell: Writable<unknown>; userTags: string[] };

export default pattern(() => {
  const defaultApp = wish<Writable<{ favorites?: Favorite[] }>>({
    query: "#default",
  }).result!;

  const picnic = new Writable<{ [NAME]?: string }>({ [NAME]: "Picnic plan" });
  const salad = new Writable<{ [NAME]?: string }>({ [NAME]: "Salad recipe" });

  const entries: SuggestionHistoryEntry[] = [
    {
      result: picnic,
      messages: [
        { role: "user", content: "Plan a picnic" },
        { role: "assistant", content: "Secret reasoning" },
      ],
      timestamp: "2026-11-01T10:00:00Z",
    },
    {
      result: salad,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "A green" },
          { type: "image", url: "leaf.png" },
          { type: "text", text: "salad" },
        ],
      }],
      timestamp: "2026-10-05T09:00:00Z",
    },
    // Content that is neither text nor parts contributes nothing.
    {
      result: salad,
      messages: [{ role: "user", content: 42 }],
      timestamp: "2026-09-09T09:00:00Z",
    },
  ];

  // ===== The history the user's favorites hold =====

  const stored = new Writable<unknown[]>([]);
  const history = SuggestionHistory({});

  const action_favorite_history = action(() => {
    stored.set([
      {
        result: picnic,
        messages: [{ role: "user", content: "Plan a picnic" }],
        timestamp: "2026-11-01T10:00:00Z",
      },
      // Not history: no messages.
      { result: salad, timestamp: "2026-10-05T09:00:00Z" },
    ]);
    defaultApp.key("favorites").set([{
      cell: stored,
      userTags: ["suggestions"],
    }]);
  });
  const assert_reads_history_entries = assert(() =>
    history.entries.length === 1 &&
    history.entries[0].timestamp === "2026-11-01T10:00:00Z"
  );
  const assert_view_shows_entries = assert(() =>
    hasText(history[UI], "2026-11-01T10:00:00Z") &&
    !hasText(history[UI], "2026-10-05T09:00:00Z")
  );

  // ===== Search =====

  const everything = searchPattern({ query: " ", entries });
  const byUserText = searchPattern({ query: "PICNIC", entries });
  const byPartText = searchPattern({ query: "green salad", entries });
  const byAssistantText = searchPattern({ query: "secret", entries });
  const byTimestamp = searchPattern({ query: "2026-09", entries });

  const assert_blank_search_returns_all = assert(() => everything.length === 3);
  const assert_search_matches_user_text = assert(() =>
    byUserText.map((e) => e.timestamp).join() === "2026-11-01T10:00:00Z" &&
    byPartText.map((e) => e.timestamp).join() === "2026-10-05T09:00:00Z"
  );
  const assert_search_ignores_assistant_text = assert(() =>
    byAssistantText.length === 0
  );
  const assert_search_matches_timestamp = assert(() =>
    byTimestamp.map((e) => e.timestamp).join() === "2026-09-09T09:00:00Z"
  );

  return {
    [TESTS]: [
      { action: action_favorite_history },
      { assertion: assert_reads_history_entries },
      { assertion: assert_view_shows_entries },
      { assertion: assert_blank_search_returns_all },
      { assertion: assert_search_matches_user_text },
      { assertion: assert_search_ignores_assistant_text },
      { assertion: assert_search_matches_timestamp },
    ],
    history,
  };
});
