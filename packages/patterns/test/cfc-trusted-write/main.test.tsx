import { assert, pattern, TESTS } from "commonfabric";
import PinnedNote, { PIN_ACTION, PIN_SURFACE } from "./main.tsx";
import OtherWriter from "./other-writer.tsx";

// Every write after the first pin is refused at commit, so the field keeps
// the pinned draft throughout. A refused handler logs its refusal, which is
// why console warnings are allowed.
export default pattern(() => {
  const note = PinnedNote({});
  const other = OtherWriter({ pinned: note.pinned });
  const trustedPin = { surface: PIN_SURFACE, action: PIN_ACTION };

  const assert_empty = assert(() => note.pinned === "");
  const assert_pinned = assert(() => note.pinned === "call the pharmacy");
  const assert_other_pattern_refused = assert(() =>
    note.pinned === "call the pharmacy"
  );
  const assert_unnamed_handler_refused = assert(() =>
    note.pinned === "call the pharmacy"
  );
  const assert_unnamed_handler_with_click_refused = assert(() =>
    note.pinned === "call the pharmacy"
  );

  return {
    [TESTS]: [
      { assertion: assert_empty },
      { action: note.pin, trustedUi: trustedPin },
      { assertion: assert_pinned },
      { action: other.overwrite },
      { assertion: assert_other_pattern_refused },
      { action: note.overwrite },
      { assertion: assert_unnamed_handler_refused },
      { action: note.repin, trustedUi: trustedPin },
      { assertion: assert_unnamed_handler_with_click_refused },
    ],
    subject: note,
    allowConsoleWarnings: true,
  };
});
