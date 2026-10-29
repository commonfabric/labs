import { computed, pattern, patternTool, type PatternToolResult } from "commonfabric";

type Output = {
  tool: PatternToolResult<Record<string, never>>;
};

// FIXTURE: patternTool-no-captures
// Verifies: patternTool's first arg is a pattern() (CT-1655) with no extraParams.
//   patternTool(pattern(({ query, content }) => …))
// Context: The pattern callback only references its own parameters (query,
//   content) and no module-scoped reactive variables, so no extraParams.
export default pattern<Record<string, never>, Output>(() => {
  const tool = patternTool(pattern(({ query, content }: { query: string; content: string }) => {
    return computed(() => {
      return content.split("\n").filter((c: string) => c.includes(query));
    });
  }));

  return { tool };
});
