import { pattern, UI } from "commonfabric";

interface Tag {
  id: number;
  name: string;
}

interface Item {
  id: number;
  name: string;
  tags: Tag[];
}

interface State {
  items: Item[];
  prefix: string;
}

// FIXTURE: map-nested-callback
// Verifies: nested .map() calls on reactive arrays are each transformed independently
//   outer .map(fn) → .mapWithPattern(pattern(...), {state: {prefix}})
//   inner .map(fn) → .mapWithPattern(pattern(...), {item: {name}})
// Context: Inner map captures item.name from the outer map callback scope
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {/* Outer map captures state.prefix, inner map closes over item from outer callback */}
        {state.items.map((item) => (
          <div>
            {state.prefix}: {item.name}
            <ul>
              {item.tags.map((tag) => (
                <li>{item.name} - {tag.name}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    ),
  };
});
