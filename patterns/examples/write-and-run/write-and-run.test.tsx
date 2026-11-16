import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  hasText,
  sendMessage,
} from "../../tools/test-support/vnode-helpers.ts";
import WriteAndRun from "./write-and-run.tsx";

const PROMPT = "Create a todo list";

// A pattern test has no language model to answer `generateText`, so the
// generation ends without code and nothing reaches the compiler.
export default pattern(() => {
  const subject = WriteAndRun({ prompt: "Create a simple counter" });

  const action_send_prompt = action(() => {
    sendMessage(subject[UI], `  ${PROMPT}  `);
  });
  const action_send_blank_prompt = action(() => {
    sendMessage(subject[UI], "   ");
  });

  const assert_named = assert(() => subject[NAME] === "Write and Run");
  const assert_reports_initial_prompt = assert(() =>
    subject.prompt === "Create a simple counter"
  );
  const assert_prompt_is_request = assert(() => subject.prompt === PROMPT);
  const assert_no_code_view = assert(() =>
    hasText(subject[UI], "Enter a prompt to generate a pattern") &&
    !hasText(subject[UI], "Generated Code") &&
    !hasText(subject[UI], "Generated Pattern") &&
    !hasText(subject[UI], "Compile error")
  );

  return {
    // The failed generation logs a warning from the language-model client.
    allowConsoleWarnings: true,
    [TESTS]: [
      { assertion: assert_named },
      { assertion: assert_reports_initial_prompt },
      { settle: true },
      { assertion: assert_no_code_view },
      { action: action_send_prompt },
      { assertion: assert_prompt_is_request },
      { action: action_send_blank_prompt },
      { assertion: assert_prompt_is_request },
      { settle: true },
      { assertion: assert_no_code_view },
    ],
    subject,
  };
});
