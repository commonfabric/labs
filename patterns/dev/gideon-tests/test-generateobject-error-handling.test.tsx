/**
 * Test: the nested `ifElse` over `pending` and `error` shows the generated
 * object when `generateObject` answers, and the error when it fails.
 *
 * The model answers the default prompt and fails the other, as `llmMocks`
 * states, and the builtin warns as it reports the failure as `error`.
 *
 * Run: deno task cf test patterns/dev/gideon-tests/test-generateobject-error-handling.test.tsx --root patterns --verbose
 */
import {
  action,
  assert,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import { hasText } from "../../tools/test-support/vnode-helpers.ts";
import ErrorHandling from "./test-generateobject-error-handling.tsx";

export const llmMocks = [
  {
    when: { lastMessageContains: "a self-watering plant pot" },
    object: {
      name: "AquaPot",
      description: "A pot that waters the plant from a hidden reservoir.",
      price: 25,
    },
  },
  {
    when: { lastMessageContains: "a lamp that reads aloud" },
    error: "The model is unavailable.",
  },
];

export default pattern(() => {
  const userInput = Writable.of("a self-watering plant pot");
  const subject = ErrorHandling({ userInput });

  const action_ask_unanswered_prompt = action(() =>
    userInput.set("a lamp that reads aloud")
  );

  return {
    [TESTS]: [
      { settle: true },
      {
        assertion: assert(() =>
          subject[NAME] === "GenerateObject Error Handling Test"
        ),
      },
      { assertion: assert(() => hasText(subject[UI], "AquaPot")) },
      {
        assertion: assert(() =>
          hasText(subject[UI], "waters the plant from a hidden reservoir")
        ),
      },
      { assertion: assert(() => hasText(subject[UI], "Price: $25")) },
      { assertion: assert(() => hasText(subject[UI], "pending: false")) },
      { assertion: assert(() => hasText(subject[UI], "result: present")) },
      { assertion: assert(() => !hasText(subject[UI], "Error:")) },
      { assertion: assert(() => !hasText(subject[UI], "Generating...")) },

      { action: action_ask_unanswered_prompt },
      { settle: true },
      {
        assertion: assert(() =>
          subject.userInput === "a lamp that reads aloud"
        ),
      },
      {
        assertion: assert(() =>
          hasText(subject[UI], "Error: ") &&
          hasText(subject[UI], "The model is unavailable.")
        ),
      },
      { assertion: assert(() => hasText(subject[UI], "result: null")) },
      { assertion: assert(() => !hasText(subject[UI], "AquaPot")) },
    ],
    subject,
    allowConsoleWarnings: true,
  };
});
