import { action, assert, pattern, TESTS, UI } from "commonfabric";
import {
  clickButton,
  findElementByText,
  findNode,
  propsOf,
  readValue,
  textContent,
} from "../../../patterns/tools/test-support/vnode-helpers.ts";
import {
  DebugViewFixture,
  elementNamed,
  enterPrompt,
  promptReviewGaps,
  reviewCommand,
  reviewOpen,
  reviewText,
  sendCommand,
} from "./test/fixture.ts";

export default pattern(() => {
  const fixture = DebugViewFixture();
  const view = fixture.view;
  const commandAccepting = fixture.commandAccepting;

  const action_enter_prompt = action(() => {
    enterPrompt(view[UI]);
  });
  const action_review_command = action(() => {
    reviewCommand(view[UI]);
  });
  const action_send_command = action(() => {
    sendCommand(view[UI]);
  });
  const assert_command_review = assert(() =>
    view.commandCount === 0 && promptReviewGaps(view[UI]) === ""
  );

  // Cancelling the review closes the dialog and drops the reviewed command,
  // so a send that follows it appends nothing.
  const action_keep_editing = action(() => {
    clickButton(view[UI], "Keep editing");
  });
  const assert_review_cancelled = assert(() =>
    reviewOpen(view[UI]) === false &&
    !reviewText(view[UI]).includes('"type": "prompt"')
  );
  const assert_unreviewed_send_rejected = assert(() =>
    view.commandCount === 0 &&
    reviewText(view[UI]).includes("Review the command before sending it.")
  );

  // While the host stops admitting commands, the composer refuses both to
  // review and to send, and a send after it resumes goes through.
  const action_stop_command_admission = action(() => {
    commandAccepting.set(false);
  });
  const action_resume_command_admission = action(() => {
    commandAccepting.set(true);
  });
  const assert_command_send_disabled = assert(() => {
    const button = findElementByText(
      view[UI],
      "cf-button",
      "Send command",
    );
    return readValue(propsOf(button)?.disabled) === true;
  });
  const assert_stopped_review_rejected = assert(() => {
    const alert = findNode(
      elementNamed(view[UI], "cf-form"),
      (node) => readValue(propsOf(node)?.role) === "alert",
    );
    return view.commandCount === 0 &&
      textContent(alert).includes("The host is not accepting commands.");
  });
  const assert_stopped_command_rejected = assert(() =>
    view.commandCount === 0 &&
    reviewOpen(view[UI]) === true &&
    reviewText(view[UI]).includes("The host is not accepting commands.")
  );
  const assert_command_sent = assert(() => {
    const form = elementNamed(view[UI], "cf-form");
    const textarea = elementNamed(form, "cf-textarea");
    const statusMessage = findNode(
      view[UI],
      (node) =>
        readValue(propsOf(node)?.role) === "status" &&
        textContent(node).includes("Submitted debug:"),
    );
    return view.commandCount === 1 &&
      reviewOpen(view[UI]) === false &&
      readValue(propsOf(textarea)?.["$value"]) === "" &&
      statusMessage !== undefined;
  });

  return {
    [TESTS]: [
      { press: view[UI], control: "Command", within: "Debug session" },
      { action: action_enter_prompt },
      { action: action_review_command },
      { assertion: assert_command_review },
      { action: action_keep_editing },
      { assertion: assert_review_cancelled },
      { action: action_send_command },
      { assertion: assert_unreviewed_send_rejected },
      { action: action_review_command },
      { assertion: assert_command_review },
      { action: action_stop_command_admission },
      { assertion: assert_command_send_disabled },
      { action: action_review_command },
      { assertion: assert_stopped_review_rejected },
      { action: action_send_command },
      { assertion: assert_stopped_command_rejected },
      { action: action_resume_command_admission },
      { action: action_send_command },
      { assertion: assert_command_sent },
    ],
    view,
  };
});
