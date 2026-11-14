/**
 * Test: a computed whose side effect is not idempotent changes state again
 * when it re-runs with the same input, and one whose side effect is
 * idempotent does not.
 *
 * Neither computed re-runs for its own writes, so a trigger runs each once.
 * "Re-run With Same Trigger" runs both again with the trigger unchanged: the
 * non-idempotent one appends a duplicate, and the idempotent one finds its key
 * already present and writes nothing. The recheck `cf test` makes of every
 * computation reports the non-idempotent one, which `expectNonIdempotent`
 * requires.
 *
 * Run: deno task cf test patterns/dev/gideon-tests/test-idempotent-side-effects.test.tsx --root patterns --verbose
 */
import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  clickButton,
  findNodeByText,
  hasText,
  innermostNode,
  textContent,
} from "../../tools/test-support/vnode-helpers.ts";
import IdempotentSideEffects from "./test-idempotent-side-effects.tsx";

// The text of the innermost node carrying both `heading` and `detail`: one
// column of the view.
const panelText = (root: unknown, heading: string, detail: string): string =>
  textContent(
    innermostNode(
      root,
      (node) => hasText(node, heading) && hasText(node, detail),
    ),
  );

export default pattern(() => {
  const subject = IdempotentSideEffects({ triggerCount: 0, rerunCount: 0 });

  const action_trigger = action(() => {
    clickButton(subject[UI], "Trigger Re-computation");
  });
  const action_rerun = action(() => {
    clickButton(subject[UI], "Re-run With Same Trigger");
  });

  const assert_named = assert(() =>
    subject[NAME] === "Test: Idempotent Side Effects"
  );
  const assert_initial_state = assert(() =>
    subject.triggerCount === 0 &&
    subject.nonIdempotentRunCount === 0 &&
    subject.nonIdempotentData.length === 0 &&
    Object.keys(subject.idempotentData).length === 0 &&
    subject.idempotentRunCount === 0
  );
  const assert_initial_view = assert(() =>
    hasText(subject[UI], "Trigger Count: 0") &&
    hasText(
      panelText(subject[UI], "Non-Idempotent", "Status:"),
      "Status: Click trigger to start",
    ) &&
    hasText(
      panelText(subject[UI], "✅ Idempotent", "Status:"),
      "Status: Click trigger to start",
    )
  );

  // A new trigger runs each computed once; neither runs again for what it
  // wrote, so there is nothing duplicated yet.
  const assert_trigger_ran_each_once = assert(() =>
    subject.triggerCount === 1 &&
    subject.nonIdempotentRunCount === 1 &&
    subject.nonIdempotentData.join(",") === "1" &&
    Object.keys(subject.idempotentData).join(",") === "trigger-1" &&
    subject.idempotentData["trigger-1"]?.trigger === 1 &&
    subject.idempotentRunCount === 1
  );
  const assert_trigger_view = assert(() =>
    hasText(subject[UI], "Trigger Count: 1") &&
    hasText(
      panelText(subject[UI], "Non-Idempotent", "Status:"),
      "Non-idempotent computed ran 1 times (re-run 0)Run Count: 1",
    ) &&
    hasText(
      panelText(subject[UI], "✅ Idempotent", "Status:"),
      'Idempotent computed holds key "trigger-1" (re-run 0)Unique Keys: 1',
    ) &&
    findNodeByText(subject[UI], "DUPLICATES") === undefined
  );

  // The re-run with the same trigger appends the trigger again, but leaves
  // the keyed map as it was.
  const assert_rerun_duplicated_append = assert(() =>
    subject.triggerCount === 1 &&
    subject.rerunCount === 1 &&
    subject.nonIdempotentRunCount === 2 &&
    subject.nonIdempotentData.join(",") === "1,1"
  );
  const assert_rerun_left_map_alone = assert(() =>
    Object.keys(subject.idempotentData).join(",") === "trigger-1" &&
    subject.idempotentRunCount === 1
  );
  const assert_rerun_view = assert(() =>
    hasText(
      panelText(subject[UI], "Non-Idempotent", "Status:"),
      "DUPLICATES: 2 entries for 1 triggers",
    ) &&
    hasText(
      panelText(subject[UI], "✅ Idempotent", "Status:"),
      'holds key "trigger-1" (re-run 1)Unique Keys: 1',
    )
  );

  const assert_second_trigger_added_one_each = assert(() =>
    subject.nonIdempotentData.join(",") === "1,1,2" &&
    Object.keys(subject.idempotentData).sort().join(",") ===
      "trigger-1,trigger-2" &&
    subject.idempotentData["trigger-2"]?.trigger === 2 &&
    subject.idempotentRunCount === 2
  );
  const assert_second_trigger_view = assert(() =>
    hasText(
      panelText(subject[UI], "Non-Idempotent", "Status:"),
      "DUPLICATES: 3 entries for 2 triggers",
    ) &&
    hasText(
      panelText(subject[UI], "✅ Idempotent", "Status:"),
      '"trigger-2": {\n    trigger: 2\n  }',
    )
  );

  return {
    [TESTS]: [
      { assertion: assert_named },
      { assertion: assert_initial_state },
      { assertion: assert_initial_view },

      { action: action_trigger },
      { assertion: assert_trigger_ran_each_once },
      { assertion: assert_trigger_view },

      { action: action_rerun },
      { assertion: assert_rerun_duplicated_append },
      { assertion: assert_rerun_left_map_alone },
      { assertion: assert_rerun_view },

      { action: action_trigger },
      { assertion: assert_second_trigger_added_one_each },
      { assertion: assert_second_trigger_view },
    ],
    subject,
    // The non-idempotent computed is what the pattern demonstrates, and this
    // fails the run unless the recheck reports it.
    expectNonIdempotent: true,
  };
});
