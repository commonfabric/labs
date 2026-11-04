import { computed, pattern, UI, Writable } from "commonfabric";

interface Item {
  name: string;
  value: number;
}

// FIXTURE: ternary-hoisted-compute-plain-map-branch
// Verifies: once a ternary JSX branch is wholly compute-wrapped, compute-owned
// array maps inside that branch stay plain Array.map() calls.
//   showList ? (() => { const itemCount = count + " items"; return <div>{sorted.map(...)}</div>; })() : ...
//     → ifElse(showList, lift(() => { const itemCount = ...; return <div>{sorted.map(...)}</div>; })(...), ...)
// Context: the branch contains both a local compute-only alias and a map over
//   a computed array result, so the whole branch should be handled as compute-owned.
export default pattern<{ items: Item[] }>((state) => {
  const showList = new Writable(true);

  const sorted = computed(() =>
    [...state.items].sort((a, b) => a.value - b.value)
  );

  const count = computed(() => state.items.length);

  return {
    [UI]: (
      <div>
        {showList
          ? (() => {
            const itemCount = count + " items";
            return (
              <div>
                <span>{itemCount}</span>
                {sorted.map((item: Item) => (
                  <span>{item.name}</span>
                ))}
              </div>
            );
          })()
          : <span>Hidden</span>}
      </div>
    ),
  };
});
