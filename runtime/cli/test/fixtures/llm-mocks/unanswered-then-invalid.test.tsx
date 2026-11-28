/**
 * A request no entry answers, then a step the runner cannot run: the run
 * ends in an error, which names the unanswered request too.
 */
import { assert, generateText, pattern, TESTS } from "commonfabric";

export default pattern(() => {
  const capital = generateText({ prompt: "What is the capital of France?" });
  return {
    [TESTS]: [
      { assertion: assert(() => capital.pending === false) },
      // deno-lint-ignore no-explicit-any
      { notAValidStep: true } as any,
    ],
    allowConsoleWarnings: true,
  };
});
