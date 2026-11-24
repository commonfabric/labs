/**
 * An integration fixture: two cell arrays, one of numbers and one of
 * objects, each exposed alongside a handler that pushes a single value
 * onto it.
 */

import {
  cell,
  computed,
  handler,
  JSONSchema,
  NAME,
  pattern,
  UI,
} from "commonfabric";

// dummy input schema
const InputSchema = {
  type: "object",
  properties: {},
} as const satisfies JSONSchema;

// define output schema
const OutputSchema = {
  type: "object",
  properties: {
    my_numbers_array: {
      type: "array",
      items: { type: "number" },
      default: [],
      asCell: ["cell"],
    },
    my_objects_array: {
      type: "array",
      items: { type: "object", properties: { count: { type: "number" } } },
      default: [],
      asCell: ["cell"],
    },
    pushNumbersHandler: { asCell: ["stream"], type: "object", properties: {} },
    pushObjectsHandler: { asCell: ["stream"], type: "object", properties: {} },
  },
  required: [
    "my_numbers_array",
    "my_objects_array",
    "pushNumbersHandler",
    "pushObjectsHandler",
  ],
} as const satisfies JSONSchema;

// Handlers moved to module scope
const pushNumbersHandler = handler(
  {
    type: "object",
    properties: { value: { type: "number" } },
    required: ["value"],
  },
  {
    type: "object",
    properties: {
      array: { type: "array", items: { type: "number" }, asCell: ["cell"] },
    },
    required: ["array"],
  },
  ({ value }, { array }) => {
    console.log("Pushing value:", value);
    array.push(value);
  },
);

const pushObjectsHandler = handler(
  {
    type: "object",
    properties: {
      value: { type: "object", properties: { count: { type: "number" } } },
    },
    required: ["value"],
  },
  {
    type: "object",
    properties: {
      array: {
        type: "array",
        items: { type: "object", properties: { count: { type: "number" } } },
        asCell: ["cell"],
      },
    },
    required: ["array"],
  },
  ({ value }, { array }) => {
    console.log("Pushing object:", { count: value.count });
    // Note: the runtime anchors pushed objects into documents of their own
    // automatically - no manual identity needed
    array.push({ count: value.count });
  },
);

export default pattern(
  () => {
    const my_numbers_array = cell<number[]>([]);
    const my_objects_array = cell<{ count: number }[]>([]);

    // Return the pattern
    return {
      [NAME]: "array push test",
      [UI]: (
        <div>
          <h3>Array Push Test</h3>
          <p>
            Array length: {computed(() => my_numbers_array.get().length)}
          </p>
          <p>
            <ul>
              Current values:{" "}
              {my_numbers_array.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          </p>
          <p>
            <ul>
              Current values:{" "}
              {my_objects_array.map((e, i) => <li key={i}>{e.count}</li>)}
            </ul>
          </p>
        </div>
      ),
      my_numbers_array,
      my_objects_array,
      pushNumbersHandler: pushNumbersHandler({ array: my_numbers_array }),
      pushObjectsHandler: pushObjectsHandler({ array: my_objects_array }),
    };
  },
  InputSchema,
  OutputSchema,
);
