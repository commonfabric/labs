/// <cts-enable />
import { computed, pattern } from "commonfabric";

// Value code that passes on a plain container input, or what is in it:
// whole through a conditional, spread into a new array, a member, an
// element, and an element through a `map` over plain values in place.
export default pattern<
  { list: string[]; box: { a: string }; flag: boolean; other: string[] }
>(({ list, box, flag, other }) => ({
  chosenList: computed(() => (flag ? list : other)),
  chosenBox: computed(() => (flag ? box : { a: "none" })),
  spreadList: computed(() => [...list]),
  member: computed(() => box.a),
  element: computed(() => list[0]),
  mapped: computed(() => list.map((item) => item)),
  local: computed(() => {
    const held = box;
    return held;
  }),
}));
