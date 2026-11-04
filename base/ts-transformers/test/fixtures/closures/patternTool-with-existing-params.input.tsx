import { cell, computed, pattern, patternTool, type PatternToolResult } from "commonfabric";

const multiplier = cell(2);
const offset = cell(10);

type Output = {
  tool: PatternToolResult<{ offset: number }>;
};

// FIXTURE: patternTool-with-existing-params
// Verifies: patternTool's first arg is an explicit pattern() (CT-1655). The
//   author supplies `offset` via extraParams (a genuine per-call input); the
//   free module-scoped capture `multiplier` (read via .get()) is absorbed by the
//   pattern into a module-scope lift closure rather than injected into
//   extraParams — auto-capture-into-extraParams was removed when patternTool
//   began requiring an explicit pattern.
//   patternTool(pattern(({ value, offset }) => …multiplier.get()…), { offset })
export default pattern<Record<string, never>, Output>(() => {
  const tool = patternTool(
    pattern(({ value, offset }: { value: number; offset: number }) => {
      return computed(() => {
        return value * multiplier.get() + offset;
      });
    }),
    { offset },
  );

  return { tool };
});
