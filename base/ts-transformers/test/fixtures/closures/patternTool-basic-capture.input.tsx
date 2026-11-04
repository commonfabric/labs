import { cell, computed, pattern, patternTool, type PatternToolResult } from "commonfabric";

const content = cell("Hello world\nGoodbye world");

type Output = {
  grepTool: PatternToolResult<{ content: string }>;
};

// FIXTURE: patternTool-basic-capture
// Verifies: patternTool's first arg is a pattern() (CT-1655); `content` is a
//   genuine pattern input supplied via extraParams.
//   patternTool(pattern(({ query, content }) => …), { content })
// Context: `content` appears in the pattern callback's destructured input and is
//   pre-filled through extraParams.
export default pattern<Record<string, never>, Output>(() => {
  const grepTool = patternTool(pattern(({ query, content }: { query: string; content: string }) => {
    return computed(() => {
      return content.split("\n").filter((c: string) => c.includes(query));
    });
  }), { content });

  return { grepTool };
});
