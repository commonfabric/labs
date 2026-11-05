import { ifElse, pattern, UI, Writable } from "commonfabric";

interface Item {
  name: string;
}

// FIXTURE: authored-ifelse-jsx-branches
// Verifies: authored ifElse in JSX lowers both conditions and reactive branches correctly
//   ifElse(limit > 0, items.map(...), <span>Hidden</span>) → derived condition + pattern-lowered map branch
//   ifElse(show, count.get(), 0) in JSX                     → derived reactive branch, not raw count.get()
export default pattern<{
  items: Item[];
  limit: number;
  count: Writable<number>;
  show: boolean;
}>(({ items, limit, count, show }) => ({
  [UI]: (
    <div>
      {ifElse(
        limit > 0,
        items.map((item: Item) => <span>{item.name}</span>),
        <span>Hidden</span>,
      )}
      <p>{ifElse(show, count.get(), 0)}</p>
    </div>
  ),
}));
