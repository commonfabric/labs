// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: packages/patterns/index.md
/**
 * A pattern handed another pattern's protected field, typed with the field's
 * label and nothing else.
 */
import { handler, pattern, Stream, Writable } from "commonfabric";
import { type OnlyMe } from "./main.tsx";

const overwrite = handler<void, { pinned: Writable<OnlyMe<string>> }>(
  (_, { pinned }) => {
    pinned.set("overwritten elsewhere");
  },
);

export default pattern<
  { pinned: Writable<OnlyMe<string>> },
  { overwrite: Stream<void> }
>(({ pinned }) => ({ overwrite: overwrite({ pinned }) }));
