import { action, assert, pattern, TESTS, UI } from "commonfabric";
import {
  findElementByText,
  findNodeById,
  fireEvent,
  hasText,
} from "../../tools/test-support/vnode-helpers.ts";
import CheckboxDemo from "./cf-checkbox-cell.tsx";

// What the tracked checkbox reports when it is toggled.
const toggleTracked = (root: unknown, checked: boolean): void =>
  fireEvent(
    findElementByText(root, "cf-checkbox", "Enable Tracked Feature"),
    "oncf-change",
    { detail: { checked } },
    "the tracked checkbox",
  );

export default pattern(() => {
  const off = CheckboxDemo({ simpleEnabled: false, trackedEnabled: false });
  const on = CheckboxDemo({ simpleEnabled: true, trackedEnabled: false });

  const action_check_tracked = action(() => toggleTracked(off[UI], true));
  const action_uncheck_tracked = action(() => toggleTracked(off[UI], false));

  const assert_simple_status_follows_cell = assert(() =>
    hasText(findNodeById(off[UI], "feature-status"), "Feature is disabled") &&
    hasText(findNodeById(on[UI], "feature-status"), "Feature is enabled!")
  );
  const assert_tracked_starts_disabled = assert(() =>
    off.trackedEnabled.get() === false && hasText(off[UI], "Value: ⚠ Disabled")
  );
  const assert_tracked_enabled = assert(() =>
    off.trackedEnabled.get() === true && hasText(off[UI], "Value: ✓ Enabled")
  );
  const assert_tracked_disabled_again = assert(() =>
    off.trackedEnabled.get() === false && off.simpleEnabled.get() === false
  );

  return {
    [TESTS]: [
      { assertion: assert_simple_status_follows_cell },
      { assertion: assert_tracked_starts_disabled },
      { action: action_check_tracked },
      { assertion: assert_tracked_enabled },
      { action: action_uncheck_tracked },
      { assertion: assert_tracked_disabled_again },
    ],
    off,
    on,
  };
});
