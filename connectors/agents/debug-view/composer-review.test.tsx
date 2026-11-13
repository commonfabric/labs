import { action, assert, pattern, TESTS, UI } from "commonfabric";
import {
  findElementByText,
  findNode,
  propsOf,
  readValue,
  textContent,
} from "../../../patterns/tools/test-support/vnode-helpers.ts";
import {
  argumentMaxLength,
  composerField,
  DebugViewFixture,
  elementNamed,
  enterPrompt,
  PROMPT_TEXT,
  promptReviewGaps,
  reviewCommand,
  reviewOpen,
  reviewText,
  selectCommandTarget,
  setCommandType,
  setComposerSelect,
  setForce,
} from "./test/fixture.ts";

export default pattern(() => {
  const fixture = DebugViewFixture();
  const view = fixture.view;

  const action_select_command_target = action(() => {
    selectCommandTarget(view[UI]);
  });
  const action_enter_prompt = action(() => {
    enterPrompt(view[UI]);
  });
  const action_review_command = action(() => {
    reviewCommand(view[UI]);
  });
  const assert_command_target = assert(() => {
    const button = findElementByText(
      view[UI],
      "cf-button",
      "Command",
    );
    const form = elementNamed(view[UI], "cf-form");
    const source = elementNamed(form, "cf-select");
    const session = elementNamed(form, "cf-input");
    return readValue(propsOf(button)?.["aria-label"]) ===
        "Compose command for Debug session (codex)" &&
      readValue(propsOf(source)?.["$value"]) === "codex" &&
      readValue(propsOf(session)?.["$value"]) === "session-1";
  });
  const assert_empty_prompt_rejected = assert(() => {
    const alert = findNode(
      view[UI],
      (node) =>
        readValue(propsOf(node)?.role) === "alert" &&
        textContent(node).includes("Enter a prompt."),
    );
    return view.commandCount === 0 &&
      reviewOpen(view[UI]) === false &&
      alert !== undefined;
  });
  const assert_command_prepared = assert(() => {
    const form = elementNamed(view[UI], "cf-form");
    const textarea = elementNamed(form, "cf-textarea");
    return readValue(propsOf(textarea)?.["$value"]) === PROMPT_TEXT;
  });
  const assert_command_review = assert(() =>
    view.commandCount === 0 && promptReviewGaps(view[UI]) === ""
  );

  // A start drafts like a prompt and carries the force flag when asked.
  const action_prepare_forced_start = action(() => {
    setCommandType(view[UI], "start");
    setForce(view[UI], true);
  });
  const assert_forced_start_review = assert(() => {
    const review = reviewText(view[UI]);
    return review.includes('"type": "start"') &&
      review.includes(`"text": "${PROMPT_TEXT}"`) &&
      review.includes('"force": true');
  });
  const action_restore_prompt = action(() => {
    setCommandType(view[UI], "prompt");
    setForce(view[UI], false);
  });

  // Each command type shows the inputs it needs and no others.
  const action_choose_rename = action(() => {
    setCommandType(view[UI], "rename");
  });
  const assert_rename_inputs = assert(() =>
    argumentMaxLength(view[UI], "New title") === "512" &&
    composerField(view[UI], "Mode ID") === undefined &&
    composerField(view[UI], "Prompt") === undefined
  );
  const action_choose_set_mode = action(() => {
    setCommandType(view[UI], "set-mode");
  });
  const assert_set_mode_inputs = assert(() =>
    argumentMaxLength(view[UI], "Mode ID") === "128" &&
    composerField(view[UI], "New title") === undefined
  );
  const action_choose_set_config = action(() => {
    setCommandType(view[UI], "set-config-option");
  });
  const assert_string_config_inputs = assert(() =>
    composerField(view[UI], "Option key") !== undefined &&
    composerField(view[UI], "String value") !== undefined &&
    composerField(view[UI], "Mode ID") === undefined
  );
  const action_choose_boolean_config = action(() => {
    setComposerSelect(view[UI], "Value type", "true");
  });
  const assert_boolean_config_inputs = assert(() =>
    composerField(view[UI], "Option key") !== undefined &&
    composerField(view[UI], "String value") === undefined
  );

  return {
    [TESTS]: [
      { action: action_select_command_target },
      { assertion: assert_command_target },
      { action: action_review_command },
      { assertion: assert_empty_prompt_rejected },
      { action: action_enter_prompt },
      { assertion: assert_command_prepared },
      { action: action_review_command },
      { assertion: assert_command_review },
      { action: action_prepare_forced_start },
      { action: action_review_command },
      { assertion: assert_forced_start_review },
      { action: action_restore_prompt },
      { action: action_review_command },
      { assertion: assert_command_review },
      { action: action_choose_rename },
      { assertion: assert_rename_inputs },
      { action: action_choose_set_mode },
      { assertion: assert_set_mode_inputs },
      { action: action_choose_set_config },
      { assertion: assert_string_config_inputs },
      { action: action_choose_boolean_config },
      { assertion: assert_boolean_config_inputs },
    ],
    view,
  };
});
