import { computed, generateTextStream, isPending, pattern, patternTool, type PatternToolResult, resultOf, Writable } from "commonfabric";

const content = new Writable("Hello world");

type Output = {
  tool: PatternToolResult<{ content: string }>;
};

// FIXTURE: patternTool-local-var
// Verifies: patternTool's first arg is a pattern() (CT-1655); `content` is a
//   genuine pattern input supplied via extraParams, while the pattern-local
//   `genResult` (from generateTextStream) stays a local binding (not pulled into
//   extraParams).
//   patternTool(pattern(({ language, content }) => …genResult…), { content })
export default pattern<Record<string, never>, Output>(() => {
  const tool = patternTool(
    pattern(({ language, content }: { language: string; content: string }) => {
      const genResult = generateTextStream({
        system: computed(() => `Translate to ${language}.`),
        prompt: computed(() => content),
      });
      return computed(() => {
        if (isPending(genResult)) return undefined;
        return resultOf(genResult);
      });
    }),
    { content },
  );

  return { tool };
});
