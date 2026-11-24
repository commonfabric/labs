/**
 * Test Pattern: the folksonomy stress test
 *
 * Each scale button generates that many synthetic tag events over a fixed
 * number of scopes and tags, loads them into the aggregator, and reports what
 * it loaded; the aggregator's suggestions then feed the statistics panel.
 * Clear empties the aggregator and resets the report. The events are random,
 * so the statistics are checked against the bounds the scale sets rather than
 * exact counts.
 *
 * Run: deno task cf test patterns/dev/experimental/folksonomy-stress-test.test.tsx --root patterns
 */
import { action, assert, pattern, TESTS, UI } from "commonfabric";
import {
  childNodes,
  clickButton,
  hasText,
  textContent,
} from "../../tools/test-support/vnode-helpers.ts";
import FolksonomyStressTest from "./folksonomy-stress-test.tsx";

/** The metric tiles under `node`, value by label. A tile is a node whose two
 * children are its value and its label. */
const metrics = (
  node: unknown,
  found: Record<string, number> = {},
): Record<string, number> => {
  const children = childNodes(node);
  if (children.length === 2) {
    const text = textContent(children[0]).replace("ms", "").trim();
    const value = Number(text);
    if (text !== "" && !Number.isNaN(value)) {
      found[textContent(children[1]).trim()] = value;
    }
  }
  for (const child of children) metrics(child, found);
  return found;
};

export default pattern(() => {
  const subject = FolksonomyStressTest({});

  const action_load_100 = action(() => clickButton(subject[UI], "100"));
  const action_clear = action(() => clickButton(subject[UI], "Clear"));

  const assert_starts_ready = assert(() => {
    const shown = metrics(subject[UI]);
    return subject.loadedCount === 0 && shown["Scopes"] === 0 &&
      shown["Avg / scope"] === 0 &&
      hasText(subject[UI], "Ready - click a scale button to load events");
  });

  const assert_reports_the_load = assert(() =>
    subject.loadedCount === 100 && subject.genMs >= 0 &&
    subject.loadMs >= 0 &&
    hasText(subject[UI], "Loaded 100 events (10 scopes, 20 tags/scope)") &&
    metrics(subject[UI])["Events loaded"] === 100
  );
  // Every one of the ten scopes gets events; a scope holds at most the twenty
  // tags the scale uses.
  const assert_statistics_follow_the_load = assert(() => {
    const shown = metrics(subject[UI]);
    const total = shown["Total suggestions"];
    const max = shown["Max / scope"];
    const avg = shown["Avg / scope"];
    const unique = shown["Unique tags"];
    return shown["Scopes"] === 10 && max >= 1 && max <= 20 &&
      unique >= max && unique <= 20 && total >= max && total <= 200 &&
      avg >= 1 && avg <= max;
  });

  const assert_clear_resets = assert(() => {
    const shown = metrics(subject[UI]);
    return subject.loadedCount === 0 && subject.genMs === 0 &&
      subject.loadMs === 0 && shown["Scopes"] === 0 &&
      shown["Total suggestions"] === 0 && hasText(subject[UI], "Cleared") &&
      !hasText(subject[UI], "Loaded 100 events");
  });

  return {
    [TESTS]: [
      { assertion: assert_starts_ready },

      { action: action_load_100 },
      { assertion: assert_reports_the_load },
      { assertion: assert_statistics_follow_the_load },

      { action: action_clear },
      { assertion: assert_clear_resets },
    ],
  };
});
