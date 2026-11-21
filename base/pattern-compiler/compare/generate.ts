/**
 * Generates a scenario for a plan with no hand-written one: an argument
 * with a value of each type its schema declares, a confidentiality atom of
 * its own for each top-level input, and one event for each handler.
 */
import { linkedSchema } from "../exec/store.ts";
import type { LabeledInput, Plan } from "./harness.ts";

/** A JSON schema as the crate's `plan` command prints it. */
export type Schema = boolean | {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  anyOf?: Schema[];
  oneOf?: Schema[];
  enum?: unknown[];
  const?: unknown;
  $ref?: string;
  $defs?: Record<string, Schema>;
  asCell?: unknown;
  ifc?: { confidentiality?: unknown[]; integrity?: unknown[] };
  [key: string]: unknown;
};

/** The schemas of a plan, by the identifier a record names one with. */
export type Schemas = { id: string; schema?: Schema }[];

/** The marker of a value the generator has none for. */
const NONE = Symbol("no value");

// A value is generated to this depth, where an object and an array each
// count as one level. Below it an array is empty and a property that is
// not required is left out, which ends a type that refers to itself.
const DEPTH = 3;

const resolve = (schema: Schema, root: Schema): Schema => {
  let current = schema;
  for (let hops = 0; hops < 16; hops++) {
    if (typeof current !== "object" || current.$ref === undefined) break;
    const name = current.$ref.match(/^#\/\$defs\/(.+)$/)?.[1];
    const target = typeof root === "object" && name !== undefined
      ? root.$defs?.[name]
      : undefined;
    if (target === undefined) return true;
    current = target;
  }
  return current;
};

const isStream = (schema: Schema): boolean =>
  typeof schema === "object" && Array.isArray(schema.asCell) &&
  schema.asCell.includes("stream");

const isHandle = (schema: Schema): boolean =>
  typeof schema === "object" && schema.asCell !== undefined;

/**
 * A value of `schema`. `name` makes each string distinct, so that a value
 * the run stores can be told from another. With `handles` false the value
 * is for an event. An object then has no member that is declared as a
 * handle and is not required: a plain value sent in an event where a
 * handle is declared is read as a handle that cannot be written, and a
 * handler that sets it throws. And a number is 1, a boolean `false`, and
 * a value of an `enum` its last member, where an input holds 3, `true`,
 * and the first member: a handler that sets a cell to a value of its
 * event writes nothing where the cell holds that value already, and an
 * index of 1 is inside an array of an input, which has two elements.
 */
export const generateValue = (
  schema: Schema,
  root: Schema,
  name: string,
  depth = 0,
  handles = true,
): unknown => {
  const resolved = resolve(schema, root);
  if (resolved === false) return NONE;
  if (resolved === true) return `${name}-value`;
  if (isStream(resolved)) return NONE;
  if ("const" in resolved) return resolved.const;
  if (resolved.enum !== undefined) {
    return handles ? resolved.enum[0] : resolved.enum.at(-1);
  }
  const variants = resolved.anyOf ?? resolved.oneOf;
  if (variants !== undefined) {
    // The first variant that has a value other than `null`.
    for (const variant of variants) {
      const inner = resolve(variant, root);
      const type = typeof inner === "object" ? inner.type : undefined;
      if (type === "null" || type === "undefined") continue;
      const value = generateValue(variant, root, name, depth, handles);
      if (value !== NONE) return value;
    }
    return null;
  }
  // Of several types, the first that is not `null`.
  const type = Array.isArray(resolved.type)
    ? resolved.type.find((type) => type !== "null") ?? resolved.type[0]
    : resolved.type;
  switch (type) {
    case "string":
      return `${name}-text`;
    case "number":
    case "integer":
      return handles ? 3 : 1;
    case "boolean":
      return handles;
    case "null":
      return null;
    case "array": {
      if (depth >= DEPTH || resolved.items === undefined) return [];
      const items = [0, 1].map((index) =>
        generateValue(
          resolved.items!,
          root,
          `${name}-${index}`,
          depth + 1,
          handles,
        )
      );
      return items.includes(NONE) ? [] : items;
    }
    case "object":
    case undefined: {
      if (resolved.properties === undefined) {
        return type === "object" ? {} : `${name}-value`;
      }
      const value: Record<string, unknown> = {};
      for (const [key, property] of Object.entries(resolved.properties)) {
        const required = resolved.required?.includes(key) ?? false;
        if (depth >= DEPTH && !required) continue;
        if (!handles && !required && isHandle(resolve(property, root))) {
          continue;
        }
        const inner = generateValue(
          property,
          root,
          `${name}-${key}`,
          depth + 1,
          handles,
        );
        if (inner !== NONE) value[key] = inner;
      }
      return value;
    }
    default:
      return NONE;
  }
};

/** The confidentiality atom the generator gives the input `name`. */
export const inputAtom = (name: string): string => `input:${name}`;

/**
 * The confidentiality clause the generator gives the input `name`: its
 * atom, and with `audience`, the clause of the two alternatives. A handler
 * that reads an input and writes any store has the input's clause in the
 * join of its run, and the runtime refuses the write where the store's
 * ceiling does not admit the clause. A clause with the audience of the
 * scenario's space as an alternative is admitted by every store of the
 * space, and is still a clause no other input has.
 */
export const inputClause = (name: string, audience?: unknown): unknown =>
  audience === undefined
    ? inputAtom(name)
    : { anyOf: [inputAtom(name), audience] };

/**
 * The inputs of a generated scenario: for each property of the plan's
 * argument schema, a value and the schema the harness writes it under. The
 * schema is the property's own, with the labels it declares, and where
 * it declares no clause at its root, one clause there that no other input
 * has (`inputClause`). The harness writes the input under the runtime's
 * schema for the property where the compiled pattern has one
 * (`LabeledInput.declared`).
 */
export const generateInputs = (
  plan: Plan & { argumentSchema?: string },
  schemas: Schemas,
  audience?: unknown,
): Record<string, LabeledInput> => {
  const root = linkedSchema(
    schemas.find((entry) => entry.id === plan.argumentSchema)?.schema,
  );
  if (root === undefined) return {};
  const argument = resolve(root, root);
  if (typeof argument !== "object" || argument.properties === undefined) {
    return {};
  }
  const inputs: Record<string, LabeledInput> = {};
  for (const [name, property] of Object.entries(argument.properties)) {
    const value = generateValue(property, root, name);
    if (value === NONE) continue;
    const resolved = resolve(property, root);
    const own = typeof resolved === "object" ? { ...resolved } : {};
    // The cell holds the value. Whether the pattern takes the input as a
    // handle is the pattern's own declaration.
    delete own.asCell;
    // A type that declares clauses at its root gets no clause more: a
    // handler that writes the input declares the clauses of the type
    // there, and the runtime refuses a write that declares fewer clauses
    // than the store has ("confidentiality cannot be weakened").
    const clause = (own.ifc?.confidentiality ?? []).length > 0
      ? undefined
      : inputClause(name, audience);
    inputs[name] = {
      value,
      schema: {
        ...own,
        ...(typeof root === "object" && root.$defs !== undefined
          ? { $defs: root.$defs }
          : {}),
        ...(clause === undefined ? {} : {
          ifc: { ...own.ifc, confidentiality: [clause] },
        }),
      },
      declared: clause === undefined ? {} : { clause },
    };
  }
  return inputs;
};

/**
 * One event for the handler of `binding`: a value of the type its event
 * declares, and where the plan has no such type, an object with a value
 * at each path the body reads of its event, of the type the slot's schema
 * gives.
 */
export const generateEvent = (
  plan: Plan,
  schemas: Schemas,
  binding: number,
): unknown => {
  const body = plan.bindings?.[binding]?.handler?.body;
  // The whole declared type where the plan has it: the runtime reads an
  // event under the schema of the authored type (PL §3.12), and an event
  // without a required field it does not read is refused all the same.
  const declared = linkedSchema(
    schemas.find((entry) => entry.id === plan.bindings?.[binding]?.eventSchema)
      ?.schema,
  );
  if (declared !== undefined) {
    const value = generateValue(declared, declared, "event", 0, false);
    if (value !== NONE && value !== null && typeof value === "object") {
      return value;
    }
    // An event whose declared type is a primitive is that value.
    const type = typeof declared === "object" ? declared.type : undefined;
    if (type === "string" || type === "number" || type === "boolean") {
      return value;
    }
  }
  let event: unknown = {};
  for (const slot of plan.slots) {
    if (slot.root.kind !== "event" || slot.root.handler !== body) continue;
    if (slot.path.includes("*")) continue;
    const schema = linkedSchema(
      schemas.find((entry) => entry.id === slot.schema)?.schema,
    ) ??
      true;
    const value = generateValue(schema, schema, `event-${slot.path.join("-")}`);
    if (value === NONE) continue;
    if (slot.path.length === 0) {
      if (value !== null && typeof value === "object") event = value;
      continue;
    }
    let at = event as Record<string, unknown>;
    slot.path.forEach((key, index) => {
      if (index === slot.path.length - 1) {
        if (at[key] === undefined) at[key] = value;
        return;
      }
      if (at[key] === null || typeof at[key] !== "object") at[key] = {};
      at = at[key] as Record<string, unknown>;
    });
  }
  return event;
};
