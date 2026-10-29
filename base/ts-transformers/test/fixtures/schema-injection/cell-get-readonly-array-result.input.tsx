import { type Default, pattern, type Writable } from "commonfabric";

// FIXTURE: cell-get-readonly-array-result
// Verifies: a pattern-scope `.get()` of an array cell lowers to a lift whose
// RESULT schema keeps the array's shape. The read types as `readonly T[]`,
// which the checker prints as a `readonly` type-operator node; the generator
// analyzes through it rather than falling back to `true`. For `unknown[]` —
// the reference-only declaration — that fallback turned "compare, don't read
// through" into a schema that walks everything reachable.

export default pattern<
  {
    mentioned: Writable<unknown[] | Default<[]>>;
    nums: Writable<number[] | Default<[]>>;
  },
  { hasMentioned: boolean; count: number }
>(({ mentioned, nums }) => {
  const mentionedView = mentioned.get();
  const hasMentioned = mentionedView.length > 0;
  const numsView = nums.get();
  const count = numsView.length;
  return { hasMentioned, count };
});
