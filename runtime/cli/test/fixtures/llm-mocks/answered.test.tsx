/**
 * A text request and a `generateObject` request, each answered by the entry
 * whose conditions it meets.
 */
import {
  assert,
  generateObject,
  generateText,
  pattern,
  resultOf,
  TESTS,
} from "commonfabric";

export const llmMocks = [
  { when: { systemContains: "names" }, object: { name: "Ada" } },
  { when: { lastMessageContains: "capital" }, text: "Paris." },
];

export default pattern(() => {
  const capital = generateText({ prompt: "What is the capital of France?" });
  const person = generateObject<{ name: string }>({
    system: "Extract names.",
    prompt: "Ada wrote the first program.",
    schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  });
  return {
    [TESTS]: [
      { assertion: assert(() => resultOf(capital) === "Paris.") },
      { assertion: assert(() => resultOf(person).name === "Ada") },
    ],
  };
});
