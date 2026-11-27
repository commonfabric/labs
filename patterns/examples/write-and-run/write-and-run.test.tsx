import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  hasText,
  sendMessage,
} from "../../tools/test-support/vnode-helpers.ts";
import WriteAndRun from "./main.tsx";

// The model writes a pattern that compiles for the first prompt, and code
// that does not for the second.
export const llmMocks = [
  {
    when: { lastMessageContains: "Create a simple counter" },
    text: [
      "```typescript",
      'import { NAME, pattern, UI } from "commonfabric";',
      "export default pattern(() => ({",
      '  [NAME]: "Generated counter",',
      "  [UI]: <div>Generated counter</div>,",
      "}));",
      "```",
    ].join("\n"),
  },
  {
    when: { lastMessageContains: "Create a todo list" },
    text: "export default pattern(() => {",
  },
];

const PROMPT = "Create a todo list";

// The first generation compiles and offers to open what it made; the second
// shows its compile error.
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
  const assert_ready_to_open = assert(() =>
    hasText(subject[UI], "Open Generated Pattern") &&
    !hasText(subject[UI], "Compile error") &&
    !hasText(subject[UI], "Enter a prompt to generate a pattern")
  );
  const assert_compile_error_shown = assert(() =>
    hasText(subject[UI], "Compile error") &&
    !hasText(subject[UI], "Open Generated Pattern")
  );

  return {
    [TESTS]: [
      { assertion: assert_named },
      { assertion: assert_reports_initial_prompt },
      { settle: true },
      { assertion: assert_ready_to_open },
      { press: subject[UI], control: "Open Generated Pattern" },
      { action: action_send_prompt },
      { assertion: assert_prompt_is_request },
      { action: action_send_blank_prompt },
      { assertion: assert_prompt_is_request },
      { settle: true },
      { assertion: assert_compile_error_shown },
    ],
    // Running the compiled pattern logs the runner's `resume-pre-sync`
    // warning, since the generated pattern takes no argument.
    allowConsoleWarnings: true,
    subject,
  };
});
