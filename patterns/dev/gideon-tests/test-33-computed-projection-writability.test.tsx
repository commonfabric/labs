/**
 * Test: a write through a `computed(() => source.auth)` projection updates
 * the source, just as a write through `source.auth` or to the source itself
 * does. The projection is not read-only.
 *
 * Each write sits behind a button, so the test clicks it the way a person
 * does and then reads the source and what each column of the view renders.
 *
 * Run: deno task cf test patterns/dev/gideon-tests/test-33-computed-projection-writability.test.tsx --root patterns --verbose
 */
import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  clickButton,
  hasText,
  innermostNode,
  textContent,
} from "../../tools/test-support/vnode-helpers.ts";
import ProjectionWritability from "./test-33-computed-projection-writability.tsx";

// The text of the innermost node carrying both `heading` and `detail`: one
// column of the view, or the raw state panel.
const panelText = (root: unknown, heading: string, detail: string): string =>
  textContent(
    innermostNode(
      root,
      (node) => hasText(node, heading) && hasText(node, detail),
    ),
  );

export default pattern(() => {
  const subject = ProjectionWritability({
    source: {
      auth: { token: "initial-token", expiresAt: 0, refreshCount: 0 },
      name: "Test Source",
    },
  });

  const action_update_via_computed = action(() => {
    clickButton(subject[UI], "Update via Computed");
  });
  const action_update_via_property = action(() => {
    clickButton(subject[UI], "Update via Property");
  });
  const action_update_direct = action(() => {
    clickButton(subject[UI], "Update Direct");
  });

  const assert_named = assert(() =>
    subject[NAME] === "Test #33: Computed Projection vs Property Access"
  );
  const assert_initial_source = assert(() =>
    subject.source.auth.token === "initial-token" &&
    subject.source.auth.refreshCount === 0 &&
    subject.source.name === "Test Source"
  );
  const assert_initial_view = assert(() =>
    hasText(
      panelText(subject[UI], "1. Computed Projection", "Token:"),
      "initial-tokenRefresh Count: 0",
    ) &&
    hasText(
      panelText(subject[UI], "2. Property Access", "Token:"),
      "initial-tokenRefresh Count: 0",
    )
  );

  // The write through the computed projection lands in the source.
  const assert_computed_write_reached_source = assert(() =>
    subject.source.auth.token.startsWith("updated-via-computed-") &&
    subject.source.auth.refreshCount === 1 &&
    subject.source.name === "Test Source"
  );
  // Every column shows the source's new token, so the projection and the
  // property name one cell.
  const assert_every_column_shows_computed_write = assert(() =>
    hasText(
      panelText(subject[UI], "1. Computed Projection", "Token:"),
      "updated-via-computed-",
    ) &&
    hasText(
      panelText(subject[UI], "2. Property Access", "Token:"),
      "updated-via-computed-",
    ) &&
    hasText(
      panelText(subject[UI], "3. Direct Source", "Token:"),
      "Refresh Count: 1",
    )
  );

  const assert_property_write_reached_source = assert(() =>
    subject.source.auth.token.startsWith("updated-via-property-") &&
    subject.source.auth.refreshCount === 2
  );
  const assert_computed_column_shows_property_write = assert(() =>
    hasText(
      panelText(subject[UI], "1. Computed Projection", "Token:"),
      "updated-via-property-",
    ) &&
    hasText(
      panelText(subject[UI], "1. Computed Projection", "Token:"),
      "Refresh Count: 2",
    )
  );

  const assert_direct_write_reached_source = assert(() =>
    subject.source.auth.token.startsWith("updated-direct-") &&
    subject.source.auth.refreshCount === 3 &&
    subject.source.name === "Test Source"
  );
  const assert_raw_state_shows_direct_write = assert(() =>
    hasText(
      panelText(subject[UI], "Raw Source State:", "auth"),
      "refreshCount: 3",
    ) &&
    hasText(
      panelText(subject[UI], "Raw Source State:", "auth"),
      'token: "updated-direct-',
    )
  );

  return {
    [TESTS]: [
      { assertion: assert_named },
      { assertion: assert_initial_source },
      { assertion: assert_initial_view },

      { action: action_update_via_computed },
      { assertion: assert_computed_write_reached_source },
      { assertion: assert_every_column_shows_computed_write },

      { action: action_update_via_property },
      { assertion: assert_property_write_reached_source },
      { assertion: assert_computed_column_shows_property_write },

      { action: action_update_direct },
      { assertion: assert_direct_write_reached_source },
      { assertion: assert_raw_state_shows_direct_write },
    ],
    subject,
  };
});
