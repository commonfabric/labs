/// <cts-enable />
import { generateText, pattern, patternTool } from "commonfabric";

// The pattern a model calls as a tool: it finds the donuts of one flavor.
// `flavor` is what the model supplies, and `donuts` is bound where the tool
// is given. The `filter` is over an array of plain values in place.
const Search = pattern<{ flavor: string; donuts: string[] }>(
  ({ flavor, donuts }) => ({
    found: donuts.filter((donut) => donut === flavor),
  }),
);

// A `patternTool` given to a language-model built-in as a tool
// (`language-subset.md` §4.4.3). The crate compiles the call as the closure
// `pattern<{ flavor: string }>((rest) => Search({ ...rest, donuts }))`,
// which captures `donuts`. No per-element construct is in this pattern.
export default pattern<{ donuts: string[]; prompt: string }>(
  ({ donuts, prompt }) => {
    const reply = generateText({
      prompt,
      tools: { search: patternTool(Search, { donuts }) },
    });
    return { reply: reply.result, pending: reply.pending };
  },
);
