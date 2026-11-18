/**
 * Multi-user: one entry answers one request, whichever participant makes it,
 * so when both participants ask the same thing, one of them is left
 * unanswered.
 */
import {
  assert,
  generateText,
  hasError,
  multiUserTest,
  pattern,
  resultOf,
  TESTS,
} from "commonfabric";

export const llmMocks = [
  { when: { lastMessageContains: "hello" }, text: "Hi." },
];

const asker = pattern(() => {
  const reply = generateText({ prompt: "hello" });
  return {
    [TESTS]: [{
      assertion: assert(() => hasError(reply) || resultOf(reply) === "Hi."),
    }],
    // The unanswered request's failure is logged as a warning.
    allowConsoleWarnings: true,
  };
});

export const alice = asker;
export const bob = asker;

export default multiUserTest({ participants: { alice, bob } });
