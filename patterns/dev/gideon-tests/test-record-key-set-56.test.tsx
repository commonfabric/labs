/**
 * Test: `.key(k).set(v)` on a `Record<string, T>` writes the entry whether
 * the key is new or existing, the record starts empty or populated, and the
 * key contains hyphens.
 *
 * Each case sits behind a button, so the test clicks it the way a person
 * does and then reads both the record and the line the view renders for it.
 *
 * Run: deno task cf test patterns/dev/gideon-tests/test-record-key-set-56.test.tsx --root patterns --verbose
 */
import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  clickButton,
  findNodeByText,
  hasText,
  innermostNode,
  textContent,
} from "../../tools/test-support/vnode-helpers.ts";
import RecordKeySet from "./test-record-key-set-56.tsx";

// The text of the innermost element whose text starts with `prefix`: one
// state line or one log line rather than a container holding several.
const lineWith = (root: unknown, prefix: string): string =>
  textContent(
    innermostNode(
      root,
      (node) =>
        typeof node === "object" && textContent(node).startsWith(prefix),
    ),
  );

export default pattern(() => {
  const subject = RecordKeySet({
    emptyRecord: {},
    populatedRecord: { existing: { value: "preset", count: 0 } },
    logs: [],
  });

  const action_simple_key_on_empty = action(() => {
    clickButton(subject[UI], "A: Simple key on empty");
  });
  const action_hyphen_key_on_empty = action(() => {
    clickButton(subject[UI], "B: Hyphen key on empty (the problematic case)");
  });
  const action_update_existing = action(() => {
    clickButton(subject[UI], "C: Update existing key");
  });
  const action_new_key_on_populated = action(() => {
    clickButton(subject[UI], "D: New hyphen key on populated");
  });
  const action_spread_on_empty = action(() => {
    clickButton(subject[UI], "E: Spread workaround on empty");
  });
  const action_clear_logs = action(() => {
    clickButton(subject[UI], "Clear");
  });

  const assert_named = assert(() =>
    subject[NAME] === "TEST: Record .key().set() #56"
  );
  const assert_starts_empty = assert(() =>
    Object.keys(subject.emptyRecord).length === 0 &&
    subject.logs.length === 0
  );
  const assert_view_shows_initial_state = assert(() =>
    lineWith(subject[UI], "emptyRecord: ") === "emptyRecord: {}" &&
    hasText(lineWith(subject[UI], "populatedRecord: "), "preset")
  );

  const assert_simple_key_on_empty = assert(() =>
    subject.emptyRecord.simplekey?.value === "test-a" &&
    subject.emptyRecord.simplekey?.count === 1
  );
  const assert_hyphen_key_on_empty = assert(() =>
    subject.emptyRecord["0-Technical_Expertise"]?.value === "test-b" &&
    subject.emptyRecord["0-Technical_Expertise"]?.count === 2
  );
  // A hyphen in the key is part of the key, not a path separator, so the
  // record gains exactly one entry under the whole key.
  const assert_hyphen_key_is_one_entry = assert(() =>
    Object.keys(subject.emptyRecord).sort().join(",") ===
      "0-Technical_Expertise,simplekey"
  );
  const assert_existing_updated = assert(() =>
    subject.populatedRecord.existing?.value === "updated" &&
    subject.populatedRecord.existing?.count === 99
  );
  const assert_new_key_on_populated = assert(() =>
    subject.populatedRecord["new-hyphen-key"]?.value === "test-d" &&
    Object.keys(subject.populatedRecord).length === 2
  );
  const assert_spread_kept_earlier_keys = assert(() =>
    subject.emptyRecord["spread-key"]?.value === "test-e" &&
    Object.keys(subject.emptyRecord).length === 3
  );

  // One entry per case, in the order the cases ran.
  const assert_every_case_logged_success = assert(() =>
    subject.logs.length === 5 &&
    subject.logs[0]?.startsWith("A: SUCCESS") &&
    subject.logs[1]?.startsWith("B: SUCCESS") &&
    subject.logs[2]?.startsWith("C: SUCCESS") &&
    subject.logs[3]?.startsWith("D: SUCCESS") &&
    subject.logs[4]?.startsWith("E: SUCCESS")
  );
  const assert_view_lists_logs = assert(() =>
    lineWith(subject[UI], "B: SUCCESS") ===
      'B: SUCCESS - .key("0-Technical_Expertise").set() wrote "test-b"' &&
    lineWith(subject[UI], "E: SUCCESS") ===
      'E: SUCCESS - spread workaround with key "spread-key"'
  );
  const assert_view_shows_written_state = assert(() =>
    hasText(lineWith(subject[UI], "emptyRecord: "), "test-b") &&
    hasText(lineWith(subject[UI], "populatedRecord: "), "test-d")
  );

  const assert_logs_cleared = assert(() =>
    subject.logs.length === 0 &&
    findNodeByText(subject[UI], "SUCCESS") === undefined
  );

  return {
    [TESTS]: [
      { assertion: assert_named },
      { assertion: assert_starts_empty },
      { assertion: assert_view_shows_initial_state },

      { action: action_simple_key_on_empty },
      { assertion: assert_simple_key_on_empty },
      { action: action_hyphen_key_on_empty },
      { assertion: assert_hyphen_key_on_empty },
      { assertion: assert_hyphen_key_is_one_entry },
      { action: action_update_existing },
      { assertion: assert_existing_updated },
      { action: action_new_key_on_populated },
      { assertion: assert_new_key_on_populated },
      { action: action_spread_on_empty },
      { assertion: assert_spread_kept_earlier_keys },

      { assertion: assert_every_case_logged_success },
      { assertion: assert_view_lists_logs },
      { assertion: assert_view_shows_written_state },

      { action: action_clear_logs },
      { assertion: assert_logs_cleared },
    ],
    subject,
  };
});
