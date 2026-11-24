/** A request no entry answers: the runner fails the test for it. */
import { assert, generateText, pattern, TESTS } from "commonfabric";

export const llmMocks = [
  { when: { lastMessageContains: "weather" }, text: "Sunny." },
];

export default pattern(() => {
  const capital = generateText({ prompt: "What is the capital of France?" });
  return {
    [TESTS]: [
      {
        assertion: assert(() =>
          String(capital.error).includes("No llmMocks entry answers")
        ),
      },
    ],
    allowConsoleWarnings: true,
  };
});
