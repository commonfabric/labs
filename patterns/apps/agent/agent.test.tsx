/**
 * Test Pattern: Agent
 *
 * Drives every stream the agent exposes and every control its view binds, and
 * reads the view back after each step. The agent reports its runs to an
 * #activityLog it finds by wish; the test favorites a real activity log in the
 * home space partway through, so the first run is reported to nobody and the
 * later ones reach the log.
 */
import { action, assert, NAME, pattern, TESTS, UI, wish } from "commonfabric";
import type { Writable } from "commonfabric";
import ActivityLog from "../activity-log/activity-log.tsx";
import Agent from "./agent.tsx";
import {
  findElement,
  findNode,
  fireClick,
  fireEvent,
  hasText,
  innermostNode,
  isElement,
  propValue,
  styleOf,
  textContent,
} from "../../tools/test-support/vnode-helpers.ts";

interface HomeDefault {
  favorites: { cell: unknown; tags: string[] }[];
}

/** The innermost `cf-vstack` whose text carries `label`: one section. */
const section = (ui: unknown, label: string): unknown =>
  innermostNode(
    ui,
    (node) => isElement(node, "cf-vstack") && hasText(node, label),
  );

/** The innermost `div` that holds an element named `name`. */
const wrapperOf = (root: unknown, name: string): unknown =>
  innermostNode(
    root,
    (node) => isElement(node, "div") && findElement(node, name) !== undefined,
  );

/** The text of the status badge, when its background is `color`. */
const badgeColored = (ui: unknown, status: string, color: string): boolean =>
  findNode(
    ui,
    (node) =>
      textContent(node) === status &&
      String(styleOf(node, "backgroundColor")).includes(color),
  ) !== undefined;

/** The clickable node whose text carries `label`. */
const clickable = (ui: unknown, label: string): unknown =>
  findNode(
    ui,
    (node) => propValue(node, "onClick") !== undefined && hasText(node, label),
  );

/** The agent's name, which a click turns into an input. */
const nameToggle = (ui: unknown): unknown => clickable(ui, "🤖 Scout");

/** The input the name is edited in. */
const nameInput = (ui: unknown): unknown => findElement(ui, "cf-input");

/** The header that expands and collapses what the agent learned. */
const learnedToggle = (ui: unknown): unknown => clickable(ui, "Learned");

