import {
  assert,
  generateObject,
  generateText,
  pattern,
  TESTS,
} from "commonfabric";

export default pattern(() => {
  const reply = generateText({ prompt: "Say hello" });
  const product = generateObject<{ name: string }>({
    prompt: "Name a plant pot",
    schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  });
  const unanswered = generateText({ prompt: "Say goodbye" });
  const answered = assert(() =>
    reply.result === "Hello there" && product.result?.name === "AquaPot"
  );
  const refused = assert(() =>
    unanswered.result === undefined && unanswered.error !== undefined
  );
  return {
    [TESTS]: [
      { settle: true },
      { assertion: answered },
      { assertion: refused },
    ],
    allowConsoleWarnings: true,
  };
});
