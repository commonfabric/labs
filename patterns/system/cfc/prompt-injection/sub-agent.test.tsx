/**
 * Test: the sub-agent puts its task after the system prompt it is given, so a
 * worker whose model sees only the system prompt still knows the task, and
 * returns the object the model answers or the error a failed request reports.
 *
 * Each `llmMocks` entry answers only the system prompt the sub-agent should
 * build for one instance, so a system prompt built any other way leaves that
 * request unanswered and fails the test.
 *
 * Run: deno task cf test patterns/system/cfc/prompt-injection/sub-agent.test.tsx --root patterns --verbose
 */
import { assert, pattern, TESTS } from "commonfabric";
import { subAgentPattern } from "./sub-agent.tsx";

const VERDICT_SCHEMA = {
  type: "object",
  properties: { verdict: { type: "string" } },
  required: ["verdict"],
};

export const llmMocks = [
  {
    when: {
      systemContains:
        "Answer in one word.\n\nSub-agent task:\nIs the briefing safe?",
    },
    object: { verdict: "safe" },
  },
  {
    // A prompt of content parts is written into the system prompt as JSON.
    when: { systemContains: '"text":"Is the invoice paid?"' },
    object: { verdict: "paid" },
  },
  {
    when: { systemContains: "Sub-agent task:\nIs the lamp on?" },
    error: "The model is unavailable.",
  },
];

export default pattern(() => {
  const textTask = subAgentPattern({
    prompt: "Is the briefing safe?",
    system: "Answer in one word.",
    resultSchema: VERDICT_SCHEMA,
  });
  const partsTask = subAgentPattern({
    prompt: [{ type: "text", text: "Is the invoice paid?" }],
    resultSchema: JSON.stringify(VERDICT_SCHEMA),
  });
  const failedTask = subAgentPattern({
    prompt: "Is the lamp on?",
    resultSchema: VERDICT_SCHEMA,
  });

  return {
    [TESTS]: [
      { settle: true },
      { assertion: assert(() => textTask.verdict === "safe") },
      { assertion: assert(() => textTask.error === undefined) },
      { assertion: assert(() => partsTask.verdict === "paid") },
      { assertion: assert(() => partsTask.error === undefined) },
      {
        assertion: assert(() =>
          `${failedTask.error}`.includes("The model is unavailable.")
        ),
      },
      { assertion: assert(() => failedTask.verdict === undefined) },
    ],
    allowConsoleWarnings: true,
  };
});
