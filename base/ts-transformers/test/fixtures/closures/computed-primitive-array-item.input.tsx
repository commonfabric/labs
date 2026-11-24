import { computed, pattern } from "commonfabric";

// FIXTURE: computed-primitive-array-item
// Verifies: an array item that is a primitive keeps its type when a computed
//   reads through it, for arrays whose type is inferred
//   words[0]?.length        → words: string[]   (not unknown[][])
//   words[0]?.[0]           → words: string[]   (not string[][])
//   labels[0]?.text?.length → text?: string | undefined (not unknown[])
//   labels[0]?.size.length  → size: "s" | "md"  (not unknown[])
// Context: a string has a numeric index and `length` through its apparent
//   type, and is still not an array. `grid[0]?.length` is the control: an item
//   that is an array shrinks to `unknown[]`.
export default pattern(() => {
  const words = computed(() => ["ABCDEFGHIJ"]);
  const labels = computed((): { text?: string; size: "s" | "md" }[] => [
    { text: "Hello", size: "md" },
  ]);
  const grid = computed(() => [[1, 2, 3]]);

  const firstLength = computed(() => words[0]?.length);
  const firstLetter = computed(() => words[0]?.[0]);
  const textLength = computed(() => labels[0]?.text?.length);
  const sizeLength = computed(() => labels[0]?.size.length);
  const rowLength = computed(() => grid[0]?.length);
  return { firstLength, firstLetter, textLength, sizeLength, rowLength };
});
