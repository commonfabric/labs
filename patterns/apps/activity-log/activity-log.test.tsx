/**
 * Test Pattern: Activity Log
 *
 * Logs events from two agents through the log's stream, reads them back
 * through the summary and the rendered list, filters the list by agent with
 * its chips, and clears it.
 *
 * Run: deno task cf test patterns/apps/activity-log/activity-log.test.tsx --verbose
 */
import {
  action,
  assert,
  NAME,
  pattern,
  type Stream,
  TESTS,
  UI,
  wish,
  Writable,
} from "commonfabric";
import {
  clickButton,
  findElement,
  findElementByExactText,
  hasText,
  propValue,
  readValue,
} from "../../tools/test-support/vnode-helpers.ts";
import ActivityLog, { type ActivityEvent } from "./activity-log.tsx";

interface Mention {
  mentioned: Mention[];
  backlinks: Mention[];
}

/** How a consumer sees an #activityLog it finds by wish. */
interface FoundLog {
  logEvent: Stream<Omit<ActivityEvent, "id" | "timestamp">>;
}

interface HomeDefault {
  favorites: { cell: unknown; tags: string[] }[];
}

export default pattern(() => {
  const events = new Writable<ActivityEvent[]>([]);
  const mentioned = new Writable<Mention[]>([]);
  const log = ActivityLog({ events, mentioned });
  // The log declares its streams opaquely, so the test reaches `logEvent` the
  // way its consumers do: by favoriting the log and wishing for it.
  const home = wish<Writable<HomeDefault>>({ query: "#default" }).result!;
  const found = wish<FoundLog>({ query: "#activityLog", headless: true });

  const assert_starts_empty = assert(() =>
    log[NAME] === "Activity Log (0)" &&
    log.summary === "No activity logged." &&
    hasText(log[UI], "No events yet")
  );

  const action_favorite_log = action(() => {
    home.key("favorites").set([{ cell: log, tags: ["activitylog"] }]);
  });
  const action_log_events = action(() => {
    found.result?.logEvent.send({
      agent: "alice",
      action: "deployed",
      pieceName: "Notes",
      note: "first draft",
    });
  });
  const action_log_more = action(() => {
    found.result?.logEvent.send({
      agent: "bob",
      action: "populated",
      pieceRef: { mentioned: [], backlinks: [] },
    });
  });
  const assert_events_logged = assert(() =>
    log[NAME] === "Activity Log (2)" &&
    events.get().length === 2 &&
    events.get()[0].id !== events.get()[1].id &&
    !Number.isNaN(Date.parse(events.get()[0].timestamp)) &&
    mentioned.get().length === 1
  );
  const assert_summary_lists_events = assert(() =>
    log.summary.split("\n").length === 2 &&
    log.summary.split("\n")[0].endsWith(
      "alice: deployed Notes — first draft",
    ) &&
    log.summary.split("\n")[1].endsWith("bob: populated")
  );
  const assert_list_renders_events = assert(() => {
    const ui = readValue(log[UI]);
    return hasText(ui, "deployed") &&
      hasText(ui, "Notes") &&
      hasText(ui, "first draft") &&
      hasText(ui, "populated") &&
      propValue(findElement(ui, "cf-render"), "variant") === "chip" &&
      !hasText(ui, "No events yet");
  });

  const action_filter_bob = action(() => clickButton(log[UI], "bob"));
  const assert_only_bob = assert(() => {
    const ui = readValue(log[UI]);
    return hasText(ui, "populated") &&
      !hasText(ui, "deployed") &&
      propValue(findElementByExactText(ui, "cf-button", "bob"), "color") ===
        "primary" &&
      propValue(findElementByExactText(ui, "cf-button", "All"), "color") ===
        "neutral";
  });
  const action_show_all = action(() => clickButton(log[UI], "All"));
  const assert_everyone_again = assert(() => {
    const ui = readValue(log[UI]);
    return hasText(ui, "populated") &&
      hasText(ui, "deployed") &&
      propValue(findElementByExactText(ui, "cf-button", "All"), "color") ===
        "primary";
  });

  const action_clear = action(() => clickButton(log[UI], "Clear"));
  const assert_cleared = assert(() =>
    events.get().length === 0 &&
    log.summary === "No activity logged." &&
    hasText(log[UI], "No events yet")
  );

  return {
    [TESTS]: [
      { assertion: assert_starts_empty },
      { action: action_favorite_log },
      { action: action_log_events },
      { action: action_log_more },
      { assertion: assert_events_logged },
      { assertion: assert_summary_lists_events },
      { assertion: assert_list_renders_events },
      { action: action_filter_bob },
      { assertion: assert_only_bob },
      { action: action_show_all },
      { assertion: assert_everyone_again },
      { action: action_clear },
      { assertion: assert_cleared },
    ],
    log,
  };
});
