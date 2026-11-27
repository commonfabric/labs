/**
 * Multi-user: a participant makes a request no entry answers, then parks on
 * a marker nobody announces, so the run ends in an error, which names the
 * unanswered request too.
 */
import {
  assert,
  generateText,
  multiUserTest,
  pattern,
  TESTS,
} from "commonfabric";

export const alice = pattern(() => {
  const reply = generateText({ prompt: "hello" });
  return {
    [TESTS]: [
      { assertion: assert(() => reply.pending === false) },
      { await: "never-announced" },
    ],
    // The unanswered request's failure is logged as a warning.
    allowConsoleWarnings: true,
  };
});

export default multiUserTest({ participants: { alice } });
