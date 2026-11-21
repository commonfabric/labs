/// <cts-enable />
import { pattern } from "commonfabric";

interface List {
  name: string;
  items: string[];
}

// A `filter` whose condition holds another `filter`: the fold of the outer
// membership has, in its body, the fold of the inner one, over `items` of
// each list, an array of plain values in place.
export default pattern<{ lists: List[] }>(({ lists }) => {
  const busy = lists.filter((list) =>
    list.items.filter((item) => item !== "").length > 0
  );
  return { busy };
});
