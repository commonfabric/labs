/**
 * A computed that reads through an array item that is a string reads the
 * string.
 *
 * `rows[0].length` captures `rows` whole, so the computed's input schema has
 * to describe each item as the string it is. A string has a numeric index and
 * `length`, and the transformer once took that for an array, typing `rows` as
 * `unknown[][]`: the string item was read against an array schema and the
 * computed saw `undefined`. A string member of an object item, optional or a
 * union of literals, is read the same way.
 *
 * Run: deno task cf test packages/patterns/regression/primitive-array-item-read.test.tsx
 */
import { assert, computed, pattern, TESTS } from "commonfabric";

export default pattern(() => {
  const rows = computed(() => ["ABCDEFGHIJ"]);
  const labels = computed((): { text?: string; size: "s" | "md" }[] => [
    { text: "Hello", size: "md" },
  ]);

  const rowLength = computed(() => rows[0].length);
  const firstLetter = computed(() => rows[0][0]);
  const textLength = computed(() => labels[0].text?.length);
  const sizeLength = computed(() => labels[0].size.length);

  return {
    [TESTS]: [
      { assertion: assert(() => rowLength === 10) },
      { assertion: assert(() => firstLetter === "A") },
      { assertion: assert(() => textLength === 5) },
      { assertion: assert(() => sizeLength === 2) },
    ],
  };
});
