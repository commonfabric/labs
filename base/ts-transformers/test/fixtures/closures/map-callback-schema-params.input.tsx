import { pattern, UI } from "commonfabric";

interface Item {
  id: string;
  price: number;
}

interface State {
  items: Item[];
  discount: number;
}

// FIXTURE: map-callback-schema-params
// Verifies: mapWithPattern callback schemas omit params when captures are unused
// and include params when captures are used
//   state.items.map((item) => <span>{item.id}</span>) -> required: ["element"]
//   state.items.map((item) => <span>{item.price * state.discount}</span>)
//     -> required: ["element", "params"]
// Context: Both callbacks are pattern-owned JSX maps over the same receiver; only the second closes over outer state
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        <section data-kind="unused">
          {state.items.map((item) => <span>{item.id}</span>)}
        </section>
        <section data-kind="used">
          {state.items.map((item) => (
            <span>{item.price * state.discount}</span>
          ))}
        </section>
      </div>
    ),
  };
});
