import { pattern } from "commonfabric";

// FIXTURE: filter-flatmap-plain-captures
// Verifies: plain lexical captures in reactive filter/flatMap chains become
// params values, not reactive key(...) lookups
//   suffix/prefix literals -> __cf_pattern_input.params.{suffix,prefix}
//   items.filter(fn).flatMap(fn) -> filterWithPattern(...).flatMapWithPattern(...)
// Context: the captures are plain strings, so the lowered callbacks should not
// route them through key() ownership paths.
export default pattern<{ items: { label: string; tags: string[] }[] }>(
  ({ items }) => {
    const suffix = "!";
    const prefix = "#";

    return {
      labels: items
        .filter((item) => item.label.endsWith(suffix))
        .flatMap((item) => item.tags.length ? [prefix + item.tags[0]] : []),
    };
  },
);
