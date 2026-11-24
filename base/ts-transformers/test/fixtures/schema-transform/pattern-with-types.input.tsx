import {
  Cell,
  Default,
  handler,
  NAME,
  pattern,
  toSchema,
  UI,
} from "commonfabric";
import "commonfabric/schema";

interface Item {
  text: Default<string, "">;
}

interface InputSchemaInterface {
  title: Default<string, "untitled">;
  items: Default<Item[], []>;
}

interface OutputSchemaInterface extends InputSchemaInterface {
  items_count: number;
}

type InputEventType = {
  detail: {
    message: string;
  };
};

const inputSchema = toSchema<InputSchemaInterface>();
const outputSchema = toSchema<OutputSchemaInterface>();

// Handler that logs the message event
const addItem = handler // <
//   { detail: { message: string } },
//   { items: Item[] }
// >
(
  (event: InputEventType, { items }: { items: Cell<Item[]> }) => {
    items.push({ text: event.detail.message });
  },
);

// FIXTURE: pattern-with-types
// Verifies: full pattern with toSchema, handler, JSX, and .map() all transform correctly together
//   toSchema<T>() → inline JSON schema literal with Default<> mapped to "default" values
//   handler() → injects event schema and context schema with asCell on Cell<> fields
//   items.map((item, index) => JSX) → items.mapWithPattern(pattern(...), {})
//   pattern<In, Out>() → uses pre-generated inputSchema/outputSchema passed as arguments
// Context: kitchen-sink pattern with NAME, UI, handler, array .map(), and Default<> types
export default pattern<InputSchemaInterface, OutputSchemaInterface>(({ title, items }) => {
  const items_count = items.length;

  return {
    [NAME]: title,
    [UI]: (
      <div>
        <h3>{title}</h3>
        <p>Basic pattern</p>
        <p>Items count: {items_count}</p>
        <ul>
          {items.map((item: Item, index: number) => (
            <li key={index}>{item.text}</li>
          ))}
        </ul>
        <cf-message-input
          name="Send"
          placeholder="Type a message..."
          appearance="rounded"
          oncf-send={addItem({ items })}
        />
      </div>
    ),
    title,
    items,
    items_count,
  };
}, inputSchema, outputSchema);
