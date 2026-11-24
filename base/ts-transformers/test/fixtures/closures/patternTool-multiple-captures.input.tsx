import { computed, pattern, patternTool, type PatternToolResult, Writable } from "commonfabric";

const multiplier = new Writable(2);
const prefix = new Writable("Result: ");

type Output = {
  tool: PatternToolResult<Record<string, never>>;
};

// FIXTURE: patternTool-multiple-captures
// Verifies: patternTool's first arg is an explicit pattern() (CT-1655) with no
//   explicit extraParams. The free module-scoped reactive captures `prefix` and
//   `multiplier` (read via .get()) are absorbed by the pattern into module-scope
//   lift closures rather than injected into extraParams — auto-capture-into-
//   extraParams was removed when patternTool began requiring an explicit pattern.
//   patternTool(pattern(({ value }) => …prefix.get()…multiplier.get()…))
// Context: Both `prefix` and `multiplier` are module-scoped new Writable() values;
//   `value` is the pattern's only per-call input.
export default pattern<Record<string, never>, Output>(() => {
  const tool = patternTool(pattern(({ value }: { value: number }) => {
    return computed(() => {
      return prefix.get() + String(value * multiplier.get());
    });
  }));

  return { tool };
});