export default pattern(() => {
  const agent = Agent({ agentName: "Scout" });
  const log = ActivityLog({});
  const home = wish<Writable<HomeDefault>>({ query: "#default" }).result!;

  // ===== Initial state =====

  const assert_starts_idle = assert(() =>
    agent.status === "idle" && agent.enabled === true &&
    agent.isAgent === true && agent.learned === "" && agent.lastRun === ""
  );
  const assert_named = assert(() =>
    agent[NAME] === "🤖 Scout" && agent.summary === "Scout (no runs yet)"
  );
  const assert_view_shows_idle = assert(() =>
    hasText(agent[UI], "🤖 Scout") && hasText(agent[UI], "idle")
  );
  const assert_name_shown_not_edited = assert(() =>
    styleOf(nameToggle(agent[UI]), "display") === "flex" &&
    styleOf(wrapperOf(agent[UI], "cf-input"), "display") === "none"
  );
  const assert_status_badge_gray = assert(() =>
    badgeColored(agent[UI], "idle", "gray")
  );
  const assert_no_learned_or_last_run_sections = assert(() =>
    styleOf(section(agent[UI], "Learned"), "display") === "none" &&
    styleOf(section(agent[UI], "Last Run"), "display") === "none"
  );

  // ===== Directive and learned =====

  const action_set_directive = action(() => {
    agent.setDirective.send({ value: "Watch the inbox" });
  });
  const assert_directive_set = assert(() =>
    agent.directive === "Watch the inbox"
  );

  const action_set_learned = action(() => {
    agent.setLearned.send({ value: "first" });
  });
  const assert_learned_set = assert(() => agent.learned === "first");

  const action_append_learned = action(() => {
    agent.appendLearned.send({ entry: "second" });
  });
  const assert_appended_on_new_line = assert(() =>
    agent.learned === "first\nsecond"
  );

  const action_set_learned_line = action(() => {
    agent.setLearned.send({ value: "line\n" });
  });
  const assert_learned_ends_in_newline = assert(() =>
    agent.learned === "line\n"
  );
  const action_append_after_newline = action(() => {
    agent.appendLearned.send({ entry: "next" });
  });
  const assert_no_doubled_newline = assert(() =>
    agent.learned === "line\nnext"
  );

  const action_clear_learned = action(() => {
    agent.setLearned.send({ value: "" });
  });
  const assert_learned_cleared = assert(() => agent.learned === "");
  const action_append_only = action(() => {
    agent.appendLearned.send({ entry: "only" });
  });
  const assert_append_to_empty = assert(() => agent.learned === "only");

  const assert_learned_section_collapsed = assert(() =>
    styleOf(section(agent[UI], "Learned"), "display") === "flex" &&
    hasText(learnedToggle(agent[UI]), "▶ Learned")
  );

  const action_expand_learned = action(() => {
    fireClick(learnedToggle(agent[UI]), "the learned toggle");
  });
  const assert_learned_expanded = assert(() =>
    hasText(learnedToggle(agent[UI]), "▼ Learned") &&
    styleOf(
        wrapperOf(section(agent[UI], "Learned"), "cf-code-editor"),
        "display",
      ) ===
      "block"
  );

  // ===== Enabled =====

  const action_toggle_enabled = action(() => {
    agent.toggleEnabled.send();
  });
  const assert_disabled = assert(() => agent.enabled === false);
  const assert_enabled_again = assert(() => agent.enabled === true);

  // ===== Runs with no activity log =====

  const action_mark_running = action(() => {
    agent.markRunning.send();
  });
  const assert_running = assert(() =>
    agent.status === "running" && agent.summary === "Scout is running"
  );
  const assert_status_badge_blue = assert(() =>
    badgeColored(agent[UI], "running", "blue")
  );

  const action_mark_idle = action(() => {
    agent.markIdle.send({ summary: "Checked 3 messages" });
  });
  const assert_idle_with_summary = assert(() =>
    agent.status === "idle" && agent.lastRunSummary === "Checked 3 messages" &&
    agent.lastRun !== "" && agent.learned === "only" &&
    agent.summary === "Scout: Checked 3 messages"
  );
  const assert_last_run_shown = assert(() =>
    styleOf(section(agent[UI], "Last Run"), "display") === "block" &&
    hasText(section(agent[UI], "Last Run"), "Checked 3 messages") &&
    hasText(
      section(agent[UI], "Last Run"),
      new Date(agent.lastRun).toLocaleString(),
    )
  );
  const assert_log_empty = assert(() => log.summary === "No activity logged.");

  // ===== Runs reported to a favorited activity log =====

  const action_favorite_log = action(() => {
    home.key("favorites").set([{ cell: log, tags: ["activitylog"] }]);
  });

  const action_run_again = action(() => {
    agent.markRunning.send();
  });
  const action_finish = action(() => {
    agent.markIdle.send({ summary: "Filed 2 notes", learned: "inbox is busy" });
  });
  const assert_finished_with_learned = assert(() =>
    agent.status === "idle" && agent.lastRunSummary === "Filed 2 notes" &&
    agent.learned === "only\ninbox is busy"
  );
  const assert_log_has_run = assert(() =>
    log.summary.includes("Scout: started") &&
    log.summary.includes("Scout: completed — Filed 2 notes")
  );

  const action_mark_error = action(() => {
    agent.markError.send({ summary: "rate limited" });
  });
  const assert_errored = assert(() =>
    agent.status === "error" &&
    agent.lastRunSummary === "ERROR: rate limited" &&
    agent.summary === "Scout: ERROR: rate limited"
  );
  const assert_status_badge_red = assert(() =>
    badgeColored(agent[UI], "error", "red")
  );
  const assert_log_has_error = assert(() =>
    log.summary.includes("Scout: errored — rate limited")
  );

  // ===== Name editing =====

  const action_start_editing = action(() => {
    fireClick(nameToggle(agent[UI]), "the agent name");
  });
  const assert_editing = assert(() =>
    styleOf(nameToggle(agent[UI]), "display") === "none"
  );

  const action_type_other_key = action(() => {
    fireEvent(
      nameInput(agent[UI]),
      "oncf-keydown",
      { key: "a" },
      "the name input",
    );
  });
  const assert_still_editing = assert(() =>
    styleOf(nameToggle(agent[UI]), "display") === "none"
  );

  const action_press_enter = action(() => {
    fireEvent(
      nameInput(agent[UI]),
      "oncf-keydown",
      { key: "Enter" },
      "the name input",
    );
  });
  const assert_not_editing = assert(() =>
    styleOf(nameToggle(agent[UI]), "display") === "flex"
  );

  const action_blur_name = action(() => {
    fireEvent(nameInput(agent[UI]), "oncf-blur", {}, "the name input");
  });

  return {
    [TESTS]: [
      { assertion: assert_starts_idle },
      { assertion: assert_named },
      { assertion: assert_view_shows_idle },
      { assertion: assert_name_shown_not_edited },
      { assertion: assert_status_badge_gray },
      { assertion: assert_no_learned_or_last_run_sections },

      { action: action_set_directive },
      { assertion: assert_directive_set },
      { action: action_set_learned },
      { assertion: assert_learned_set },
      { action: action_append_learned },
      { assertion: assert_appended_on_new_line },
      { action: action_set_learned_line },
      { assertion: assert_learned_ends_in_newline },
      { action: action_append_after_newline },
      { assertion: assert_no_doubled_newline },
      { action: action_clear_learned },
      { assertion: assert_learned_cleared },
      { action: action_append_only },
      { assertion: assert_append_to_empty },
      { assertion: assert_learned_section_collapsed },
      { action: action_expand_learned },
      { assertion: assert_learned_expanded },

      { action: action_toggle_enabled },
      { assertion: assert_disabled },
      { action: action_toggle_enabled },
      { assertion: assert_enabled_again },

      { action: action_mark_running },
      { assertion: assert_running },
      { assertion: assert_status_badge_blue },
      { action: action_mark_idle },
      { assertion: assert_idle_with_summary },
      { assertion: assert_last_run_shown },
      { assertion: assert_log_empty },

      { action: action_favorite_log },
      { action: action_run_again },
      { assertion: assert_running },
      { action: action_finish },
      { assertion: assert_finished_with_learned },
      { assertion: assert_log_has_run },
      { action: action_mark_error },
      { assertion: assert_errored },
      { assertion: assert_status_badge_red },
      { assertion: assert_log_has_error },

      { action: action_start_editing },
      { assertion: assert_editing },
      { action: action_type_other_key },
      { assertion: assert_still_editing },
      { action: action_press_enter },
      { assertion: assert_not_editing },
      { action: action_start_editing },
      { assertion: assert_editing },
      { action: action_blur_name },
      { assertion: assert_not_editing },
    ],
    agent,
    log,
  };
});
