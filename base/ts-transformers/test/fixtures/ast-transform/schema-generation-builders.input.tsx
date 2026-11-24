import { Cell, handler, pattern, UI } from "commonfabric";

type TodoState = {
  items: Cell<string[]>;
};

type TodoEvent = {
  add: string;
};

const addTodo = handler<TodoEvent, { items: Cell<string[]> }>((event, state) => {
  state.items.push(event.add);
});

// FIXTURE: schema-generation-builders
// Verifies: handler with generic type args generates event+state schemas; .map() becomes .mapWithPattern()
//   handler<TodoEvent, { items: Cell<string[]> }>(fn) → handler(eventSchema, stateSchema, fn)
//   state.items.map((item, index) => JSX)             → state.key("items").mapWithPattern(pattern(...), {})
//   pattern<TodoState>(fn)                            → pattern(fn, inputSchema, outputSchema)
export default pattern<TodoState>((state) => {
  return {
    [UI]: (
      <div>
        <button
          type="button"
          onClick={addTodo({ items: state.items })}
        >
          Add
        </button>
        <ul>
          {state.items.map((item, index) => <li key={index}>{item}</li>)}
        </ul>
      </div>
    ),
  };
});
