import {
  type CellKind,
  type FactoryInput,
  type JSONSchema,
  type JSONValue,
  type Reactive,
  type SchemaWithoutCell,
  type Stream,
} from "./types.ts";
import { getTopFrame } from "./pattern.ts";
import { encodableFormOf } from "../encodable-form.ts";
import { createCell, schemaCellScope } from "../cell.ts";
import { ContextualFlowControl } from "../cfc.ts";

/**
 * Implementation of reactive that creates actual Cells.
 * Uses getTopFrame() to access the runtime.
 * @param value - Optional schema default value
 * @param schema - Optional schema
 * @returns An Reactive
 */
function reactiveWithCell<T>(
  value?: FactoryInput<T> | T | undefined,
  schema?: JSONSchema,
  kind?: CellKind,
): Reactive<T> {
  const frame = getTopFrame();
  if (!frame || !frame.runtime) {
    throw new Error(
      "Cannot create reactive reference - no runtime context available\n" +
        "help: create cells inside pattern/handler/lift contexts, or use plain objects for module-level constants",
    );
  }

  if (value !== undefined) {
    schema = {
      ...ContextualFlowControl.toSchemaObj(schema),
      default: defaultForValue(value),
    };
  }

  // Create a Cell without a link - it will be created on demand via .for()
  // Use tx from frame if available
  const cell = createCell<T>(
    frame.runtime,
    {
      path: [],
      scope: schemaCellScope(schema),
      ...(schema !== undefined && { schema }),
      ...(frame.space && { space: frame.space }),
    },
    frame.tx,
    false,
    kind,
  );

  frame.reactives.add(cell);

  // Use the cell's built-in method to get a proxied Reactive
  return cell.getAsReactiveProxy();
}

// Legacy reactive for backward compatibility - creates proxies without Cell
// This is used during pattern construction before we have a runtime
export function reactive<S extends JSONSchema>(
  value: FactoryInput<SchemaWithoutCell<S>> | SchemaWithoutCell<S> | undefined,
  schema: S,
): Reactive<SchemaWithoutCell<S>>;
export function reactive<T>(
  value?: FactoryInput<T> | T | undefined,
  schema?: JSONSchema,
): Reactive<T>;

export function reactive<T>(
  value?: FactoryInput<T> | T | undefined,
  schema?: JSONSchema,
): Reactive<T> {
  return reactiveWithCell<T>(value, schema);
}

export function stream<T>(
  schema?: JSONSchema,
): Stream<T> {
  // The runtime creates a Stream cell, but reactiveWithCell is typed to return Reactive
  return reactiveWithCell<T>(undefined, schema, "stream") as unknown as Stream<
    T
  >;
}

function defaultForValue(value: unknown): JSONValue {
  // A builder artifact stands in as its encodable form: that is what a
  // default written from it has to be.
  return encodableFormOf(value) as JSONValue;
}
