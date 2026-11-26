import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  findElement,
  findElementByText,
  fireClick,
  fireEvent,
  hasText,
  propValue,
} from "../../tools/test-support/vnode-helpers.ts";
import Compiler from "./compiler.tsx";

const VALID = `import { NAME, pattern, UI } from "commonfabric";

export default pattern(() => ({ [NAME]: "Valid piece", [UI]: <b>valid</b> }));
`;
const BROKEN = "export default pattern(() => {";
const NAMED = `import { NAME, pattern, UI } from "commonfabric";

export default pattern(() => ({ [NAME]: "Edited piece", [UI]: <b>edited</b> }));
`;

export default pattern(() => {
  const subject = Compiler({ code: VALID });

  const action_break_code = action(() => {
    subject.updateCode.send({ code: BROKEN });
  });
  const action_edit_in_editor = action(() => {
    fireEvent(
      findElement(subject[UI], "cf-code-editor"),
      "oncf-change",
      { detail: { value: NAMED } },
      "the code editor",
    );
  });
  const action_visit = action(() => {
    fireClick(
      findElementByText(subject[UI], "cf-button", "Navigate To Piece"),
      "the navigate button",
    );
  });

  const assert_named = assert(() => subject[NAME] === "My First Compiler");
  const assert_default_compiles = assert(() =>
    findElementByText(subject[UI], "cf-button", "Navigate To Piece") !==
      undefined &&
    !hasText(subject[UI], "fix the error")
  );
  const assert_broken_code_stored = assert(() => subject.code === BROKEN);
  const assert_error_shown = assert(() =>
    hasText(subject[UI], "'}' expected.") &&
    findElementByText(subject[UI], "cf-button", "Navigate To Piece") ===
      undefined
  );
  const assert_editor_shows_code = assert(() =>
    propValue(findElement(subject[UI], "cf-code-editor"), "value") === BROKEN
  );
  const assert_edited_code_stored = assert(() => subject.code === NAMED);

  return {
    // compileAndRun starts the compiled program with no argument, and the
    // runner logs a warning for every start that has none to bind against.
    allowConsoleWarnings: true,
    [TESTS]: [
      { assertion: assert_named },
      { settle: true },
      { assertion: assert_default_compiles },
      { action: action_break_code },
      { settle: true },
      { assertion: assert_broken_code_stored },
      { assertion: assert_error_shown },
      { assertion: assert_editor_shows_code },
      { action: action_edit_in_editor },
      { settle: true },
      { assertion: assert_edited_code_stored },
      { assertion: assert_default_compiles },
      // The step's only effect is a navigation to the compiled piece, which
      // the runner records but exposes to no assertion.
      { action: action_visit },
    ],
    subject,
  };
});
